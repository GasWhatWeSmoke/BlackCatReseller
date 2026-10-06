import test from "node:test";
import assert from "node:assert/strict";
import { poshmarkPrice, poshmarkPublicationError, poshmarkValidate } from "./mapping.ts";
import { listingIdentity } from "../../attempts.ts";
import type { CanonicalListing } from "../../types.ts";

const listing = { title: "Reviewed shirt", price: 25, quantity: 1, condition: "Good", size: "M", department: "Men", photos: [{ path: "photo.jpg", name: "000001_01.jpg" }] } as CanonicalListing;
test("Poshmark preflight accepts approved cents and unisex rules but still enforces photo limits", () => {
  assert.deepEqual(poshmarkValidate(listing), []);
  const issues = poshmarkValidate({ ...listing, price: 8.99, department: "Unisex", photos: Array(17).fill(listing.photos[0]) });
  assert.deepEqual(new Set(issues.map((issue) => issue.field)), new Set(["photos"]));
});
test("reviewed boys jeans use the verified single-item path", () => {
  const boys = { ...listing, department: "Boys", itemType: "Jeans", size: "8" };
  assert.deepEqual(poshmarkValidate(boys), []);
  assert.ok(poshmarkValidate({ ...boys, department: "Kids" }).some(i => i.field === "department"));
  assert.ok(poshmarkValidate({ ...boys, itemType: "Shirt" }).some(i => i.field === "department"));
  assert.ok(poshmarkValidate({ ...boys, quantity: 2 }).some(i => i.field === "quantity"));
});

test("Poshmark rounds half dollars up without rewriting the shared listing", () => {
  for (const [price, expected] of [[24.99, 25], [24.49, 24], [24.5, 25], [25.5, 26], [25, 25]]) {
    assert.equal(poshmarkPrice(price), expected);
  }
  const canonical = { ...listing, price: 24.99, department: "Unisex Adults" };
  assert.deepEqual(poshmarkValidate(canonical), []);
  assert.equal(canonical.price, 24.99);
  assert.equal(canonical.department, "Unisex Adults");
  for (const price of [0, -1, 0.49, NaN, Infinity, 1e30]) {
    assert.equal(poshmarkPrice(price), null);
    assert.ok(poshmarkValidate({ ...listing, price }).some(issue => issue.field === "price"));
  }
  assert.ok(poshmarkValidate({ ...listing, department: "Kids" }).some(issue => issue.field === "department"));
});
test("Poshmark only permits retry after explicit proof of no final submission", () => {
  assert.equal(poshmarkPublicationError(null).notSubmitted, false);
  assert.equal(poshmarkPublicationError({ outcome: "failed", submissionStarted: true }).notSubmitted, false);
  assert.equal(poshmarkPublicationError({ outcome: "failed", submissionStarted: false }).notSubmitted, true);
  assert.equal(poshmarkPublicationError({ outcome: "filled", submissionStarted: false }).notSubmitted, true);
  assert.equal(poshmarkPublicationError({ outcome: "posted", submissionStarted: false }).notSubmitted, false);
});
test("Poshmark listing identity survives a title/slug change", () => {
  const old = listingIdentity("poshmark", "https://poshmark.com/listing/old-title-abcdef123456789012345678");
  const updated = listingIdentity("poshmark", "https://poshmark.com/listing/new-title-abcdef123456789012345678");
  assert.equal(old?.id, "abcdef123456789012345678");
  assert.equal(updated?.id, old?.id);
  assert.equal(listingIdentity("poshmark", "https://poshmark.com/listing/abcdef123456789012345678")?.id, old?.id);
});

test("Poshmark accepts supported positive quantities and blocks invalid stock counts", () => {
  assert.deepEqual(poshmarkValidate({ ...listing, quantity: 2 }), []);
  for (const quantity of [0, -1, 1.5, 1000]) {
    assert.ok(poshmarkValidate({ ...listing, quantity }).some((issue) => issue.field === "quantity"));
  }
});
