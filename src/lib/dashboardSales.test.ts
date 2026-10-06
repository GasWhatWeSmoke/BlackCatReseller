import test from "node:test";
import assert from "node:assert/strict";
import { dashboardSales, averageItemSalePrice, recordedStockValue } from "./dashboardSales.ts";

test("lifetime total includes item sales and shipping received in whole cents", () => {
  const totals = dashboardSales([{ salePrice: 24.99, shippingCharged: 5.5 }, { salePrice: 10.01, shippingCharged: 0 }]);
  assert.equal(totals.totalEarned, 40.5); assert.equal(totals.itemSales, 35);
  assert.equal(totals.shippingReceived, 5.5); assert.equal(totals.itemsSold, 2);
});
test("unknown sale amounts are visible instead of guessed from listing prices", () => {
  const totals = dashboardSales([{ salePrice: null, shippingCharged: null }, { salePrice: 20, shippingCharged: null }]);
  assert.equal(totals.totalEarned, 20); assert.equal(totals.itemsSold, 2);
  assert.equal(totals.missingSalePrices, 1); assert.equal(totals.missingShipping, 2);
  assert.equal(dashboardSales([]).totalEarned, 0);
});

test('average item sale price includes recorded zero, excludes missing prices and excludes shipping',()=>{
  const sales=dashboardSales([{salePrice:10,shippingCharged:90},{salePrice:0,shippingCharged:0},{salePrice:null,shippingCharged:30}]);
  assert.equal(averageItemSalePrice(sales),5);
  assert.equal(averageItemSalePrice(dashboardSales([])),null);
  assert.equal(averageItemSalePrice(dashboardSales([{salePrice:null,shippingCharged:20}])),null);
  assert.equal(averageItemSalePrice(dashboardSales([{salePrice:0,shippingCharged:20}])),0);
  assert.equal(averageItemSalePrice(dashboardSales([{salePrice:10,shippingCharged:0},{salePrice:10,shippingCharged:0},{salePrice:11,shippingCharged:0}])),10.33);
});

test('stock-value summaries distinguish known zero, partial amounts, missing inputs and empty stock',()=>{
  assert.deepEqual(recordedStockValue(3,2,0),{knownTotal:0,recorded:2,missing:1});
  assert.deepEqual(recordedStockValue(3,0,null),{knownTotal:null,recorded:0,missing:3});
  assert.deepEqual(recordedStockValue(0,0,null),{knownTotal:0,recorded:0,missing:0});
  assert.deepEqual(recordedStockValue(3,2,12.339),{knownTotal:12.34,recorded:2,missing:1});
  for(const [items,recorded,sum] of [[2,3,1],[2,1,null],[2,1,Infinity],[2,1,-1]] as const)assert.throws(()=>recordedStockValue(items,recorded,sum));
});
