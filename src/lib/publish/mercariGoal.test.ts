import test from "node:test";
import assert from "node:assert/strict";
import { mercariGoal, mercariPostingBlock, validateMercariGoalPatch } from "./mercariGoal.ts";
const sold = (sku: string) => ({ id: Number(sku), sku, status: "Sold", niftyStatus: "Published", platformSold: "Mercari", marketplaceListings: [] });

test("Mercari progress counts confirmed current Mercari sales once and excludes refunds and other platforms", () => {
  const items = [sold("000044"), sold("000045"), { ...sold("000046"), platformSold: "eBay" }, { ...sold("000047"), status: "Ready" }];
  const result = mercariGoal({ blocked: true, confirmedSaleSkus: ["000044", "000044", "000046", "000047"] }, items);
  assert.equal(result.completed, 1); assert.equal(result.remaining, 4);
  assert.deepEqual(result.sales.map(sale => [sale.sku, sale.confirmed]), [["000044", true], ["000045", false]]);
  assert.equal(result.blocked, true);
});

test("five completed sales do not automatically lift a Mercari restriction", () => {
  const items = ["1", "2", "3", "4", "5"].map(sold);
  const limit = validateMercariGoalPatch({ blocked: true, confirmedSaleSkus: items.map(item => item.sku) }, items)!;
  const result = mercariGoal(limit, items);
  assert.equal(result.completed, 5); assert.equal(result.remaining, 0); assert.equal(result.blocked, true);
  assert.ok(mercariPostingBlock({ mercariListingLimit: limit }));
  const cleared = validateMercariGoalPatch({ ...limit, blocked: false }, items);
  assert.equal(mercariPostingBlock({ mercariListingLimit: cleared }), null);
});

test("Mercari goal rejects invented, duplicate-unlock, refunded or wrong-platform sales", () => {
  const items = [sold("000044"), { ...sold("000045"), platformSold: "Depop" }, { ...sold("000046"), status: "Ready" }];
  for (const skus of [["missing"], ["000045"], ["000046"]]) {
    assert.throws(() => validateMercariGoalPatch({ blocked: true, confirmedSaleSkus: skus }, items), /Only items/);
  }
  assert.throws(() => validateMercariGoalPatch({ blocked: false, confirmedSaleSkus: Array(5).fill("000044") }, items), /five/);
  for (const body of [null, [], {}, { blocked: "true", confirmedSaleSkus: [] }, { blocked: true, confirmedSaleSkus: [44] }]) {
    assert.throws(() => validateMercariGoalPatch(body, items));
  }
});
