// Single-item protection: a verified sale ends the source and queues removal
// everywhere else. Existing listing rows hold the durable removal state; no
// quantity model or schema migration is involved.
import type { Prisma, PrismaClient } from "@prisma/client";
import { listingIdentity } from "./attempts.ts";
import { normalizeSaleFinancials, type SaleFinancials } from "./saleFinancials.ts";
import { isBrowserMarketplace, MARKETPLACE_NAMES, type BrowserMarketplace } from "./platforms.ts";
import { ORDER_REVIEW_FIELD, orderReviewData } from "./orderReviews.ts";

type Store = Pick<PrismaClient, "$transaction">;
/** Shared by browser receipts and explicit manual sales, inside their transaction. */
export async function queueSoldItemRemovals(tx: Prisma.TransactionClient, itemId: number, sourceId: number | null, marketplaceName: string, now: Date) {
  const other = await tx.marketplaceListing.findMany({ where: { itemId, ...(sourceId === null ? {} : { id: { not: sourceId } }) } });
  const pending: number[] = [], unresolved: number[] = [];
  for (const listing of other) {
    if (["ended", "sold", "not_published"].includes(listing.status)) continue;
    if (["delist_pending", "delisting", "delist_unknown", "delist_failed"].includes(listing.status)) {
      pending.push(listing.id);
      continue;
    }
    const target = listingIdentity(listing.marketplace, listing.externalUrl ?? "");
    if (!target || target.id !== listing.externalListingId) {
      unresolved.push(listing.id);
      await tx.marketplaceListing.update({ where: { id: listing.id }, data: {
        lastError: "This item sold. Verify this listing's identity before removing it.",
      } });
      continue;
    }
    pending.push(listing.id);
    await tx.marketplaceListing.update({ where: { id: listing.id }, data: {
      status: "delist_pending", attemptCount: 0, lastAttemptAt: null, lastError: null,
    } });
  }
  await tx.publishJob.updateMany({ where: { itemId, status: { in: ["queued", "retrying"] } }, data: {
    status: "cancelled", lastError: `Item sold on ${marketplaceName}.`, nextAttemptAt: null, finishedAt: now,
  } });
  return { pending, unresolved };
}
export interface ConfirmedSaleObservation {
  marketplace: BrowserMarketplace;
  listingId: string;
  listingUrl: string;
  reference: string;
  classification: "confirmed_sale";
  financials?: SaleFinancials;
}

export async function recordConfirmedSale(db: Store, observation: ConfirmedSaleObservation) {
  const identity = listingIdentity(observation.marketplace, observation.listingUrl);
  if (observation.classification !== "confirmed_sale" || !isBrowserMarketplace(observation.marketplace) ||
      !identity || identity.id !== observation.listingId || typeof observation.reference !== "string" ||
      !observation.reference.trim() || observation.reference.length > 200) {
    throw new Error("A verified sale and matching marketplace listing identity are required.");
  }
  return db.$transaction(async (tx) => {
    const matches = await tx.marketplaceListing.findMany({ where: {
      marketplace: observation.marketplace, externalListingId: observation.listingId,
    }, include: { item: true }, take: 2 });
    if (matches.length !== 1) return { outcome: "unmatched" as const, pending: [], unresolved: [] };
    const source = matches[0];
    const returns = await tx.syncLog.findMany({ where: { itemId: source.itemId, field: ORDER_REVIEW_FIELD, action: "returned" }, select: { newValue: true } });
    if (returns.some(row => orderReviewData(row.newValue)?.retiredListings?.some(old => old.marketplace === observation.marketplace && old.listingId === observation.listingId))) {
      return { outcome: "already_recorded" as const, itemId: source.itemId, pending: [], unresolved: [] };
    }
    const alreadyRecorded = source.status === "sold";
    // An explicit manual status change after a recorded sale is an exception
    // owned by the operator; repeated observations must not undo it.
    if (alreadyRecorded && source.item.status !== "Sold") return { outcome: "already_recorded" as const, itemId: source.itemId, pending: [], unresolved: [] };
    if (!["published", "sold", "ended", "unknown", "delist_pending", "delisting", "delist_unknown", "delist_failed"].includes(source.status)) {
      return { outcome: "requires_review" as const, itemId: source.itemId, pending: [], unresolved: [] };
    }
    const marketplaceName = MARKETPLACE_NAMES[observation.marketplace];
    const sameMarketplace = source.item.platformSold?.trim().toLowerCase() === marketplaceName.toLowerCase();
    const doubleSale = !alreadyRecorded && source.item.status === "Sold" && !!source.item.platformSold && !sameMarketplace;
    const now = new Date();
    const financials = normalizeSaleFinancials(observation.financials);
    // Fill missing actuals only for the first sale's platform. Receipt replays
    // and a second platform sale must preserve operator corrections and costs.
    const sameSale = !doubleSale && (!source.item.platformSold || source.item.status !== "Sold" || sameMarketplace);
    const actuals = sameSale && financials ? {
      ...(source.item.salePrice == null ? { salePrice: financials.salePriceCents / 100 } : {}),
      ...(source.item.shippingCharged == null && financials.shippingChargedCents !== undefined
        ? { shippingCharged: financials.shippingChargedCents / 100 } : {}),
      ...(source.item.dateSold == null && financials.soldAt ? { dateSold: new Date(financials.soldAt) } : {}),
      earningsReady: true,
    } : {};
    if (alreadyRecorded && Object.keys(actuals).length) await tx.item.update({ where: { id: source.itemId }, data: actuals });
    if (!alreadyRecorded) {
      await tx.item.update({ where: { id: source.itemId }, data: {
        status: "Sold", platformSold: source.item.platformSold && source.item.status === "Sold" ? source.item.platformSold : marketplaceName,
        ...actuals,
      } });
      await tx.marketplaceListing.update({ where: { id: source.id }, data: { status: "sold", endedAt: now, lastError: null } });
    }
    const { pending, unresolved } = await queueSoldItemRemovals(tx, source.itemId, source.id, marketplaceName, now);
    if (!alreadyRecorded && (doubleSale || unresolved.length)) await tx.problemLog.create({ data: {
      type: doubleSale ? "DIRECT_DOUBLE_SALE" : "DIRECT_DELIST_IDENTITY_MISSING", sku: source.item.sku,
      message: doubleSale
        ? `Another confirmed sale on ${marketplaceName} (${observation.reference}); the item was already sold on ${source.item.platformSold}. Review fulfillment manually.`
        : `Sale on ${marketplaceName} (${observation.reference}); ${unresolved.length} other listing(s) need identity verification before removal.`,
    } });
    return { outcome: alreadyRecorded ? "already_recorded" as const : "recorded" as const, itemId: source.itemId, pending, unresolved, doubleSale };
  });
}

/** The caller holds the shared browser claim across begin -> worker -> finish. */
export async function beginDelistAttempt(db: Store, listingId: number, maxAttempts = 4) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid removal attempt limit.");
  return db.$transaction(async (tx) => {
    const listing = await tx.marketplaceListing.findUnique({ where: { id: listingId }, include: { item: true } });
    if (!listing || listing.item.status !== "Sold" || !["delist_pending", "delist_unknown"].includes(listing.status)) return null;
    const identity = listingIdentity(listing.marketplace, listing.externalUrl ?? "");
    if (!identity || identity.id !== listing.externalListingId || listing.attemptCount >= maxAttempts) {
      await tx.marketplaceListing.update({ where: { id: listing.id }, data: {
        status: "delist_failed", lastError: identity && identity.id === listing.externalListingId
          ? "Removal needs manual review after repeated attempts."
          : "Listing URL and recorded identity do not match; removal was not started.",
      } });
      return null;
    }
    const attempt = listing.attemptCount + 1;
    const claimed = await tx.marketplaceListing.updateMany({ where: {
      id: listing.id, status: listing.status, attemptCount: listing.attemptCount,
    }, data: { status: "delisting", attemptCount: attempt, lastAttemptAt: new Date(), lastError: null } });
    return claimed.count === 1 ? {
      listingId: listing.id, itemId: listing.itemId, sku: listing.item.sku,
      marketplace: listing.marketplace, externalListingId: identity.id, externalUrl: identity.url, attempt,
    } : null;
  });
}

export interface DelistResult {
  listingId: number;
  externalListingId: string;
  attempt: number;
  outcome: "ended" | "failed" | "unknown";
  verified?: boolean;
  message?: string;
}

export async function finishDelistAttempt(db: Store, result: DelistResult): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const verified = result.outcome === "ended" && result.verified === true;
    const status = verified ? "ended" : result.outcome === "failed" ? "delist_failed" : "delist_unknown";
    const saved = await tx.marketplaceListing.updateMany({ where: {
      id: result.listingId, externalListingId: result.externalListingId,
      status: "delisting", attemptCount: result.attempt,
    }, data: { status, ...(verified ? { endedAt: new Date() } : {}),
      lastError: verified ? null : (result.message ?? "Removal has not been verified on the marketplace.").slice(0, 2000),
    } });
    return saved.count === 1;
  });
}

// Raised only during helper discovery, before opening a marketplace editor.
export const CHROME_SESSION_UNAVAILABLE = "RuntimeError: Could not verify the existing Chrome session; try again when it responds";

/** An interrupted removal must be verified, not silently treated as complete. */
export async function recoverDelistAttempts(db: Store): Promise<number> {
  return db.$transaction(async (tx) => {
    const result = await tx.marketplaceListing.updateMany({ where: { status: "delisting" }, data: {
      status: "delist_unknown", lastError: "Removal was interrupted. Verify current marketplace availability before another action.",
    } });
    // Older builds classified this pre-submit connection failure as terminal.
    // Keep its reason and attempt budget; never revive other review failures.
    const transient = await tx.marketplaceListing.updateMany({ where: {
      status: "delist_failed", item: { status: "Sold" }, attemptCount: { lt: 4 },
      lastError: CHROME_SESSION_UNAVAILABLE,
    }, data: { status: "delist_unknown" } });
    return result.count + transient.count;
  });
}

/** Backlog only, not a monitoring-health claim. Include unresolved identities
 *  on sold items so missing IDs can never disappear behind a zero pending count. */
export const soldListingsNeedingRemovalWhere:Prisma.MarketplaceListingWhereInput={
    item: { status: "Sold" }, status: { notIn: ["sold", "ended", "not_published"] },
};
export async function removalBacklog(db: Store) {
  return db.$transaction((tx) => tx.marketplaceListing.findMany({ where: soldListingsNeedingRemovalWhere, select: { id: true, itemId: true, marketplace: true, status: true, externalListingId: true,
    externalUrl: true, lastError: true, attemptCount: true, updatedAt: true, item: { select: { sku: true, updatedAt: true } } }, orderBy: { id: "asc" } }));
}
