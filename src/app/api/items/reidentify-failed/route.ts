import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import {
  ManagedVisionCancelledError,
  ManagedVisionCancelRequestError,
  ManagedVisionDeferredError,
  runReenrichBatch,
  workerPythonExists,
} from "@/lib/worker";
import {
  applyReidentification,
  prepareReidentifyItem,
  resolveHealedAiProblems,
  type PreparedReidentifyItem,
  REIDENTIFY_CANDIDATE_WHERE,
} from "@/lib/reidentify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retry every currently failed item in one Python process and one ResidentSession.
// Nothing is applied to Prisma until that process has exited and restored residency.
export async function POST(req: Request) {
  const settings = await getSettings();
  if (!settings.visionEnabled) {
    return NextResponse.json({ error: "AI vision is disabled in Settings" }, { status: 422 });
  }
  if (!workerPythonExists(settings)) {
    return NextResponse.json({ error: "worker venv missing" }, { status: 409 });
  }

  const failedWhere = { aiError: { not: null } } satisfies Prisma.ItemWhereInput;
  // Permanently invalid/no-photo failures stay visible for manual repair, but
  // cannot occupy every page and starve later items that managed vision can use.
  const eligibleWhere = {
    ...REIDENTIFY_CANDIDATE_WHERE,
    ...failedWhere,
    photos: {
      some: { isMarker: false, includeInListing: true, storedPath: { not: "" } },
    },
  } satisfies Prisma.ItemWhereInput;
  const [totalFailed, totalEligible, failed] = await Promise.all([
    prisma.item.count({ where: failedWhere }),
    prisma.item.count({ where: eligibleWhere }),
    prisma.item.findMany({
      where: eligibleWhere,
      orderBy: { id: "asc" },
      take: 500,
      select: { id: true, sku: true },
    }),
  ]);
  if (!failed.length) {
    if (totalFailed) {
      return NextResponse.json({
        ok: false,
        error: "NO_RETRYABLE_AI_ITEMS",
        message: "AI retries require unpublished, unsold items with listing photos and no active or uncertain publishing work. Review protected items manually.",
        manualRepairRequired: totalFailed,
        remainingEligible: 0,
      }, { status: 422 });
    }
    const resolved = await resolveHealedAiProblems();
    return NextResponse.json({
      ok: true,
      retried: 0,
      recovered: 0,
      resolvedProblems: resolved,
      message: "No items are waiting on AI - nothing to retry.",
    });
  }
  const remainingEligible = Math.max(0, totalEligible - failed.length);
  const manualRepairRequired = Math.max(0, totalFailed - totalEligible);

  let recovered = 0;
  const stillFailing: { sku: string; error: string }[] = [];
  const prepared: { sku: string; value: PreparedReidentifyItem }[] = [];
  for (const item of failed) {
    const candidate = await prepareReidentifyItem(item.id);
    if (candidate.ok) prepared.push({ sku: item.sku, value: candidate.prepared });
    else stillFailing.push({ sku: item.sku, error: candidate.error });
  }

  try {
    if (prepared.length) {
      const enrichments = await runReenrichBatch(
        settings,
        prepared.map(({ value }) => ({
          requestId: String(value.item.id),
          sku: value.item.sku,
          photos: value.photos,
        })),
        { signal: req.signal },
      );
      // Final cooperative boundary: after the first apply starts, finish every
      // row deterministically rather than turning a disconnect into half a batch.
      if (req.signal.aborted) throw new ManagedVisionCancelledError();
      for (const [index, completed] of enrichments.entries()) {
        const candidate = prepared[index];
        const result = await applyReidentification(candidate.value, completed.enrichment);
        if (result.ok) recovered += 1;
        else stillFailing.push({ sku: candidate.sku, error: result.error });
      }
    }
  } catch (error) {
    if (error instanceof ManagedVisionDeferredError) {
      return NextResponse.json({
        ok: false,
        error: "VISION_DEFERRED",
        retryable: true,
        ...error.deferral,
      }, { status: 503, headers: { "Retry-After": "30" } });
    }
    if (error instanceof ManagedVisionCancelledError) {
      return NextResponse.json({ ok: false, error: "VISION_CANCELLED" }, { status: 409 });
    }
    if (error instanceof ManagedVisionCancelRequestError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 500 });
    }
    return NextResponse.json({ ok: false, error: "bulk re-identification failed" }, { status: 500 });
  }

  const resolvedProblems = await resolveHealedAiProblems();
  console.log(`[reidentify-failed] recovered ${recovered}/${failed.length}`);
  return NextResponse.json({
    ok: stillFailing.length === 0 && remainingEligible === 0,
    retried: failed.length,
    recovered,
    stillFailing,
    resolvedProblems,
    remainingEligible,
    // Compatibility for callers shipped during the first bounded-pagination pass.
    remainingQueued: remainingEligible,
    manualRepairRequired,
  });
}
