import test from "node:test";
import assert from "node:assert/strict";
import { ebayBrowserValidate, ebayBrowserError, ebayTitle } from "./mapping.ts";
import type { CanonicalListing } from "../../types.ts";

const listing = { title: "Reviewed shirt", brand: "Brand", size: "L", color: "Blue", department: "Unisex Adults",
  price: 24.99, quantity: 1, condition: "Good", photos: [{ path: "photo.jpg", name: "000001_01.jpg" }] } as CanonicalListing;

test("outerwear needs its reviewed shell material without treating sweater vests as jackets", () => {
  for (const itemType of ["Jacket", "Coat", "Vest", "Bomber Jacket"]) {
    for (const material of [null, "", "Unknown"]) assert.ok(ebayBrowserValidate({ ...listing, itemType, material }).some(issue => issue.field === "material"));
    assert.deepEqual(ebayBrowserValidate({ ...listing, itemType, material: "Cotton" }), []);
  }
  assert.deepEqual(ebayBrowserValidate({ ...listing, itemType: "Sweater Vest", material: null }), []);
});
test("browser eBay preflight needs reviewed specifics and no API key configuration", () => {
  assert.deepEqual(ebayBrowserValidate(listing), []);
  const issues = ebayBrowserValidate({ ...listing, size: null, color: null, department: "Kids", quantity: 2 });
  assert.deepEqual(new Set(issues.map(issue => issue.field)), new Set(["size","color","department","quantity"]));
  assert.ok(ebayTitle("Reviewed detail ".repeat(20)).length <= 80);
});
test("an uncertain eBay final click is never automatically retried", () => {
  assert.equal(ebayBrowserError(null).notSubmitted, false);
  assert.equal(ebayBrowserError({ outcome: "failed", submissionStarted: true }).notSubmitted, false);
  assert.equal(ebayBrowserError({ outcome: "failed", submissionStarted: false }).notSubmitted, true);
});

test("only the observed category ambiguity before submission can use bounded queue retries", () => {
  const reason = "ValueError: eBay choice is ambiguous: Clothing, Shoes & Accessories";
  const safe = { outcome: "failed" as const, submissionStarted: false, reason };
  assert.equal(ebayBrowserError(safe).errorClass, "retryable");
  assert.equal(ebayBrowserError(safe).notSubmitted, true);
  for (const report of [
    { ...safe, submissionStarted: true },
    { ...safe, submissionStarted: undefined },
    { ...safe, url: "https://www.ebay.com/itm/123456789012" },
    { ...safe, url: "unrecognized-result" },
    { ...safe, outcome: "posted" as const },
    { ...safe, reason: "ValueError: eBay choice is ambiguous: Size" },
  ]) assert.equal(ebayBrowserError(report).errorClass, "requires_review");
});

test("reviewed boys jeans pass validation without admitting unknown child categories", () => {
  const boys = { ...listing, department: "Boys", itemType: "Jeans", size: "8", inseam: "23.5" };
  assert.deepEqual(ebayBrowserValidate(boys), []);
  assert.ok(ebayBrowserValidate({ ...boys, department: "Kids" }).some(i => i.field === "department"));
  assert.ok(ebayBrowserValidate({ ...boys, itemType: "Shirt" }).some(i => i.field === "department"));
  assert.ok(ebayBrowserValidate({ ...boys, size: "3T" }).some(i => i.field === "size"));
});

test("eBay jeans require an inseam measurement distinct from a tag size", () => {
  for (const inseam of [null, "", "29/9", "0", "unknown"]) {
    assert.ok(ebayBrowserValidate({ ...listing, itemType: "Jeans", size: "29", inseam }).some(issue => issue.field === "inseam"));
  }
  for (const inseam of ["31", "31 in", "33.5 inches"]) {
    assert.deepEqual(ebayBrowserValidate({ ...listing, itemType: "Jeans", size: "29", inseam }), []);
  }
});
