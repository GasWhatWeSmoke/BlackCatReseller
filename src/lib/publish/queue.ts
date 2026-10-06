// The durable publishing queue (§45.7, §45.8, §45.9, §45.20).
//
// The queue IS the PublishJob table — this module is just the engine that
// drains it. An app/server/computer restart loses nothing: in-flight
// "publishing" rows are reconciled on the next engine start, and the engine is
// kicked whenever the publish UI polls status, so an interrupted run resumes
// as soon as the app is opened again.
//
// Execution is deliberately serial with per-marketplace pacing: one listing at
// a time, a breather between listings (§45.20 — reliability over raw speed).
// One failed item NEVER stops the run (§45.9): its job records the failure and
// classification, and the loop moves on.

import { Prisma } from "@prisma/client";
import { currentUploadPhase } from "./liveProgress.ts";
import { retryFailedJobs } from "./recovery.ts";
import { statusRun } from "./statusRun.ts";
import { prisma } from "../db.ts";
import { getSettings } from "../settings.ts";
import { buildCanonicalListing } from "./canonical.ts";
import { applyRelistPrice } from "./relistPricing.ts";
import { classifyError, backoffMs } from "./errors.ts";
import { getAdapter } from "./adapters/registry.ts";
import { createQueuedRun, type CreateRunResult } from "./createQueuedRun.ts";
import { publishEngineState } from "./engineState.ts";
import { browserHolder } from "../browserCoordinator.ts";
import { PublishError, type ValidationIssue } from "./types.ts";
import { beginPublishAttempt, completePublishAttempt, publishBlockReason,
  recordUnsubmittedAttempt, recoverPublishAttempts } from "./attempts.ts";

const DEFAULT_PACING_SECONDS = 8;
const DEFAULT_MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One engine per server process. `kickEngine` is safe to call any time.
const engine = publishEngineState();

export function engineActive(): boolean {
  return engine.running;
}

export async function kickEngine(): Promise<void> {
  if(process.env.BLACKCAT_PREVIEW==='1')return;
  if (engine.running) return;
  engine.running = true;
  runLoop()
    .catch((e) => console.error(`[publish] engine crashed: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => { engine.running = false; });
}

/** A browser may have posted before its result was saved. Only proven
 *  unsubmitted attempts can be re-queued without marketplace verification. */
async function recoverInterrupted(): Promise<void> {
  if (engine.recovered) return;
  const count = await recoverPublishAttempts(prisma);
  engine.recovered = true;
  if (count) console.warn(`[publish] reconciled ${count} job(s) interrupted mid-publish`);
}

// Pacing + circuit-breaker state (in-memory is fine: both are politeness/safety
// heuristics, not correctness — a restart simply starts them fresh).
const { lastPublishAt, consecutiveFailures } = engine;

async function runLoop(): Promise<void> {
  await recoverInterrupted();
  for (;;) {
    const settings = await getSettings();
    const pacingMs = (settings.publish?.pacingSeconds ?? DEFAULT_PACING_SECONDS) * 1000;
    const now = new Date();

    const candidates = await prisma.publishJob.findMany({
      where: {
        run: { status: "running" },
        OR: [
          { status: "queued" },
          { status: "retrying", nextAttemptAt: { lte: now } },
        ],
      },
      orderBy: { id: "asc" },
      take: 25,
    });

    if (!candidates.length) {
      await closeFinishedRuns();
      // Anything still retrying with a future nextAttemptAt? Wait for the soonest.
      const nextRetry = await prisma.publishJob.findFirst({
        where: { run: { status: "running" }, status: "retrying" },
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
      });
      if (!nextRetry?.nextAttemptAt) return; // queue drained — engine parks
      await sleep(Math.min(Math.max(nextRetry.nextAttemptAt.getTime() - Date.now(), 1000), 30_000));
      continue;
    }

    // ITEM AT A TIME (operator decision 2026-08-24): jobs are created item-major
    // (item 1 x every marketplace, then item 2...), and the engine takes them
    // STRICTLY in that order — it waits out pacing rather than skipping ahead to
    // a later item, so an item is fully cross-posted before the next one starts.
    const next = candidates[0];
    const waitMs = pacingMs - (Date.now() - (lastPublishAt.get(next.marketplace) ?? 0));
    if (waitMs > 0) await sleep(Math.min(waitMs, 15_000));

    // Sale checks and Legacy can own the shared browser for several minutes.
    // Waiting is not a failed publishing attempt and must not exhaust retries.
    if (browserHolder()) { await sleep(1000); continue; }
    lastPublishAt.set(next.marketplace, Date.now());
    await executeJob(next.id);
    await closeFinishedRuns();
  }
}

async function closeFinishedRuns(): Promise<void> {
  const open = await prisma.publishRun.findMany({ where: { status: "running" }, select: { id: true } });
  for (const run of open) {
    const pending = await prisma.publishJob.count({
      where: { runId: run.id, status: { in: ["queued", "publishing", "retrying"] } },
    });
    if (pending === 0) {
      await prisma.publishRun.update({ where: { id: run.id }, data: { status: "done", finishedAt: new Date() } });
    }
  }
}

function issuesText(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.field}: ${i.message}`).join("; ");
}

async function executeJob(jobId: number): Promise<void> {
  const job = await prisma.publishJob.findUnique({ where: { id: jobId } });
  if (!job || !["queued", "retrying"].includes(job.status)) return;
  const settings = await getSettings();
  const maxAttempts = settings.publish?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempt = job.attemptCount + 1;

  await prisma.publishJob.update({
    where: { id: job.id },
    data: { status: "publishing", attemptCount: attempt, startedAt: job.startedAt ?? new Date() },
  });

  const item = await prisma.item.findUnique({
    where: { id: job.itemId },
    include: { photos: { orderBy: { sortOrder: "asc" } } },
  });
  const logLine = (outcome: string, detail = "") =>
    console.log(`[publish] ${item?.sku ?? `item#${job.itemId}`} -> ${job.marketplace} attempt ${attempt}: ${outcome}${detail ? ` — ${detail}` : ""}`);

  const park = async (status: "failed" | "requires_review", errorClass: string, message: string, validation?: ValidationIssue[]) => {
    await prisma.publishJob.update({
      where: { id: job.id },
      data: {
        status, errorClass, lastError: message.slice(0, 2000),
        validationJson: validation ? JSON.stringify(validation) : undefined,
        finishedAt: new Date(),
      },
    });
    logLine(status, message);
    await breaker(job.runId, settings.publishAbortAfterConsecutiveFailures);
  };

  let attemptReserved = false;
  try {
    if (!item) { await park("failed", "fatal", "item no longer exists"); return; }

    const adapter = getAdapter(job.marketplace);
    if (!adapter) { await park("failed", "fatal", `unknown marketplace "${job.marketplace}"`); return; }
    const avail = adapter.availability(settings);
    if (!avail.configured) { await park("requires_review", "requires_review", `${adapter.name} is not configured: ${avail.reason}`); return; }

    // Duplicate guard at EXECUTION time too (§45.19): a listing may have been
    // published for this item since the run was created.
    const existing = await prisma.marketplaceListing.findUnique({
      where: { itemId_marketplace: { itemId: item.id, marketplace: job.marketplace } },
    });
    const blocked = publishBlockReason(existing);
    if (blocked) {
      await park("requires_review", "requires_review", `${adapter.name}: ${blocked}`);
      return;
    }

    // Pre-publish validation (§45.10): shared gate, then adapter-specific.
    const canonical = buildCanonicalListing(item, settings);
    if (!canonical.listing) { await park("requires_review", "requires_review", issuesText(canonical.issues), canonical.issues); return; }
    const listing = applyRelistPrice(canonical.listing, existing, settings.publish?.relistPricing);
    const adapterIssues = adapter.validate(listing, settings);
    if (adapterIssues.length) { await park("requires_review", "requires_review", issuesText(adapterIssues), adapterIssues); return; }

    const reservationError = await beginPublishAttempt(prisma, job.id);
    if (reservationError) { await park("requires_review", "requires_review", reservationError); return; }
    attemptReserved = true;
    const result = await adapter.publish(listing, settings);

    // Success: the durable listing record is the source of truth (§45.18).
    await completePublishAttempt(prisma, job.id, result, listing);
    consecutiveFailures.set(job.runId, 0);
    logLine("published", `listing ${result.externalListingId}`);
  } catch (e) {
    const { message, errorClass } = classifyError(e);
    if (attemptReserved) {
      if (e instanceof PublishError && e.notSubmitted) {
        await recordUnsubmittedAttempt(prisma, job.id, message);
      } else {
        // A lost worker/result or a database error after Post is ambiguous even
        // when its wording looks like a retryable network error.
        await park("requires_review", "requires_review",
          `${message} — the listing may be live. Verify it on the marketplace before retrying.`);
        return;
      }
    }
    await prisma.marketplaceListing.updateMany({
      where: { itemId: job.itemId, marketplace: job.marketplace },
      data: { lastAttemptAt: new Date(), lastError: message.slice(0, 2000) },
    });
    if (errorClass === "retryable" && attempt < maxAttempts) {
      await prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: "retrying", errorClass, lastError: message.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempt)),
        },
      });
      logLine("retrying", `${message} (attempt ${attempt}/${maxAttempts}, backoff ${Math.round(backoffMs(attempt) / 1000)}s)`);
      await breaker(job.runId, settings.publishAbortAfterConsecutiveFailures);
    } else {
      await park(errorClass === "requires_review" ? "requires_review" : "failed", errorClass,
        errorClass === "retryable" ? `${message} (gave up after ${attempt} attempts)` : message);
    }
  }
}

/** Circuit breaker (§37.2, reused): N consecutive failures with no success in
 *  between means the WORLD is broken (dead marketplace, dead auth), not the
 *  items — pause the run instead of burning through hundreds of jobs. */
async function breaker(runId: number, threshold: number): Promise<void> {
  if (!threshold || threshold <= 0) return;
  const n = (consecutiveFailures.get(runId) ?? 0) + 1;
  consecutiveFailures.set(runId, n);
  if (n < threshold) return;
  await prisma.publishRun.updateMany({
    where: { id: runId, status: "running" },
    data: { status: "paused", note: `auto-paused: ${n} consecutive failures — check the marketplace connection, then Resume` },
  });
  console.warn(`[publish] run ${runId} auto-paused after ${n} consecutive failures`);
  consecutiveFailures.set(runId, 0);
}

// ---------------------------------------------------------------------------
// Run creation (§45.7) + controls (§45.16) — called by the API routes.
// ---------------------------------------------------------------------------

export async function createRun(itemIds: number[], marketplaces: string[]): Promise<CreateRunResult> {
  const settings = await getSettings();
  const targets = [...new Set(marketplaces)].filter(marketplace => {
    const adapter = getAdapter(marketplace);
    return adapter && adapter.availability(settings).configured;
  });
  if (!targets.length) return { ok: false, error: "No selected marketplace is configured for publishing." };
  try {
    const result = await createQueuedRun(prisma, itemIds, targets);
    if (result.ok) void kickEngine();
    return result;
  } catch (error) {
    console.error("[publish] could not create batch", error instanceof Error ? error.message : String(error));
    return { ok: false, error: "Could not save the upload batch. Refresh Run activity before trying again." };
  }
}

export async function controlRun(runId: number, action: "pause" | "resume" | "cancel"): Promise<{ ok: boolean; error?: string }> {
  const run = await prisma.publishRun.findUnique({ where: { id: runId } });
  if (!run) return { ok: false, error: "run not found" };
  if (action === "pause") {
    await prisma.publishRun.updateMany({ where: { id: runId, status: "running" }, data: { status: "paused" } });
  } else if (action === "resume") {
    await prisma.publishRun.updateMany({ where: { id: runId, status: "paused" }, data: { status: "running", note: null } });
    void kickEngine();
  } else {
    await prisma.publishRun.update({ where: { id: runId }, data: { status: "cancelled", finishedAt: new Date() } });
    await prisma.publishJob.updateMany({
      where: { runId, status: { in: ["queued", "retrying"] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  }
  return { ok: true };
}

/** Retry failed / requires_review jobs (§45.16) — optionally a specific set. */
export async function retryJobs(runId:number,jobIds?:number[]) {
  const result=await retryFailedJobs(prisma,runId,jobIds);
  if(result.ok && result.retried)void kickEngine();
  return result;
}

/** Live status for the UI (§45.15) — totals per marketplace + current item. */
export async function runStatus(runId?: number) {
  const run = await statusRun(prisma, runId);
  if (!run) return { run: null };
  const jobs = await prisma.publishJob.findMany({
    where: { runId: run.id },
    include: { item: { select: { sku: true, brand: true, itemType: true,
      marketplaceListings: { select: { marketplace: true, status: true } } } } },
    orderBy: { id: "asc" },
  });
  const byMarketplace: Record<string, Record<string, number>> = {};
  for (const j of jobs) {
    const m = (byMarketplace[j.marketplace] ??= {});
    m[j.status] = (m[j.status] ?? 0) + 1;
  }
  const current = jobs.find((j) => j.status === "publishing") ?? null;
  const pending = jobs.filter((j) => ["queued", "retrying", "publishing"].includes(j.status)).length;
  // A restart parks the engine; seeing pending work while idle restarts it.
  if (pending > 0 && run.status === "running" && !engineActive()) void kickEngine();
  return {
    run: {
      id: run.id, status: run.status, note: run.note, totalJobs: run.totalJobs,
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      marketplaces: JSON.parse(run.marketplacesJson) as string[],
    },
    byMarketplace,
    jobs: jobs.map(j => ({ jobId: j.id, itemId: j.itemId, sku: j.item.sku, marketplace: j.marketplace, status: j.status })),
    current: current
      ? { jobId: current.id, sku: current.item.sku, brand: current.item.brand, itemType: current.item.itemType, marketplace: current.marketplace, attempt: current.attemptCount,
          startedAt: current.startedAt, phase: currentUploadPhase(current.marketplace, current.item.sku) }
      : null,
    problems: jobs
      .filter((j) => ["failed", "requires_review"].includes(j.status) && !j.item.marketplaceListings.some(row=>row.marketplace===j.marketplace && ["published","sold"].includes(row.status)))
      .map((j) => ({
        jobId: j.id, sku: j.item.sku, marketplace: j.marketplace, status: j.status,
        error: j.lastError, validation: j.validationJson ? JSON.parse(j.validationJson) : null,
        needsVerification: j.item.marketplaceListings.some((l) => l.marketplace === j.marketplace && l.status === "unknown"),
      })),
    published: jobs
      .filter((j) => j.status === "published")
      .map((j) => ({ jobId: j.id, sku: j.item.sku, marketplace: j.marketplace, url: j.externalUrl })),
  };
}
