// Earnings money model (§30.3, gross-method update 2026-08-06) — PURE functions, no DB.
// Net profit per sold item:
//   gross revenue = item sale price + buyer-paid shipping that reaches the seller
//   net = gross − marketplace fees − shipping-label cost − item cost
// Buyer-paid shipping IS seller revenue on eBay/Etsy/ship-on-your-own (and that's how
// 1099-Ks report it); Poshmark keeps the buyer's shipping AND provides the label, so
// there shipping income is 0 and the label estimate is $0, not a mailer tier.
// Synced ACTUALS always win; when a field isn't available we ESTIMATE from the
// configurable fee/shipping model and flag it. Item COST is operator-entered and NEVER
// estimated — when it's blank, profit degrades gracefully to "revenue after fees" + a
// cost-missing flag rather than printing a wrong number.

export interface FeeModel {
  [platform: string]: { feePercent: number; fixedFee: number };
}
export interface ShippingModel {
  tiers: { maxOz: number; cost: number }[];
  default: number;
}

// The earnings-relevant slice of an Item (so callers can pass a plain object or a row).
export interface EarningsItem {
  salePrice: number | null;
  platformSold: string | null;
  weightOz: number | null;
  itemCost: number | null;
  marketplaceFees: number | null;
  feesEstimated: boolean;
  shippingCost: number | null;
  shippingEstimated: boolean;
  // Buyer-paid shipping that landed in the payout (synced from Nifty "Collected
  // shipping"). Optional so older fixtures/rows without the column still compute:
  // null/undefined = unknown -> counted as 0 income, never estimated.
  shippingCharged?: number | null;
}

export interface EarningsCalc {
  itemPrice: number;          // what the ITEM sold for (ex-shipping)
  shippingIncome: number;     // buyer-paid shipping received (0 when unknown/kept by platform)
  revenue: number;            // GROSS = itemPrice + shippingIncome
  fees: number;               // marketplace fees (actual or estimated)
  feesEstimated: boolean;
  shipping: number;           // shipping-label cost (actual or estimated)
  shippingEstimated: boolean;
  shippingProfit: number;     // shippingIncome − label cost (negative = you ate postage)
  itemCost: number | null;    // null => not entered
  costMissing: boolean;
  revenueAfterFees: number;   // revenue − fees − shipping (always computable)
  netProfit: number | null;   // revenueAfterFees − itemCost, or null when cost is missing
  marginPct: number | null;   // netProfit / revenue * 100, or null when net is unknown
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Marketplace fee for a sale: salePrice * feePercent/100 + fixedFee. Unknown platform falls
// back to the model's "default" entry (and 0 if even that is missing).
export function estimateFees(salePrice: number, platform: string | null, model: FeeModel): number {
  const normalized = platform?.trim().toLowerCase();
  const matching = normalized ? Object.keys(model).filter(key => key.trim().toLowerCase() === normalized) : [];
  const key = platform && Object.hasOwn(model, platform) ? platform : matching.length === 1 ? matching[0] : "default";
  const m = model[key] ?? { feePercent: 0, fixedFee: 0 };
  return round2((salePrice * (m.feePercent || 0)) / 100 + (m.fixedFee || 0));
}

// Shipping-label cost: the first tier whose maxOz >= weight wins; heavier than the top tier
// (or unknown weight) uses `default`. Platform-aware: a Poshmark label is PREPAID by the
// buyer's flat shipping fee — the seller pays $0, so estimating a mailer tier there
// overstated costs on every Poshmark sale.
export function estimateShipping(
  weightOz: number | null,
  model: ShippingModel,
  platform?: string | null,
): number {
  if ((platform || "").trim().toLowerCase() === "poshmark") return 0;
  if (weightOz == null || weightOz <= 0) return round2(model.default);
  const tiers = [...(model.tiers ?? [])].sort((a, b) => a.maxOz - b.maxOz);
  for (const t of tiers) if (weightOz <= t.maxOz) return round2(t.cost);
  return round2(model.default);
}

// Per-item earnings. Prefers stored ACTUALS (synced/operator) and only estimates a money
// field that is still null — so an operator-corrected fee is never clobbered by an estimate.
export function computeEarnings(
  item: EarningsItem,
  feeModel: FeeModel,
  shippingModel: ShippingModel,
): EarningsCalc | null {
  if (item.salePrice == null) return null; // not earnings-ready
  const itemPrice = item.salePrice;
  // Buyer-paid shipping received. Unknown (never synced) counts as 0 income — we never
  // GUESS income; syncing fills the real number.
  const shippingIncome = round2(item.shippingCharged ?? 0);
  const revenue = round2(itemPrice + shippingIncome);

  const feesEstimated = item.marketplaceFees == null ? true : item.feesEstimated;
  // Estimated fees apply to the GROSS (eBay/Etsy/Mercari charge their percent on
  // item + shipping); synced actuals already are whatever the marketplace charged.
  const fees = item.marketplaceFees != null
    ? item.marketplaceFees
    : estimateFees(revenue, item.platformSold, feeModel);

  const shippingEstimated = item.shippingCost == null ? true : item.shippingEstimated;
  const shipping = item.shippingCost != null
    ? item.shippingCost
    : estimateShipping(item.weightOz, shippingModel, item.platformSold);
  const shippingProfit = round2(shippingIncome - shipping);

  const revenueAfterFees = round2(revenue - fees - shipping);
  const costMissing = item.itemCost == null;
  const netProfit = costMissing ? null : round2(revenueAfterFees - (item.itemCost as number));
  const marginPct = netProfit != null && revenue > 0 ? round2((netProfit / revenue) * 100) : null;

  return {
    itemPrice, shippingIncome, revenue, fees, feesEstimated, shipping, shippingEstimated,
    shippingProfit, itemCost: item.itemCost, costMissing, revenueAfterFees, netProfit, marginPct,
  };
}

export interface EarningsTotals {
  count: number;              // sold items summarized
  revenue: number;            // GROSS (item prices + shipping income)
  itemPriceTotal: number;     // item prices alone
  shippingIncome: number;     // buyer-paid shipping received
  shippingProfit: number;     // shipping income − label costs (can be negative)
  fees: number;
  shipping: number;           // label costs
  cogs: number;               // sum of KNOWN item costs (cost-of-goods-sold)
  costMissingCount: number;   // items with no cost entered
  netProfit: number;          // sum of net over items WITH a cost (others excluded)
  revenueAfterFees: number;   // sum across all (cost-independent)
  marginPct: number | null;   // netProfit / revenue(of costed items) * 100
}

const DAY = 86400000;

// ---- Report aggregation (the four Earnings views, §30.4) — PURE so it's unit-testable
// without the DB. The API route does the prisma queries and passes the rows in. ----
export interface SoldRow extends EarningsItem { id: number; sku: string; itemType: string | null; dateSold: Date | null }
export interface TimingRow { dateSold: Date | null; dateListed: Date | null; createdAt: Date }
export interface OpenRow { sku: string; itemType: string | null; listedPrice: number | null; dateListed: Date | null; createdAt: Date }

export interface EarningsReport {
  totals: EarningsTotals;
  overTime: { period: string; revenue: number; netProfit: number; count: number }[];
  salesSeries: SalesSeries;
  byPlatform: { platform: string; count: number; revenue: number; fees: number;
    shippingIncome: number; shippingProfit: number; netProfit: number | null }[];
  sellThrough: {
    avgDaysToSell: number | null; listedCount: number; soldCount: number;
    openCount: number;
    sellThroughPct: number | null;
    aged: { sku: string; itemType: string | null; listedPrice: number | null; daysListed: number }[];
  };
  soldItems: {
    id: number; sku: string; itemType: string | null; platform: string; dateSold: string | null;
    itemPrice: number; shippingIncome: number; shippingProfit: number;
    revenue: number; fees: number; shipping: number; itemCost: number | null; costMissing: boolean;
    // Always computable "what this sale banked before item cost" — shown in the Net
    // column while the cost is still blank, so an uncosted sale is never just "—".
    revenueAfterFees: number;
    netProfit: number | null; marginPct: number | null; feesEstimated: boolean; shippingEstimated: boolean;
  }[];
}

// ---- Sales-count series for the Earnings chart: how many items sold per bucket,
// ZERO-FILLED across the whole range so quiet days show as gaps, not missing bars.
// Fixed ranges (7/30/90 days) bucket by DAY; Lifetime auto-buckets by the span
// (≤120 days → day, ≤550 → week, else month) so the chart stays readable. ----
export interface SalesSeries {
  bucket: "day" | "week" | "month";
  points: { date: string; count: number }[];   // date = local YYYY-MM-DD (bucket start) / YYYY-MM
}

const localYMD = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function bucketKey(d: Date, bucket: SalesSeries["bucket"]): string {
  if (bucket === "month") return localYMD(d).slice(0, 7);
  if (bucket === "week") {
    const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()); // week starts Sunday
    return localYMD(ws);
  }
  return localYMD(d);
}

export function buildSalesSeries(
  soldDates: (Date | null)[], fromMs: number | null, nowMs: number,
): SalesSeries {
  const dates = soldDates.filter((d): d is Date => d != null);
  const startMs = fromMs ?? (dates.length ? Math.min(...dates.map((d) => d.getTime())) : nowMs);
  const spanDays = Math.max(1, Math.ceil((nowMs - startMs) / DAY) + 1);
  const bucket: SalesSeries["bucket"] =
    fromMs != null || spanDays <= 120 ? "day" : spanDays <= 550 ? "week" : "month";

  // Zero-fill every bucket from the range start through today. Iterate from local
  // NOON so a DST hour shift can never skip or double a calendar day.
  const start = new Date(startMs);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
  const counts = new Map<string, number>();
  while (cursor.getTime() <= nowMs + DAY / 2) {
    const key = bucketKey(cursor, bucket);
    if (!counts.has(key)) counts.set(key, 0);
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const d of dates) {
    const key = bucketKey(d, bucket);
    if (counts.has(key)) counts.set(key, (counts.get(key) as number) + 1);
  }
  return { bucket, points: [...counts.entries()].map(([date, count]) => ({ date, count })) };
}

export function buildEarningsReport(
  sold: SoldRow[], timing: TimingRow[], open: OpenRow[], listedCount: number,
  feeModel: FeeModel, shippingModel: ShippingModel, nowMs: number,
  fromMs: number | null = null,
): EarningsReport {
  const calcs: EarningsCalc[] = [];
  const soldItems: EarningsReport["soldItems"] = [];
  for (const it of sold) {
    const c = computeEarnings(it, feeModel, shippingModel);
    if (!c) continue;
    calcs.push(c);
    soldItems.push({
      id: it.id, sku: it.sku, itemType: it.itemType, platform: it.platformSold ?? "Unknown",
      dateSold: it.dateSold ? it.dateSold.toISOString() : null,
      itemPrice: c.itemPrice, shippingIncome: c.shippingIncome, shippingProfit: c.shippingProfit,
      revenue: c.revenue, fees: c.fees, shipping: c.shipping, itemCost: c.itemCost,
      costMissing: c.costMissing, revenueAfterFees: c.revenueAfterFees,
      netProfit: c.netProfit, marginPct: c.marginPct,
      feesEstimated: c.feesEstimated, shippingEstimated: c.shippingEstimated,
    });
  }
  const totals = summarizeEarnings(calcs);

  // View 2: by month (YYYY-MM).
  const monthMap = new Map<string, { revenue: number; netProfit: number; count: number }>();
  for (const si of soldItems) {
    if (!si.dateSold) continue;
    const m = si.dateSold.slice(0, 7);
    const e = monthMap.get(m) ?? { revenue: 0, netProfit: 0, count: 0 };
    e.revenue += si.revenue;
    if (si.netProfit != null) e.netProfit += si.netProfit;
    e.count++;
    monthMap.set(m, e);
  }
  const overTime = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, v]) => ({ period, revenue: round2(v.revenue), netProfit: round2(v.netProfit), count: v.count }));

  // View 3: by platform (incl. the shipping economics — Depop/eBay shipping profit
  // vs Poshmark's closed loop is exactly what this view is for).
  const platMap = new Map<string, { count: number; revenue: number; fees: number;
    shipIn: number; shipProfit: number; net: number; costed: number }>();
  for (const si of soldItems) {
    const p = si.platform || "Unknown";
    const e = platMap.get(p) ?? { count: 0, revenue: 0, fees: 0, shipIn: 0, shipProfit: 0, net: 0, costed: 0 };
    e.count++; e.revenue += si.revenue; e.fees += si.fees;
    e.shipIn += si.shippingIncome; e.shipProfit += si.shippingProfit;
    if (si.netProfit != null) { e.net += si.netProfit; e.costed++; }
    platMap.set(p, e);
  }
  const byPlatform = [...platMap.entries()].sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([platform, v]) => ({
      platform, count: v.count, revenue: round2(v.revenue), fees: round2(v.fees),
      shippingIncome: round2(v.shipIn), shippingProfit: round2(v.shipProfit),
      netProfit: v.costed > 0 ? round2(v.net) : null,
    }));

  // View 4: sell-through + aged.
  let daysSum = 0, daysN = 0;
  for (const s of timing) {
    const start = s.dateListed ?? s.createdAt;
    if (s.dateSold && start) { daysSum += (s.dateSold.getTime() - start.getTime()) / DAY; daysN++; }
  }
  const aged = open.map((o) => {
    const start = o.dateListed ?? o.createdAt;
    return { sku: o.sku, itemType: o.itemType, listedPrice: o.listedPrice, daysListed: Math.max(0, Math.round((nowMs - start.getTime()) / DAY)) };
  }).sort((a, b) => b.daysListed - a.daysListed).slice(0, 25);
  const sellThrough = {
    avgDaysToSell: daysN ? Math.round(daysSum / daysN) : null,
    listedCount, soldCount: timing.length, openCount: open.length,
    sellThroughPct: listedCount > 0 ? round2((timing.length / listedCount) * 100) : null,
    aged,
  };

  const salesSeries = buildSalesSeries(sold.map((s) => s.dateSold), fromMs, nowMs);

  return { totals, overTime, salesSeries, byPlatform, sellThrough, soldItems };
}

// Roll up per-item calcs into headline totals. Net profit + margin only count items that
// HAVE a cost (so a missing cost can't silently understate profit); revenue/fees/shipping
// span every sold item.
export function summarizeEarnings(calcs: EarningsCalc[]): EarningsTotals {
  const t: EarningsTotals = {
    count: calcs.length, revenue: 0, itemPriceTotal: 0, shippingIncome: 0, shippingProfit: 0,
    fees: 0, shipping: 0, cogs: 0,
    costMissingCount: 0, netProfit: 0, revenueAfterFees: 0, marginPct: null,
  };
  let costedRevenue = 0;
  for (const c of calcs) {
    t.revenue += c.revenue;
    t.itemPriceTotal += c.itemPrice;
    t.shippingIncome += c.shippingIncome;
    t.shippingProfit += c.shippingProfit;
    t.fees += c.fees;
    t.shipping += c.shipping;
    t.revenueAfterFees += c.revenueAfterFees;
    if (c.costMissing || c.netProfit == null) {
      t.costMissingCount++;
    } else {
      t.cogs += c.itemCost as number;
      t.netProfit += c.netProfit;
      costedRevenue += c.revenue;
    }
  }
  t.revenue = round2(t.revenue);
  t.itemPriceTotal = round2(t.itemPriceTotal);
  t.shippingIncome = round2(t.shippingIncome);
  t.shippingProfit = round2(t.shippingProfit);
  t.fees = round2(t.fees);
  t.shipping = round2(t.shipping);
  t.cogs = round2(t.cogs);
  t.netProfit = round2(t.netProfit);
  t.revenueAfterFees = round2(t.revenueAfterFees);
  t.marginPct = costedRevenue > 0 ? round2((t.netProfit / costedRevenue) * 100) : null;
  return t;
}
