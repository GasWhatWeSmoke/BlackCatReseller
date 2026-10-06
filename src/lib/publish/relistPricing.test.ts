import test from "node:test";
import assert from "node:assert/strict";
import { applyRelistPrice } from "./relistPricing.ts";
import type { CanonicalListing } from "./types.ts";

const copy = { price: 44.99, title: "Reviewed Bugs Bunny shirt" } as CanonicalListing;

test("relisting can preserve different platform prices without changing the shared item", () => {
  const ebay = applyRelistPrice(copy, { status: "ended", price: 31.49 }, "preserve_marketplace");
  const poshmark = applyRelistPrice(copy, { status: "ended", price: 45 }, "preserve_marketplace");
  assert.equal(ebay.price, 31.49); assert.equal(poshmark.price, 45);
  assert.equal(copy.price, 44.99); assert.equal(ebay.title, copy.title);
});

test("new items and reviewed-price mode retain the reviewed price", () => {
  assert.equal(applyRelistPrice(copy, null, "preserve_marketplace"), copy);
  assert.equal(applyRelistPrice(copy, { status: "not_published", price: null }, "preserve_marketplace"), copy);
  assert.equal(applyRelistPrice(copy, { status: "ended", price: 31.49 }, "reviewed"), copy);
});

test("a missing or invalid prior price cannot silently reprice a preserved relisting", () => {
  for (const price of [null, 0, -1, NaN, Infinity, 31.491]) {
    assert.throws(() => applyRelistPrice(copy, { status: "ended", price }, "preserve_marketplace"), /Verify this marketplace's previous price/);
  }
});
