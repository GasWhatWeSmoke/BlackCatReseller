import test from "node:test";
import assert from "node:assert/strict";
import { etsyValidate, etsyPublicationError } from "./mapping.ts";
import type { CanonicalListing } from "../../types.ts";

const listing = { title: "Reviewed tank", description: "Reviewed details", price: 24.99, quantity: 1,
  trueVintage: true, whenMade: "1990s (Vintage)", department: "Women", itemType: "Tank Top", size: "L",
  weightOz: 12, packageDims: { length: 12, width: 9, height: 2 }, photos: [{ path: "photo.jpg", name: "000001_01.jpg" }] } as CanonicalListing;

test("Etsy accepts reviewed vintage clothing but never infers age from material or title", () => {
  assert.deepEqual(etsyValidate(listing), []);
  const issues = etsyValidate({ ...listing, trueVintage: false, title: "Vintage wool tank", material: "100% Wool" });
  assert.ok(issues.some(issue => issue.field === "trueVintage"));
  assert.ok(etsyValidate({ ...listing, whenMade: null }).some(issue => issue.field === "trueVintage"));
});

test("Etsy blocks invalid stock, photos, categories, pricing and shipping before opening a browser", () => {
  const issues = etsyValidate({ ...listing, quantity: 2, price: 24.999, photos: [], department: "Kids", itemType: "Unknown", weightOz: 0 });
  assert.deepEqual(new Set(issues.map(issue => issue.field)), new Set(["quantity", "price", "photos", "department", "itemType", "shipping"]));
  assert.ok(etsyValidate({ ...listing, photos: Array(21).fill(listing.photos[0]) }).some(issue => issue.field === "photos"));
});

test("Etsy accepts the long-sleeve T-shirt type supported by its native category mapping", () => {
  assert.deepEqual(etsyValidate({ ...listing, itemType: "Long Sleeve T-shirt" }), []);
  assert.ok(etsyValidate({ ...listing, itemType: "Unknown T-shirt accessory" }).some(issue => issue.field === "itemType"));
});

test("Etsy only releases a publication reservation after explicit proof of no submission", () => {
  assert.equal(etsyPublicationError(null).notSubmitted, false);
  assert.equal(etsyPublicationError({ outcome: "failed", submissionStarted: true }).notSubmitted, false);
  assert.equal(etsyPublicationError({ outcome: "failed", submissionStarted: false }).notSubmitted, true);
  assert.equal(etsyPublicationError({ outcome: "posted", submissionStarted: false }).notSubmitted, false);
});
