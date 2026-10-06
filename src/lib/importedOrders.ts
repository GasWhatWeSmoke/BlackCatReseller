// Nifty's Analytics -> Orders ledger: matching a row to an item, and deciding whether
// that row is a completed sale.
//
// WHY THIS IS ITS OWN MODULE (2026-08-20): a sale went unreported for a day. The
// Inventory Manager still counted the item as Listed — Nifty's own badge said
// "Listed 85 / Sold 18" — while the Orders ledger already carried the order, dated,
// priced and itemized. The sync wrote the money onto the item (sale price, fees,
// sale date, earnings-ready) and then left its STATUS as "Uploaded to Nifty", because
// only the Sold view was allowed to say "sold". So the app held a complete record of a
// sale it refused to call a sale, and reported "0 sold".
//
// The orders ledger is the same source the sync already calls the money truth. If it is
// good enough to overwrite a sale price, it is good enough to say the item sold.
// Extracted so the guards can be tested against the exact rows Nifty really produced.

export interface NiftyOrder {
  title: string;
  /** YYYY-MM-DD, parsed from "Order on MM/DD/YYYY". */
  date: string | null;
  salePrice: number | null;
  collectedShipping: number | null;
  refund: number | null;
  feesStandard: number | null;
  feesShipping: number | null;
  feesPromoted: number | null;
  cogs: number | null;
  shippingExpenses: number | null;
  otherExpenses: number | null;
  totalProfit: number | null;
}

/** Strip zero-width characters, collapse whitespace, lowercase. */
export function normalizeOrderTitle(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[​-‏﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one order row that belongs to this listing, or null when there is no match or
 * more than one.
 *
 * Nifty's title cell is not the listing title. It reads "Order on MM/DD/YYYY" followed
 * by the title AND a second descriptive line, and long ones are ellipsized — the row
 * for the real 2026-08-20 sale came through as
 *   "Roar Mens Y2K Shirt Light Blue White Embroidered Size XXL Roar light blue bu..."
 * for a listing titled "Roar Mens Y2K Shirt Light Blue White Embroidered Size XXL".
 * So containment in EITHER direction counts, with a length floor so a stub can't match
 * half the inventory.
 *
 * Ambiguity returns null rather than the first hit: an item relisted twice has two
 * orders, and guessing which one is the sale would put the wrong money on the item.
 */
export function findOrderForTitle(orders: NiftyOrder[], listingTitle: string | null): NiftyOrder | null {
  const matches = findOrdersForTitle(orders, listingTitle);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * EVERY order row matching this listing title, in ledger order.
 *
 * Same matching as findOrderForTitle — this is where it lives — but without the
 * one-match rule. An item that was re-listed and sold again legitimately has two rows
 * under one title, and "which sales does this title have, and when" is a question the
 * staleness check below has to answer even when picking a single winner would be a guess.
 */
export function findOrdersForTitle(orders: NiftyOrder[], listingTitle: string | null): NiftyOrder[] {
  const title = normalizeOrderTitle(listingTitle);
  if (!title || title.length < 12) return [];
  return (orders || []).filter((o) => {
    const ot = normalizeOrderTitle(o.title).replace(/(…|\.\.\.)\s*$/, "").trim();
    if (!ot) return false;
    return ot === title || ot.includes(title) ||
      (ot.length >= 20 && (title.includes(ot) || title.startsWith(ot) || ot.startsWith(title)));
  });
}

export type SaleVerdict =
  | { sold: true }
  | { sold: false; reason: "no price" | "no date" | "fully refunded" };

/**
 * Is this order row evidence that the item actually sold?
 *
 * Deliberately strict, because the consequence is an item leaving the active inventory:
 *   - a price is required (a row with none is a parse artifact, not a sale),
 *   - a date is required for the same reason,
 *   - a fully refunded order is NOT a sale — the money came back and the item is
 *     usually on its way back too. A partial refund still is one.
 */
export function orderIsCompletedSale(o: NiftyOrder | null): SaleVerdict {
  if (!o || o.salePrice == null || o.salePrice <= 0) return { sold: false, reason: "no price" };
  if (!o.date) return { sold: false, reason: "no date" };
  if (o.refund != null && o.refund >= o.salePrice - 0.005) return { sold: false, reason: "fully refunded" };
  return { sold: true };
}

/**
 * Does this order CONTRADICT a claim that the item sold?
 *
 * Nifty's Sold view records that a sale happened and never un-records one, so a refunded
 * order goes on looking exactly like a sale there forever. The orders ledger is the only
 * place the money coming back is written down, which is what makes a full refund the one
 * piece of evidence allowed to overrule "its title is in the Sold view" — and what stops
 * a returned item that was put back up for sale from being re-marked Sold on every sync.
 *
 * Only a FULL refund vetoes. A partial refund is still a sale, and a missing or ambiguous
 * order (null) is not evidence of anything.
 */
export function orderVetoesSale(order: NiftyOrder | null): boolean {
  if (!order) return false;
  const verdict = orderIsCompletedSale(order);
  return !verdict.sold && verdict.reason === "fully refunded";
}

/**
 * Find the full-refund row that belongs to an item's CURRENT sold life.
 *
 * A title can legitimately have more than one order after a re-list. In that case the
 * generic one-row matcher refuses to guess, so a stale refund from the first sale must
 * not pull the second sale back into inventory. Price and sale day narrow the candidates;
 * anything still ambiguous is left alone for the operator.
 */
export function findFullyRefundedOrderForSoldItem(
  orders: NiftyOrder[],
  listingTitle: string | null,
  item: { status: string; niftyStatus: string | null; salePrice: number | null; dateSold: Date | string | null },
): NiftyOrder | null {
  if (item.status !== "Sold" || !["Published", "Draft"].includes(item.niftyStatus ?? "")) return null;

  const matches = findOrdersForTitle(orders, listingTitle);
  const refunded = matches.filter(orderVetoesSale);
  if (matches.length === 1) return refunded[0] ?? null;
  if (!refunded.length) return null;

  let candidates = refunded;
  if (item.salePrice != null) {
    candidates = candidates.filter((o) => o.salePrice != null && Math.abs(o.salePrice - item.salePrice!) < 0.005);
    if (!candidates.length) return null;
  }
  if (item.dateSold) {
    const saleDay = new Date(item.dateSold).toISOString().slice(0, 10);
    candidates = candidates.filter((o) => o.date === saleDay);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export interface ReturnedSaleReset {
  status: "Ready for Nifty";
  niftyStatus: "Not Uploaded";
  salePrice: null;
  platformSold: null;
  marketplaceFees: null;
  feesEstimated: false;
  shippingCost: null;
  shippingCharged: null;
  shippingEstimated: false;
  earningsReady: false;
  dateSold: null;
  relistedAt: Date;
  shippedAt: null;
}

/** The complete inverse of a realized sale; item cost and listing/photo history stay. */
export function buildReturnedSaleReset(
  item: { status: string; niftyStatus: string | null },
  order: NiftyOrder | null,
  at: Date,
): ReturnedSaleReset | null {
  if (item.status !== "Sold" || !["Published", "Draft"].includes(item.niftyStatus ?? "")) return null;
  if (!orderVetoesSale(order) || !Number.isFinite(at.getTime())) return null;
  return {
    status: "Ready for Nifty",
    niftyStatus: "Not Uploaded",
    salePrice: null,
    platformSold: null,
    marketplaceFees: null,
    feesEstimated: false,
    shippingCost: null,
    shippingCharged: null,
    shippingEstimated: false,
    earningsReady: false,
    dateSold: null,
    relistedAt: at,
    shippedAt: null,
  };
}

/**
 * Is Nifty's "this sold" evidence STALE for an item that was deliberately put back up
 * for sale?
 *
 * The Sold view is a permanent record that a TITLE sold once. It says nothing about the
 * listing currently carrying that title, and it is never un-recorded — so re-list an item
 * (returned, refunded, or just ended and posted again) and that old row goes on claiming
 * the new listing forever. 000084 was re-marked Sold twice off a refunded sale that had
 * been cleared by hand, because Nifty's ledger carries no refund for it and never will.
 *
 * So once an item records a re-list, only a sale DATED AFTER it counts. Every matching
 * order is weighed, not just an unambiguous one: after re-list-then-sell there really are
 * two rows under the same title, and the newer one is the real sale.
 *
 * Order dates are days, not timestamps, so a sale is read at the END of its day — that
 * way a genuine sale on the same day as the re-list still counts, instead of being
 * mistaken for the old one and suppressed forever. The residual gap is narrow and known:
 * an item refunded AND re-listed on the same day the sale was recorded still needs
 * clearing once more.
 *
 * The cost of the guard is a lag, never a miss. If the Sold view shows a real new sale
 * before the orders ledger does, it lands on the next sync instead of this one. Recording
 * a sale a few hours late is recoverable; marking a live listing sold takes it off
 * the market.
 */
export function saleEvidenceIsStale(
  item: { relistedAt: Date | string | null },
  orders: NiftyOrder[],
  listingTitle: string | null,
): boolean {
  if (!item.relistedAt) return false;
  const since = new Date(item.relistedAt).getTime();
  if (!Number.isFinite(since)) return false;
  return !findOrdersForTitle(orders, listingTitle).some((o) => {
    if (!orderIsCompletedSale(o).sold) return false;
    const endOfSaleDay = Date.parse(`${o.date}T23:59:59`);
    return Number.isFinite(endOfSaleDay) && endOfSaleDay > since;
  });
}

/** Statuses an item can be in and still be transitioned to Sold by the orders ledger. */
const LIVE_STATUSES = new Set(["Uploaded to Nifty", "Listed", "Ready for Nifty", "Photographed", "Needs Info", "Problem"]);

/**
 * Should the orders ledger flip this item to Sold?
 *
 * Only ever moves an item FORWARD into Sold. An item already Sold keeps its status (the
 * money-correction path still runs); Removed and Archived are end states the operator or
 * an earlier reconcile chose, and a stale order row must not resurrect them.
 */
export function ordersShouldMarkSold(
  item: { status: string; niftyStatus: string | null },
  order: NiftyOrder | null,
): boolean {
  if (item.status === "Sold" || !LIVE_STATUSES.has(item.status)) return false;
  if (!["Published", "Draft"].includes(item.niftyStatus ?? "")) return false;
  return orderIsCompletedSale(order).sold;
}
