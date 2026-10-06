import type { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "../types.ts";
import { claimBrowser, releaseBrowser } from "../browserCoordinator.ts";
import { beginDelistAttempt, finishDelistAttempt, recoverDelistAttempts, CHROME_SESSION_UNAVAILABLE } from "./saleProtection.ts";
import { REMOVAL_MARKETPLACES, runDelistWorker, supportsBrowserRemoval } from "./delistWorker.ts";

type Store = Pick<PrismaClient, "$transaction" | "marketplaceListing">;
interface Options {
  limit?: number;
  now?: Date;
  runWorker?: typeof runDelistWorker;
  recoverInterrupted?: boolean;
  shouldContinue?: () => Promise<boolean>;
}

/** One bounded pass. Unknown attempts wait at least a minute before inspection
 * and retry; failed/unsupported targets stay visible for review. The monitor
 * calls this again on a later tick instead of spinning on the same listing. */
export async function processRemovalQueue(db: Store, settings: AppSettingsData, options: Options = {}) {
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Invalid removal batch limit.");
  if (!claimBrowser("sale protection: remove sold listings")) return { busy: true, processed: [] };
  const processed: { listingId: number; outcome: string; saved: boolean }[] = [];
  try {
    if (options.shouldContinue && !await options.shouldContinue()) return { busy: false, processed, paused: true };
    if (options.recoverInterrupted) await recoverDelistAttempts(db);
    const cutoff = new Date((options.now ?? new Date()).getTime() - 60_000);
    const candidates = await db.marketplaceListing.findMany({ where: {
      item: { status: "Sold" }, marketplace: { in: [...REMOVAL_MARKETPLACES] },
      OR: [{ status: "delist_pending" }, { status: "delist_unknown", OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: cutoff } }] }],
    }, select: { id: true, marketplace: true }, orderBy: [{ lastAttemptAt: "asc" }, { id: "asc" }], take: limit });
    for (const candidate of candidates) {
      if (options.shouldContinue && !await options.shouldContinue()) break;
      if (!supportsBrowserRemoval(candidate.marketplace)) continue;
      const attempt = await beginDelistAttempt(db, candidate.id);
      if (!attempt) continue;
      let result;
      try { result = await (options.runWorker ?? runDelistWorker)(settings, attempt); }
      catch (error) {
        result = { outcome: "unknown" as const, verified: false,
          reason: error instanceof Error ? error.message : String(error) };
      }
      // These failures happened before submission and can recover after page
      // hydration or Chrome approval. Keep availability unverified so the next
      // bounded attempt inspects the exact listing before doing anything else.
      // Identity, authorization and sign-in failures still require review.
      if (result.outcome === "failed" && "submissionStarted" in result && result.submissionStarted === false &&
          (result.reason === CHROME_SESSION_UNAVAILABLE ||
            /^(?:TimeoutError:|RuntimeError: (?:Native Chrome connection did not complete|The Chrome crawler is busy with another item))/.test(result.reason ?? ""))) {
        result = { ...result, outcome: "unknown" as const };
      }
      const saved = await finishDelistAttempt(db, { ...attempt, outcome: result.outcome,
        verified: result.verified, message: result.reason });
      processed.push({ listingId: attempt.listingId, outcome: result.outcome, saved });
    }
    return { busy: false, processed };
  } finally { releaseBrowser(); }
}
