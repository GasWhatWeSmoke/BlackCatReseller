// A sale sat unreported for a day: Nifty's Inventory Manager still counted the item as
// Listed while the Orders ledger already held the order, and the sync wrote every money
// field onto the item without ever calling it sold. These tests use the real rows from
// that day, so the shapes are not invented.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReturnedSaleReset, findFullyRefundedOrderForSoldItem, normalizeOrderTitle,
  findOrderForTitle, findOrdersForTitle, orderIsCompletedSale, ordersShouldMarkSold,
  orderVetoesSale, saleEvidenceIsStale, type NiftyOrder,
} from "./importedOrders.ts";

const order = (over: Partial<NiftyOrder> = {}): NiftyOrder => ({
  title: "Roar Mens Y2K Shirt Light Blue White Embroidered Size XXL Roar light blue bu...",
  date: "2026-08-20", salePrice: 16, collectedShipping: 0, refund: 0,
  feesStandard: 1.1, feesShipping: 0, feesPromoted: 1.92, cogs: 0,
  shippingExpenses: 0, otherExpenses: 0, totalProfit: 12.98,
  ...over,
});

const LIVE = { status: "Uploaded to Nifty", niftyStatus: "Published" };
const ROAR = "Roar Mens Y2K Shirt Light Blue White Embroidered Size XXL";

test("the real 2026-08-20 row matches its listing despite the trailing description", () => {
  // Nifty's title cell is "Order on 08/20/2026\n\n<title>\n<description…>", so the
  // parsed title is LONGER than the listing title and ends in an ellipsis.
  assert.equal(findOrderForTitle([order()], ROAR)?.salePrice, 16);
});

test("that row is a completed sale, and marks the item Sold", () => {
  assert.deepEqual(orderIsCompletedSale(order()), { sold: true });
  assert.equal(ordersShouldMarkSold(LIVE, order()), true);
});

test("an exact title still matches", () => {
  assert.ok(findOrderForTitle([order({ title: ROAR })], ROAR));
});

test("a listing with no matching order is left alone", () => {
  assert.equal(findOrderForTitle([order()], "Carhartt Mens Cargo Shorts Tan Pockets Relaxed Size L"), null);
});

test("two orders for one title is ambiguous and matches NOTHING", () => {
  // A relisted item sells twice. Guessing which order is the sale puts the wrong money
  // on the item, so neither is used.
  const twice = [order({ date: "2026-07-11", salePrice: 10 }), order({ date: "2026-08-20", salePrice: 16 })];
  assert.equal(findOrderForTitle(twice, ROAR), null);
});

test("a short title never matches — it would match half the inventory", () => {
  assert.equal(findOrderForTitle([order({ title: "Tee" })], "Tee"), null);
  assert.equal(findOrderForTitle([order()], ""), null);
  assert.equal(findOrderForTitle([order()], null), null);
});

test("a fully refunded order is NOT a sale", () => {
  // Every column looks like a sale except the refund one, and the consequence of
  // getting it wrong is an item leaving the active inventory.
  const refunded = order({ refund: 16 });
  assert.deepEqual(orderIsCompletedSale(refunded), { sold: false, reason: "fully refunded" });
  assert.equal(ordersShouldMarkSold(LIVE, refunded), false);
});

test("a PARTIAL refund is still a sale", () => {
  assert.equal(orderIsCompletedSale(order({ refund: 4 })).sold, true);
});

test("a full refund vetoes a sale the Sold view still shows", () => {
  // The 000084 case: the pink Ed Hardy bag sold on Depop, was refunded, came back, and
  // was re-listed. Nifty's Sold view goes on showing that title forever, so without the
  // veto every sync re-marked the live listing Sold and re-wrote the refunded money onto
  // it. The refund lives only in the orders ledger, which is why it gets the last word.
  assert.equal(orderVetoesSale(order({ refund: 16 })), true);
});

test("nothing else vetoes a sale — not a partial refund, not a missing order", () => {
  assert.equal(orderVetoesSale(order({ refund: 4 })), false, "partial refund is still a sale");
  assert.equal(orderVetoesSale(order()), false, "a clean sale");
  // A title that matched no order, or matched ambiguously, proves nothing either way —
  // vetoing on null would silently stop marking anything sold.
  assert.equal(orderVetoesSale(null), false, "no matching order");
  assert.equal(orderVetoesSale(order({ salePrice: null })), false, "a parse artifact is not a refund");
  assert.equal(orderVetoesSale(order({ date: null })), false, "a parse artifact is not a refund");
});

// --- returns: reverse the CURRENT sale without erasing inventory history ------------

const SOLD = {
  status: "Sold", niftyStatus: "Published", salePrice: 16,
  dateSold: new Date("2026-08-20T12:00:00Z"),
};

test("a full refund of the current sold item is detected as a return", () => {
  const refunded = order({ refund: 16 });
  assert.equal(findFullyRefundedOrderForSoldItem([refunded], ROAR, SOLD), refunded);
});

test("a partial refund does not return the item to inventory", () => {
  assert.equal(findFullyRefundedOrderForSoldItem([order({ refund: 4 })], ROAR, SOLD), null);
  assert.equal(buildReturnedSaleReset(SOLD, order({ refund: 4 }), new Date()), null);
});

test("the return reset clears every realized-sale field and arms a new listing life", () => {
  const at = new Date("2026-08-26T18:00:00Z");
  const reset = buildReturnedSaleReset(SOLD, order({ refund: 16 }), at);
  assert.deepEqual(reset, {
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
  });
  assert.equal("itemCost" in (reset ?? {}), false, "inventory cost must survive a return");
  assert.equal("finalTitle" in (reset ?? {}), false, "listing history must survive a return");
});

test("an old refunded sale cannot undo a newer sale under the same title", () => {
  const oldRefund = order({ date: "2026-07-11", salePrice: 10, refund: 10 });
  const currentSale = order({ date: "2026-08-20", salePrice: 16, refund: 0 });
  assert.equal(findFullyRefundedOrderForSoldItem([oldRefund, currentSale], ROAR, SOLD), null);
});

test("a second return is found among multiple orders by current sale day and price", () => {
  const oldSale = order({ date: "2026-07-11", salePrice: 10, refund: 0 });
  const currentRefund = order({ date: "2026-08-20", salePrice: 16, refund: 16 });
  assert.equal(findFullyRefundedOrderForSoldItem([oldSale, currentRefund], ROAR, SOLD), currentRefund);
});

// --- re-listed items: a sold TITLE is not a sold LISTING -------------------------
// 000084, the pink Ed Hardy bag: sold on Depop 08/22, refunded, came back, re-listed.
// Nifty carries no refund on that order, so its Sold view claims the new listing every
// single sync — it was re-marked Sold twice after being cleared by hand.

const RELISTED = { relistedAt: new Date("2026-08-23T19:41:00Z") };
const BAG = "NWT Ed Hardy Womens Colorblock Tattoo-print Shoulder Bag Pink Graphic Print";
const bagOrder = (over: Partial<NiftyOrder> = {}) =>
  order({ title: BAG, date: "2026-08-22", salePrice: 37.5, refund: 0, ...over });

test("a sale that predates the re-list is stale evidence", () => {
  assert.equal(saleEvidenceIsStale(RELISTED, [bagOrder()], BAG), true);
});

test("an item that was never re-listed is never suppressed", () => {
  assert.equal(saleEvidenceIsStale({ relistedAt: null }, [bagOrder()], BAG), false);
});

test("a re-listed item that sells AGAIN is marked sold on the new order", () => {
  // The whole point of dating the check: suppression has to end by itself, or a
  // re-listed item could never be sold again.
  const sold = bagOrder({ date: "2026-08-25" });
  assert.equal(saleEvidenceIsStale(RELISTED, [sold], BAG), false);
});

test("the OLD order alongside the new one does not re-suppress the new sale", () => {
  // Two rows under one title is the normal post-re-list shape, and findOrderForTitle
  // deliberately refuses to pick between them — so staleness weighs all of them.
  const both = [bagOrder(), bagOrder({ date: "2026-08-25" })];
  assert.equal(findOrderForTitle(both, BAG), null, "ambiguous by design");
  assert.equal(findOrdersForTitle(both, BAG).length, 2);
  assert.equal(saleEvidenceIsStale(RELISTED, both, BAG), false);
});

test("a sale on the SAME DAY as the re-list still counts", () => {
  // Order dates are days, not timestamps. Reading the sale at the start of its day
  // would bury a genuine same-day sale behind an afternoon re-list — permanently,
  // since the date never changes.
  assert.equal(saleEvidenceIsStale(RELISTED, [bagOrder({ date: "2026-08-23" })], BAG), false);
});

test("a refunded order dated after the re-list does not lift the suppression", () => {
  // Otherwise a second refund would hand the listing straight back to the Sold view.
  const refundedAgain = bagOrder({ date: "2026-08-25", refund: 37.5 });
  assert.equal(saleEvidenceIsStale(RELISTED, [refundedAgain], BAG), true);
});

test("no orders at all leaves a re-listed item suppressed", () => {
  // The Sold view alone cannot date anything, so it cannot clear the marker either.
  assert.equal(saleEvidenceIsStale(RELISTED, [], BAG), true);
  assert.equal(saleEvidenceIsStale(RELISTED, [order()], BAG), true, "a different item's order");
});

test("a row with no price or no date is a parse artifact, not a sale", () => {
  assert.deepEqual(orderIsCompletedSale(order({ salePrice: null })), { sold: false, reason: "no price" });
  assert.deepEqual(orderIsCompletedSale(order({ salePrice: 0 })), { sold: false, reason: "no price" });
  assert.deepEqual(orderIsCompletedSale(order({ date: null })), { sold: false, reason: "no date" });
  assert.deepEqual(orderIsCompletedSale(null), { sold: false, reason: "no price" });
});

test("an already-Sold item is never re-marked", () => {
  // Its money still gets corrected by the caller; only the status transition is skipped.
  assert.equal(ordersShouldMarkSold({ status: "Sold", niftyStatus: "Published" }, order()), false);
});

test("Removed and Archived are end states an order cannot resurrect", () => {
  for (const status of ["Removed", "Archived"]) {
    assert.equal(ordersShouldMarkSold({ status, niftyStatus: "Published" }, order()), false, status);
  }
});

test("an item that was never uploaded is not marked sold by a stray title match", () => {
  assert.equal(ordersShouldMarkSold({ status: "Uploaded to Nifty", niftyStatus: "Not Uploaded" }, order()), false);
});

test("normalization strips the zero-width characters Nifty injects", () => {
  assert.equal(normalizeOrderTitle("Roar​  Mens   Shirt"), "roar mens shirt");
  assert.equal(normalizeOrderTitle(null), "");
});
