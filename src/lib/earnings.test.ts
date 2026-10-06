import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateFees, estimateShipping, computeEarnings, summarizeEarnings, buildEarningsReport, buildSalesSeries, type SoldRow, type TimingRow, type OpenRow } from "./earnings.ts";

const FEE = {
  eBay: { feePercent: 13.25, fixedFee: 0.3 },
  Poshmark: { feePercent: 20, fixedFee: 0 },
  default: { feePercent: 12, fixedFee: 0.3 },
};
const SHIP = { tiers: [{ maxOz: 16, cost: 4.5 }, { maxOz: 32, cost: 7 }, { maxOz: 80, cost: 12 }], default: 15 };

// ---- estimateFees ----------------------------------------------------------
test("estimateFees: known platform = price*pct + fixed", () => {
  assert.equal(estimateFees(100, "eBay", FEE), 13.55);     // 13.25 + 0.30
  assert.equal(estimateFees(40, "Poshmark", FEE), 8);      // 20% + 0
});
test("estimateFees: unknown platform or null -> default", () => {
  assert.equal(estimateFees(100, "Tradesy", FEE), 12.3);
  assert.equal(estimateFees(100, null, FEE), 12.3);
});
test("estimateFees: rounds to cents", () => {
  assert.equal(estimateFees(50, "eBay", FEE), 6.93);       // 6.625 + 0.30 = 6.925 -> 6.93
});

// ---- estimateShipping ------------------------------------------------------
test("estimateShipping: first tier whose maxOz >= weight", () => {
  assert.equal(estimateShipping(16, SHIP), 4.5);   // inclusive lower tier
  assert.equal(estimateShipping(17, SHIP), 7);     // bumps to next tier
  assert.equal(estimateShipping(32, SHIP), 7);
  assert.equal(estimateShipping(80, SHIP), 12);
});
test("estimateShipping: over top tier / unknown / zero -> default", () => {
  assert.equal(estimateShipping(100, SHIP), 15);
  assert.equal(estimateShipping(null, SHIP), 15);
  assert.equal(estimateShipping(0, SHIP), 15);
});

// ---- computeEarnings -------------------------------------------------------
test("computeEarnings: cost present -> full net profit (estimated fees/shipping)", () => {
  const c = computeEarnings(
    { salePrice: 50, platformSold: "eBay", weightOz: 10, itemCost: 8, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
    FEE, SHIP,
  );
  assert.ok(c);
  assert.equal(c.fees, 6.93);
  assert.equal(c.feesEstimated, true);
  assert.equal(c.shipping, 4.5);
  assert.equal(c.shippingEstimated, true);
  assert.equal(c.revenueAfterFees, 38.57);   // 50 - 6.93 - 4.5
  assert.equal(c.costMissing, false);
  assert.equal(c.netProfit, 30.57);          // 38.57 - 8
  assert.equal(c.marginPct, 61.14);          // 30.57 / 50 * 100
});
test("computeEarnings: cost MISSING -> graceful (net + margin null, revenue-after-fees shown)", () => {
  const c = computeEarnings(
    { salePrice: 50, platformSold: "eBay", weightOz: 10, itemCost: null, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
    FEE, SHIP,
  );
  assert.ok(c);
  assert.equal(c.costMissing, true);
  assert.equal(c.netProfit, null);
  assert.equal(c.marginPct, null);
  assert.equal(c.revenueAfterFees, 38.57);   // still computable
});
test("computeEarnings: prefers stored ACTUAL fees/shipping over estimate", () => {
  const c = computeEarnings(
    { salePrice: 50, platformSold: "eBay", weightOz: 10, itemCost: 8, marketplaceFees: 5, feesEstimated: false, shippingCost: 6, shippingEstimated: false },
    FEE, SHIP,
  );
  assert.ok(c);
  assert.equal(c.fees, 5);
  assert.equal(c.feesEstimated, false);
  assert.equal(c.shipping, 6);
  assert.equal(c.shippingEstimated, false);
  assert.equal(c.revenueAfterFees, 39);      // 50 - 5 - 6
  assert.equal(c.netProfit, 31);
});
test("computeEarnings: no salePrice -> null (not earnings-ready)", () => {
  assert.equal(
    computeEarnings(
      { salePrice: null, platformSold: null, weightOz: null, itemCost: null, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
      FEE, SHIP,
    ),
    null,
  );
});

// ---- summarizeEarnings -----------------------------------------------------
test("summarizeEarnings: revenue spans all; net + margin only count costed items", () => {
  const a = computeEarnings(
    { salePrice: 50, platformSold: "eBay", weightOz: 10, itemCost: 8, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
    FEE, SHIP,
  );
  const b = computeEarnings(
    { salePrice: 30, platformSold: "eBay", weightOz: 10, itemCost: null, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
    FEE, SHIP,
  );
  assert.ok(a); assert.ok(b);
  const t = summarizeEarnings([a, b]);
  assert.equal(t.count, 2);
  assert.equal(t.costMissingCount, 1);
  assert.equal(t.revenue, 80);          // 50 + 30 (both)
  assert.equal(t.cogs, 8);              // only a has a cost
  assert.equal(t.netProfit, 30.57);     // only a contributes net
  assert.equal(t.marginPct, 61.14);     // 30.57 / 50 (costed revenue only) * 100
});
test("summarizeEarnings: empty -> zeros, null margin", () => {
  const t = summarizeEarnings([]);
  assert.equal(t.count, 0);
  assert.equal(t.revenue, 0);
  assert.equal(t.netProfit, 0);
  assert.equal(t.marginPct, null);
});

// ---- buildEarningsReport (the four views) ----------------------------------
const D = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
test("open listing count includes all listings while the age table stays bounded", () => {
  const open = Array.from({ length: 48 }, (_, i) => ({ sku: `OPEN-${i}`, itemType: "T-Shirt", listedPrice: 20,
    dateListed: D(2026, 6, 1), createdAt: D(2026, 5, 1) }));
  const result = buildEarningsReport([], [], open, open.length, FEE, SHIP, D(2026, 6, 30).getTime());
  assert.equal(result.sellThrough.openCount, 48);
  assert.equal(result.sellThrough.aged.length, 25);
});
test("buildEarningsReport: totals, over-time, per-platform, sell-through", () => {
  const sold: SoldRow[] = [
    { id: 1, sku: "901", itemType: "Hoodie", dateSold: D(2026, 6, 25), salePrice: 45, platformSold: "eBay", weightOz: 12, itemCost: 10, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
    { id: 2, sku: "902", itemType: "Tee", dateSold: D(2026, 6, 22), salePrice: 30, platformSold: "Mercari", weightOz: 20, itemCost: null, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false }, // unknown platform -> default; cost missing
    { id: 3, sku: "903", itemType: "Jacket", dateSold: D(2026, 5, 21), salePrice: 60, platformSold: "Poshmark", weightOz: 40, itemCost: 25, marketplaceFees: null, feesEstimated: false, shippingCost: null, shippingEstimated: false },
  ];
  const timing: TimingRow[] = [
    { dateSold: D(2026, 6, 25), dateListed: D(2026, 6, 5), createdAt: D(2026, 6, 1) },   // 20d
    { dateSold: D(2026, 6, 22), dateListed: D(2026, 6, 12), createdAt: D(2026, 6, 1) },  // 10d
    { dateSold: D(2026, 5, 21), dateListed: D(2026, 4, 21), createdAt: D(2026, 4, 1) },  // 30d
  ];
  const open: OpenRow[] = [
    { sku: "904", itemType: "Jacket", listedPrice: 35, dateListed: D(2026, 4, 21), createdAt: D(2026, 4, 1) },
  ];
  const nowMs = D(2026, 6, 30).getTime();
  const r = buildEarningsReport(sold, timing, open, 4, FEE, SHIP, nowMs);

  // totals — NOTE (2026-08-06): the Poshmark label estimate is now $0 (their label
  // is prepaid by the buyer's flat shipping fee; the old 12oz-tier estimate
  // overstated costs on every Poshmark sale).
  assert.equal(r.totals.revenue, 135);          // 45+30+60 (no shippingCharged in fixture)
  assert.equal(r.totals.fees, 22.16);           // 6.26 + 3.90 + 12.00
  assert.equal(r.totals.shipping, 11.5);        // 4.5 + 7 + 0 (Poshmark label = $0)
  assert.equal(r.totals.cogs, 35);              // 10 + 25
  assert.equal(r.totals.netProfit, 47.24);      // 24.24 + 23.00 (902 excluded, no cost)
  assert.equal(r.totals.costMissingCount, 1);
  assert.equal(r.totals.marginPct, 44.99);      // 47.24 / 105 * 100

  // over-time (chronological)
  assert.equal(r.overTime.length, 2);
  assert.deepEqual(r.overTime[0], { period: "2026-05", revenue: 60, netProfit: 23, count: 1 });
  assert.deepEqual(r.overTime[1], { period: "2026-06", revenue: 75, netProfit: 24.24, count: 2 });

  // per-platform (revenue desc); Mercari net is null (its only item lacks a cost)
  assert.deepEqual(r.byPlatform.map((p) => p.platform), ["Poshmark", "eBay", "Mercari"]);
  assert.equal(r.byPlatform.find((p) => p.platform === "Mercari")!.netProfit, null);

  // sell-through + aged
  assert.equal(r.sellThrough.soldCount, 3);
  assert.equal(r.sellThrough.listedCount, 4);
  assert.equal(r.sellThrough.sellThroughPct, 75);
  assert.equal(r.sellThrough.avgDaysToSell, 20);     // (20+10+30)/3
  assert.equal(r.sellThrough.aged.length, 1);
  assert.equal(r.sellThrough.aged[0].daysListed, 70); // Apr 21 -> Jun 30
});
test("buildEarningsReport: empty -> zero totals, empty views", () => {
  const r = buildEarningsReport([], [], [], 0, FEE, SHIP, D(2026, 6, 30).getTime());
  assert.equal(r.totals.count, 0);
  assert.equal(r.overTime.length, 0);
  assert.equal(r.byPlatform.length, 0);
  assert.equal(r.sellThrough.sellThroughPct, null);
  assert.equal(r.sellThrough.avgDaysToSell, null);
});

// ---- buildSalesSeries (the Earnings sales-per-day chart) --------------------
// Local-time dates (the chart buckets by the operator's calendar day).
const L = (y: number, m: number, day: number, h = 15) => new Date(y, m - 1, day, h);
test("salesSeries: 7-day range -> 7 zero-filled daily buckets with counts", () => {
  const now = L(2026, 7, 13, 18).getTime();
  const from = now - 6 * 86400000;
  const s = buildSalesSeries([L(2026, 7, 13), L(2026, 7, 13), L(2026, 7, 11), null], from, now);
  assert.equal(s.bucket, "day");
  assert.equal(s.points.length, 7);                       // every day present, sales or not
  assert.equal(s.points[0].date, "2026-07-07");
  assert.equal(s.points[6].date, "2026-07-13");
  assert.equal(s.points[6].count, 2);                     // two sold today
  assert.equal(s.points[4].count, 1);                     // one on the 11th
  assert.equal(s.points.reduce((a, p) => a + p.count, 0), 3);
  assert.equal(s.points[1].count, 0);                     // quiet day zero-filled
});
test("salesSeries: sales BEFORE the range window are not counted", () => {
  const now = L(2026, 7, 13).getTime();
  const from = now - 6 * 86400000;
  const s = buildSalesSeries([L(2026, 6, 1)], from, now);
  assert.equal(s.points.reduce((a, p) => a + p.count, 0), 0);
});
test("salesSeries: lifetime short span stays daily; long spans bucket weekly/monthly", () => {
  const now = L(2026, 7, 13).getTime();
  const daily = buildSalesSeries([L(2026, 7, 1)], null, now);
  assert.equal(daily.bucket, "day");
  assert.equal(daily.points.length, 13);                  // Jul 1 .. Jul 13
  const weekly = buildSalesSeries([L(2026, 1, 10)], null, now);
  assert.equal(weekly.bucket, "week");                    // ~185 days -> weeks
  assert.ok(weekly.points.length >= 26 && weekly.points.length <= 28);
  assert.equal(weekly.points.reduce((a, p) => a + p.count, 0), 1);
  const monthly = buildSalesSeries([L(2024, 1, 10), L(2026, 7, 13)], null, now);
  assert.equal(monthly.bucket, "month");                  // ~2.5y -> months
  assert.equal(monthly.points[0].date, "2024-01");
  assert.equal(monthly.points[monthly.points.length - 1].date, "2026-07");
  assert.equal(monthly.points.reduce((a, p) => a + p.count, 0), 2);
});
test("salesSeries: no sales + lifetime -> a single today bucket, zero", () => {
  const now = L(2026, 7, 13).getTime();
  const s = buildSalesSeries([], null, now);
  assert.equal(s.bucket, "day");
  assert.equal(s.points.length, 1);
  assert.deepEqual(s.points[0], { date: "2026-07-13", count: 0 });
});

// ---------------------------------------------------------------------------
// 2026-08-06 accurate-earnings update: buyer-paid shipping is revenue, the
// Poshmark label costs the seller $0, and shipping profit is first-class.
// ---------------------------------------------------------------------------
test("computeEarnings: buyer-paid shipping counts as gross revenue + shipping profit", () => {
  // Real synced example (Hurley board shorts): $7.80 item + $6.58 collected
  // shipping, $2.43 actual fees, $0 label (buyer-funded) => $11.95 profit.
  const c = computeEarnings(
    { salePrice: 7.8, platformSold: "eBay", weightOz: 16, itemCost: 0,
      marketplaceFees: 2.43, feesEstimated: false, shippingCost: 0, shippingEstimated: false,
      shippingCharged: 6.58 },
    FEE, SHIP,
  );
  assert.ok(c);
  assert.equal(c.itemPrice, 7.8);
  assert.equal(c.shippingIncome, 6.58);
  assert.equal(c.revenue, 14.38);
  assert.equal(c.shippingProfit, 6.58);
  assert.equal(c.netProfit, 11.95);
});

test("computeEarnings: unknown shippingCharged counts as 0 income, never estimated", () => {
  const c = computeEarnings(
    { salePrice: 20, platformSold: "eBay", weightOz: 10, itemCost: null,
      marketplaceFees: null, feesEstimated: false, shippingCost: 4.5, shippingEstimated: false },
    FEE, SHIP,
  );
  assert.ok(c);
  assert.equal(c.shippingIncome, 0);
  assert.equal(c.revenue, 20);
  assert.equal(c.shippingProfit, -4.5);  // paid a label, collected nothing (known)
});

test("estimateShipping: Poshmark label is $0 regardless of weight; others unchanged", () => {
  assert.equal(estimateShipping(40, SHIP, "Poshmark"), 0);
  assert.equal(estimateShipping(40, SHIP, "poshmark"), 0);
  assert.equal(estimateShipping(40, SHIP, "eBay"), 12);
  assert.equal(estimateShipping(10, SHIP), 4.5);
});

test("summarizeEarnings: shipping income/profit roll up into totals", () => {
  const a = computeEarnings(
    { salePrice: 10, platformSold: "eBay", weightOz: 8, itemCost: 2,
      marketplaceFees: 1, feesEstimated: false, shippingCost: 4, shippingEstimated: false,
      shippingCharged: 7 },
    FEE, SHIP,
  )!;
  const b = computeEarnings(
    { salePrice: 20, platformSold: "Poshmark", weightOz: 8, itemCost: 5,
      marketplaceFees: 4, feesEstimated: false, shippingCost: 0, shippingEstimated: false,
      shippingCharged: 0 },
    FEE, SHIP,
  )!;
  const t = summarizeEarnings([a, b]);
  assert.equal(t.itemPriceTotal, 30);
  assert.equal(t.shippingIncome, 7);
  assert.equal(t.shippingProfit, 3);     // (7−4) + (0−0)
  assert.equal(t.revenue, 37);           // gross
});
