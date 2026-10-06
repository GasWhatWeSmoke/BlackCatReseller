import type { PrismaClient } from "@prisma/client";
import type { SaleObservation } from "./salesProtocol.ts";
type Store = Pick<PrismaClient, "$transaction">;
export const ORDER_REVIEW_FIELD = "order_review";
export interface OrderReviewData {
  key: string; marketplace: string; receiptId?: string; listingId?: string; url?: string; reason: string;
  resolvedAt?: string; feeLoss?: number; postageLoss?: number;
  retiredListings?: { marketplace: string; listingId: string | null }[];
}
export function orderReviewData(value: string | null): OrderReviewData | null {
  try { const data = JSON.parse(value ?? "null"); return data && typeof data.key === "string" && typeof data.marketplace === "string" && typeof data.reason === "string" ? data : null; } catch { return null; }
}
export function orderReviewIdentity(entry: { id: number; itemId: number | null; sku: string; runAt: Date; newValue: string | null }) {
  return JSON.stringify([entry.id, entry.itemId, entry.sku, entry.runAt.toISOString(), orderReviewData(entry.newValue)?.key ?? null]);
}
export async function recordOrderReview(db: Store, input: { observation?: SaleObservation; sku?: string; reason?: string }) {
  return db.$transaction(async tx => {
    const observation = input.observation;
    const matches = observation ? await tx.marketplaceListing.findMany({ where: { marketplace: observation.marketplace, externalListingId: observation.listingId }, include: { item: true }, take: 2 }) : [];
    const source = matches.length === 1 ? matches[0] : null;
    // A sold item can retain ended/uncertain counterpart rows from an earlier
    // sale. Their changed orders do not describe the current sale.
    if (observation && source?.status !== 'sold') return null;
    const item = source?.item ?? (!observation && input.sku ? await tx.item.findUnique({ where: { sku: input.sku } }) : null);
    if (!item || item.status !== "Sold") return null;
    const key = observation ? `${observation.marketplace}:${observation.receiptId}:${observation.listingId}` : `manual:${item.id}:${Date.now()}`;
    const existing = await tx.syncLog.findMany({ where: { itemId: item.id, field: ORDER_REVIEW_FIELD }, orderBy: { id: "desc" } });
    if (observation && existing.some(row => row.action === 'returned' && orderReviewData(row.newValue)?.retiredListings?.some(
      listing => listing.marketplace === observation.marketplace && listing.listingId === observation.listingId))) return null;
    const duplicate = existing.find(row => row.action === "pending_review" || orderReviewData(row.newValue)?.key === key);
    if (duplicate) return duplicate.action === "pending_review" ? duplicate.id : null;
    const data: OrderReviewData = { key, marketplace: observation?.marketplace ?? item.platformSold ?? "Unrecorded",
      ...(observation ? { receiptId: observation.receiptId, listingId: observation.listingId, url: observation.listingUrl } : {}),
      reason: input.reason ?? "A previously paid order now has a different status. Check for a cancellation or refund." };
    const entry = await tx.syncLog.create({ data: { itemId: item.id, sku: item.sku, field: ORDER_REVIEW_FIELD,
      action: "pending_review", source: observation ? "marketplace" : "manual", newValue: JSON.stringify(data),
      oldValue: JSON.stringify({ itemCreatedAt: item.createdAt.toISOString(), salePrice: item.salePrice, platformSold: item.platformSold, dateSold: item.dateSold, niftyStatus: item.niftyStatus,
        marketplaceFees: item.marketplaceFees, shippingCost: item.shippingCost, shippingCharged: item.shippingCharged, itemCost: item.itemCost }),
      note: "Order status requires operator review. Inventory and earnings have not been reversed." } });
    return entry.id;
  });
}
export async function resolveOrderReview(db: Store, id: number, input: { decision: string; reviewIdentity?: string; fullRefund?: boolean; itemReceived?: boolean; feeLoss?: number; postageLoss?: number }) {
  if (!["keep_sold", "return_to_review"].includes(input.decision)) throw new Error("Choose how to resolve this order.");
  if (input.decision === "return_to_review") {
    if (input.fullRefund !== true || input.itemReceived !== true) throw new Error("Confirm both the full refund and that the item is back in your inventory.");
    for (const value of [input.feeLoss, input.postageLoss]) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Record unrecovered fees and postage, using zero if none remain.");
  }
  return db.$transaction(async tx => {
    const entry = await tx.syncLog.findUnique({ where: { id } });
    const data = entry && orderReviewData(entry.newValue);
    if (!entry || entry.field !== ORDER_REVIEW_FIELD || !entry.itemId || !data) throw new Error("Order review not found.");
    const identity = orderReviewIdentity(entry);
    if (input.reviewIdentity !== undefined && (typeof input.reviewIdentity !== 'string' || input.reviewIdentity !== identity))
      throw new Error('This review changed since it was loaded. Refresh and confirm the original review before making a decision.');
    if (entry.action !== "pending_review") throw new Error("This order review is already resolved.");
    if (input.decision === "return_to_review") {
      const item = await tx.item.findUniqueOrThrow({ where: { id: entry.itemId }, include: { marketplaceListings: true } });
      let snapshot: { itemCreatedAt?: unknown } | null = null;
      try { snapshot = JSON.parse(entry.oldValue ?? 'null'); } catch { /* An unreadable snapshot cannot authorize returning stock. */ }
      if (!snapshot || typeof snapshot.itemCreatedAt !== 'string')
        throw new Error('This older review cannot confirm the original inventory identity. Check the current sale, close this review with Keep sale recorded, then report it again before returning stock.');
      if (snapshot.itemCreatedAt !== item.createdAt.toISOString() || entry.sku !== item.sku)
        throw new Error('The original item no longer matches this review. Check the inventory identity before reporting a new review.');
      if (item.status !== "Sold") throw new Error("This item is no longer recorded as sold. Refresh before making another change.");
      if (item.marketplaceListings.filter(row => row.status === "sold").length > 1) throw new Error("More than one marketplace recorded a sale. Resolve the multiple-sale conflict before returning this item to inventory.");
      if (item.marketplaceListings.some(row => !["sold", "ended", "not_published"].includes(row.status))) throw new Error("Finish or verify the other listing removals before returning this item to Review.");
      data.retiredListings = item.marketplaceListings.map(row => ({ marketplace: row.marketplace, listingId: row.externalListingId }));
      data.feeLoss = input.feeLoss; data.postageLoss = input.postageLoss;
      // The old integration flag is historical now. Keeping Published here
      // would prevent export/approval from placing the returned item in Ready.
      await tx.item.update({ where: { id: item.id }, data: { status: "Needs Info", niftyStatus: "Not Uploaded", salePrice: null, platformSold: null,
        dateSold: null, shippedAt: null, marketplaceFees: null, shippingCost: null, shippingCharged: null, earningsReady: false,
        feesEstimated: true, shippingEstimated: true } });
      await tx.marketplaceListing.updateMany({ where: { itemId: item.id, status: "sold" }, data: { status: "ended" } });
    }
    data.resolvedAt = new Date().toISOString();
    await tx.syncLog.update({ where: { id }, data: { action: input.decision === "return_to_review" ? "returned" : "review_resolved", newValue: JSON.stringify(data),
      note: input.decision === "return_to_review" ? "Full refund and item receipt confirmed by the operator. Returned to Review; original sale preserved in this entry." : "Operator reviewed the change and retained the sale." } });
    return { itemId: entry.itemId, sku: entry.sku, identity, returned: input.decision === "return_to_review" };
  });
}
