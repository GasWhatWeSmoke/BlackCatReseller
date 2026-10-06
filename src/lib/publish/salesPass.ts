import type { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "../types.ts";
import { claimBrowser, releaseBrowser } from "../browserCoordinator.ts";
import { recordConfirmedSale } from "./saleProtection.ts";
import { loadSalesCheckpoint, saveSalesCheckpoint, receiptsToRecheck } from "./salesCheckpoint.ts";
import { recordOrderReview } from "./orderReviews.ts";
import { type SalesMarketplace, type SalesReport, type SaleObservation } from "./salesProtocol.ts";
import { runSalesWorker } from "./salesWorker.ts";

interface Options {
  runWorker?: typeof runSalesWorker;
  shouldContinue?: () => Promise<boolean>;
  /** Explicit maintenance only; routine sale checks never reopen known orders. */
  recheckKnownReceipts?: boolean;
}

/** Apply only exact confirmed observations; unmatched historical sales remain
 * cached so later identity linking can replay the same evidence without guessing. */
export async function processSalesPass(db: Pick<PrismaClient, "$transaction">, settings: AppSettingsData, marketplace: SalesMarketplace, options: Options = {}) {
  if (!claimBrowser(`${marketplace} sales scan`)) return { state: "busy" as const };
  try {
    const checkpoint = loadSalesCheckpoint(settings.dataRoot);
    const cached = checkpoint.receipts.filter((receipt) => receipt.marketplace === marketplace);
    const confirmed: SaleObservation[] = [];
    let recorded = 0, unmatched = 0, review = 0;
    const apply = async (observations: SaleObservation[]) => {
      for (const observation of observations) {
        if (options.shouldContinue && !await options.shouldContinue()) return false;
        if (observation.classification !== "confirmed_sale") {
          if (observation.classification === "requires_review") review++;
          if (observation.classification === "not_sale" && cached.some(receipt => receipt.receiptId === observation.receiptId && receipt.observations.some(old => old.listingId === observation.listingId))) {
            if (await recordOrderReview(db, { observation })) review++;
          }
          continue;
        }
        const result = await recordConfirmedSale(db, { ...observation, classification: "confirmed_sale" });
        if (result.outcome === "recorded") recorded++;
        if (result.outcome === "unmatched") unmatched++;
        if (result.outcome === "requires_review") review++;
      }
      return true;
    };
    if (options.shouldContinue && !await options.shouldContinue()) return { state: "paused" as const };
    let report: SalesReport;
    const recheck = new Set(options.recheckKnownReceipts ? receiptsToRecheck(cached) : []);
    try { report = await (options.runWorker ?? runSalesWorker)(settings, marketplace, cached.filter(receipt => !recheck.has(receipt.receiptId)).map((receipt) => receipt.receiptId)); }
    catch (error) { return { state: "failed" as const, reason: error instanceof Error ? error.message : String(error), recorded }; }
    if (!report.ok) return { state: "failed" as const, reason: report.reason ?? "Sales scan failed.", recorded };
    if (!await apply(report.observations)) return { state: "paused" as const, recorded };
    // New observations come first. Recover cached evidence only for a linked,
    // unrecorded listing whose item has not shipped; historical/unlinked receipts
    // and already recorded sales need no repeated transactions or browser reads.
    if (cached.length) {
      const recoverable = new Set(await db.$transaction(async tx => (await tx.marketplaceListing.findMany({
        where: { marketplace, status: { not: "sold" }, externalListingId: { not: null }, item: { shippedAt: null } },
        select: { externalListingId: true },
      })).map(row => row.externalListingId)));
      const fresh = new Set(report.observations.map(row => row.receiptId));
      const recovery = cached.filter(receipt => !fresh.has(receipt.receiptId))
        .flatMap(receipt => receipt.observations).filter(row => recoverable.has(row.listingId));
      if (!await apply(recovery)) return { state: "paused" as const, recorded };
    }
    for (const receiptId of report.confirmedReceiptIds) {
      const observations = report.observations.filter((row) => row.receiptId === receiptId && row.classification === "confirmed_sale");
      if (!observations.length || observations.length !== report.observations.filter((row) => row.receiptId === receiptId).length) throw new Error("Unconfirmed receipt cannot be checkpointed.");
      confirmed.push(...observations);
      checkpoint.receipts = checkpoint.receipts.filter((receipt) => receipt.marketplace !== marketplace || receipt.receiptId !== receiptId);
      checkpoint.receipts.push({ marketplace, receiptId, observations, checkedAt: new Date().toISOString() });
    }
    const observed = new Set(report.observations.map(row => row.receiptId));
    // A complete discovery can no longer contain an older receipt. Advance its
    // next-check time too, so ten old missing IDs cannot starve the rotation.
    for (const receipt of checkpoint.receipts) if (receipt.marketplace === marketplace &&
      (observed.has(receipt.receiptId) || (report.complete && recheck.has(receipt.receiptId)))) receipt.checkedAt = new Date().toISOString();
    if (confirmed.length || observed.size || (report.complete && recheck.size)) saveSalesCheckpoint(settings.dataRoot, checkpoint);
    return { state: report.complete && review === 0 ? "checked" as const : "partial" as const,
      complete: report.complete, recorded, unmatched, review, confirmedReceipts: report.confirmedReceiptIds.length,
      ...(report.reason ? { reason: report.reason } : {}) };
  } finally { releaseBrowser(); }
}
