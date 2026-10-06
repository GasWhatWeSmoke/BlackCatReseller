/** Lifetime money received from sold inventory, counted once per item. Never
 * substitute a listing price or estimated shipping for missing sale income. */
export function dashboardSales(items: { salePrice: number | null; shippingCharged: number | null }[]) {
  let salesCents = 0, shippingCents = 0, missingSalePrices = 0, missingShipping = 0;
  for (const item of items) {
    if (item.salePrice == null || !Number.isFinite(item.salePrice)) missingSalePrices++;
    else salesCents += Math.round(item.salePrice * 100);
    if (item.shippingCharged == null || !Number.isFinite(item.shippingCharged)) missingShipping++;
    else shippingCents += Math.round(item.shippingCharged * 100);
  }
  return { totalEarned: (salesCents + shippingCents) / 100, itemSales: salesCents / 100,
    shippingReceived: shippingCents / 100, itemsSold: items.length, missingSalePrices, missingShipping };
}

/** Item-price average excludes shipping and sales with no recorded price. Zero is a recorded price. */
export function averageItemSalePrice(sales: { itemSales: number; itemsSold: number; missingSalePrices: number }): number | null {
  const priced = sales.itemsSold - sales.missingSalePrices;
  return priced > 0 ? Math.round(sales.itemSales * 100 / priced) / 100 : null;
}

/** Known stock values are partial sums; missing inputs never become zero-valued items. */
export function recordedStockValue(items: number, recorded: number, sum: number | null) {
  if (!Number.isSafeInteger(items) || items < 0 || !Number.isSafeInteger(recorded) || recorded < 0 || recorded > items ||
      recorded > 0 && (sum === null || !Number.isFinite(sum) || sum < 0)) throw Error('Stock values could not be calculated.');
  return { knownTotal: recorded === 0 && items > 0 ? null : Math.round((sum ?? 0) * 100) / 100, recorded, missing: items - recorded };
}
