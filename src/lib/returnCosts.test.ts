import test from "node:test";
import assert from "node:assert/strict";
import { buildEarningsReport, type SoldRow } from "./earnings.ts";
import { applyReturnCosts } from "./returnCosts.ts";

const now = Date.parse("2026-09-19T12:00:00.000Z");
const sale = (id: number, cost: number | null, price = 100): SoldRow => ({ id, sku: `SALE-${id}`, itemType: "T-Shirt",
  dateSold: new Date(now - 86400000), salePrice: price, platformSold: "eBay", weightOz: 8,
  itemCost: cost, marketplaceFees: 0, feesEstimated: false, shippingCost: 0, shippingEstimated: false, shippingCharged: 0 });
const report = (sold: SoldRow[]) => buildEarningsReport(sold, [], [], 0,
  { default: { feePercent: 0, fixedFee: 0 } }, { tiers: [], default: 0 }, now);
const returned = (feeLoss = 1, postageLoss = 3, resolvedAt = new Date(now - 1000).toISOString()) => ({
  newValue: JSON.stringify({ key: "return-1", marketplace: "ebay", reason: "Confirmed refund and receipt", feeLoss, postageLoss, resolvedAt }),
});

test("an empty returns adjustment preserves the costed-sales margin and source report", () => {
  const source = report([sale(1, 20), sale(2, null)]), before = structuredClone(source);
  const adjusted = applyReturnCosts(source, [], null, now);
  assert.equal(source.totals.marginPct, 80);
  assert.deepEqual(adjusted.totals, source.totals);
  assert.deepEqual(source, before);
  assert.deepEqual(adjusted.returnCosts, { count: 0, fees: 0, postage: 0, total: 0 });
});

test("known return losses reduce profit without including uncosted sales in its margin basis", () => {
  const adjusted = applyReturnCosts(report([sale(1, 20), sale(2, null)]), [returned()], null, now);
  assert.equal(adjusted.totals.revenue, 200);
  assert.equal(adjusted.totals.costMissingCount, 1);
  assert.equal(adjusted.totals.netProfit, 76);
  assert.equal(adjusted.totals.marginPct, 76);
  assert.equal(adjusted.byPlatform[0].netProfit, 76);
  assert.equal(adjusted.overTime[0].netProfit, 76);
});

test("unknown costs and zero cost remain distinct after return adjustments", () => {
  const unknown = applyReturnCosts(report([sale(1, null)]), [returned()], null, now);
  assert.equal(unknown.totals.netProfit, -4);
  assert.equal(unknown.totals.marginPct, null);
  const zero = applyReturnCosts(report([sale(1, 0)]), [returned()], null, now);
  assert.equal(zero.totals.marginPct, 96);
  assert.equal(zero.totals.costMissingCount, 0);
});

test("returns with no sales retain their known loss without inventing a margin", () => {
  const adjusted = applyReturnCosts(report([]), [returned()], null, now);
  assert.equal(adjusted.totals.netProfit, -4);
  assert.equal(adjusted.totals.marginPct, null);
  assert.equal(adjusted.byPlatform[0].netProfit, -4);
});

test("out-of-range, future and malformed returns cannot change the selected period", () => {
  const source = report([sale(1, 20), sale(2, null)]);
  const adjusted = applyReturnCosts(source, [returned(1, 3, new Date(now - 86400000).toISOString()),
    returned(1, 3, new Date(now + 1000).toISOString()), { newValue: "broken" }], now - 10_000, now);
  assert.deepEqual(adjusted.totals, source.totals);
  assert.equal(adjusted.returnCosts.count, 0);
});
