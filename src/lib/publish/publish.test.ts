// Direct marketplace publishing (§45) — the pure logic under test:
// eBay payload mapping, error classification, backoff, photo integrity.
// Everything here runs without a database, a network, or an eBay account.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EBAY_CONDITION, EBAY_TITLE_MAX, buildAspects, buildInventoryItemPayload,
  buildOfferPayload, categoryQuery, ebayDescriptionHtml, ebayTitle, ebayValidate,
} from "./adapters/ebay/mapping.ts";
import { classifyError, backoffMs } from "./errors.ts";
import { PublishError, type CanonicalListing } from "./types.ts";
import { listReadyPhotos } from "./canonical.ts";
import type { EbayPublishConfig } from "../types.ts";

const listing = (over: Partial<CanonicalListing> = {}): CanonicalListing => ({
  itemId: 1, sku: "000084",
  title: "NWT Ed Hardy Womens Colorblock Tattoo-print Shoulder Bag Pink Graphic Print",
  description: "Bold tattoo-print shoulder bag.\n\nMeasurements:\nWidth: 12 in",
  price: 49.99, condition: "New with tags",
  brand: "Ed Hardy", size: null, itemType: "Shoulder Bag", category: "Bags > Shoulder Bags",
  categoryGroup: "Bag", department: "Women", material: null, style: "Y2K",
  color: "Pink", secondaryColor: null, pattern: "Graphic", fit: null,
  model: null, styleNumber: null, countryOfOrigin: null, inseam: null,
  weightOz: 16, packageDims: { length: 14, width: 12, height: 6 },
  photos: [{ path: "C:/x/000084_01.jpg", name: "000084_01.jpg" }],
  quantity: 1,
  ...over,
});

const cfg = (over: Partial<EbayPublishConfig> = {}): EbayPublishConfig => ({
  enabled: true, env: "sandbox", clientId: "app", clientSecret: "cert", ruName: "ru",
  refreshToken: "tok", fulfillmentPolicyId: "F1", paymentPolicyId: "P1",
  returnPolicyId: "R1", merchantLocationKey: "LOC1",
  ...over,
});

// ---- titles -----------------------------------------------------------------

test("a title within eBay's 80 characters passes through untouched", () => {
  assert.equal(ebayTitle("Levi's 501 Jeans 32x30"), "Levi's 501 Jeans 32x30");
});

test("a long title is cut at a word boundary, never mid-word", () => {
  const long = "Vintage Carhartt Detroit Jacket Blanket Lined Distressed Workwear Union Made In USA Large Tall";
  const cut = ebayTitle(long);
  assert.ok(cut.length <= EBAY_TITLE_MAX, `length ${cut.length}`);
  assert.ok(!cut.endsWith(" "), "no trailing space");
  // The character AFTER the cut in the original must be part of a word we dropped
  // whole — verify the cut text is a prefix of the original ending at a space.
  assert.ok(long.startsWith(cut) && long[cut.length] === " ", "cut lands on a word boundary");
});

// ---- conditions -------------------------------------------------------------

test("every Black Cat condition maps to an eBay condition", () => {
  for (const c of ["New with tags", "New without tags", "Like new", "Good", "Fair", "Pre-owned"]) {
    assert.ok(EBAY_CONDITION[c], c);
  }
  assert.equal(EBAY_CONDITION["New with tags"], "NEW");
  assert.equal(EBAY_CONDITION["New without tags"], "NEW_OTHER");
});

// ---- aspects ----------------------------------------------------------------

test("aspects carry only real values — no empty or null aspect is ever sent", () => {
  const a = buildAspects(listing({ material: null, fit: null, model: null })) as Record<string, string[]>;
  assert.deepEqual(a.Brand, ["Ed Hardy"]);
  assert.deepEqual(a.Department, ["Women"]);
  assert.ok(!("Material" in a), "null material is absent, not empty");
  assert.ok(!("Fit" in a));
  for (const v of Object.values(a)) assert.ok(v[0].length > 0);
});

test("inseam becomes an aspect with units, only for items that have one", () => {
  const jeans = buildAspects(listing({ inseam: "32" })) as Record<string, string[]>;
  assert.deepEqual(jeans.Inseam, ["32 in"]);
  const bag = buildAspects(listing()) as Record<string, string[]>;
  assert.ok(!("Inseam" in bag));
});

// ---- payloads ---------------------------------------------------------------

test("the inventory item payload is complete: images, condition, quantity 1, weight in ounces", () => {
  const p = buildInventoryItemPayload(listing(), ["https://eps.ebay.com/1.jpg"]) as {
    product: { title: string; imageUrls: string[] };
    condition: string;
    availability: { shipToLocationAvailability: { quantity: number } };
    packageWeightAndSize: { weight: { value: number; unit: string } };
  };
  assert.equal(p.condition, "NEW");
  assert.deepEqual(p.product.imageUrls, ["https://eps.ebay.com/1.jpg"]);
  assert.equal(p.availability.shipToLocationAvailability.quantity, 1);
  assert.deepEqual(p.packageWeightAndSize.weight, { value: 16, unit: "OUNCE" });
});

test("the offer carries the configured policies, never hardcoded ones (§45.13)", () => {
  const p = buildOfferPayload(listing(), cfg(), "63869") as {
    sku: string; categoryId: string; pricingSummary: { price: { value: string; currency: string } };
    listingPolicies: Record<string, string>; merchantLocationKey: string;
  };
  assert.equal(p.sku, "000084");
  assert.equal(p.categoryId, "63869");
  assert.deepEqual(p.pricingSummary.price, { value: "49.99", currency: "USD" });
  assert.deepEqual(p.listingPolicies, { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" });
  assert.equal(p.merchantLocationKey, "LOC1");
});

test("descriptions render newlines as HTML and escape markup", () => {
  const html = ebayDescriptionHtml("Line one\nLine two\n\nPara <script>two</script>");
  assert.ok(html.includes("Line one<br>Line two"));
  assert.ok(html.includes("</p><p>"));
  assert.ok(!html.includes("<script>"), "raw HTML is escaped");
});

test("the category query is what a buyer would search, not the full title", () => {
  assert.equal(categoryQuery(listing()), "Women Ed Hardy Shoulder Bag");
  // An Unknown brand contributes nothing.
  assert.equal(categoryQuery(listing({ brand: "Unknown", department: null })), "Shoulder Bag");
});

// ---- eBay validation --------------------------------------------------------

test("missing policies are validation issues, not runtime failures (§45.10)", () => {
  const issues = ebayValidate(listing(), cfg({ fulfillmentPolicyId: undefined, merchantLocationKey: undefined }));
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.field === "ebay"));
});

test("a condition with no eBay mapping blocks before any network call", () => {
  const issues = ebayValidate(listing({ condition: "Salvage" }), cfg());
  assert.ok(issues.some((i) => i.field === "condition"));
});

test("a fully configured, clean listing has zero eBay issues", () => {
  assert.deepEqual(ebayValidate(listing(), cfg()), []);
});

// ---- error classification (§45.21) -----------------------------------------

test("a classified PublishError keeps its class", () => {
  const r = classifyError(new PublishError("eBay: invalid category", "requires_review"));
  assert.equal(r.errorClass, "requires_review");
});

test("transient network/rate errors retry; marketplace rejections go to review", () => {
  assert.equal(classifyError(new Error("fetch failed: ECONNRESET")).errorClass, "retryable");
  assert.equal(classifyError(new Error("HTTP 503 Service Unavailable")).errorClass, "retryable");
  assert.equal(classifyError(new Error("Too Many Requests (429)")).errorClass, "retryable");
  assert.equal(classifyError(new Error("eBay: missing required aspect Size")).errorClass, "requires_review");
  assert.equal(classifyError(new Error("eBay: The condition is not valid for this category")).errorClass, "requires_review");
});

test("an unrecognized error retries (with the attempt cap as the backstop), never parks 300 items", () => {
  assert.equal(classifyError(new Error("something odd happened")).errorClass, "retryable");
});

test("backoff doubles and caps at ten minutes", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(20), 600_000);
});

// ---- photo integrity (§45.12) ----------------------------------------------

test("only this SKU's photos are picked up; a stray file blocks nothing silently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-pub-"));
  const photosDir = path.join(dir, "listing_photos");
  fs.mkdirSync(photosDir);
  for (const f of ["000084_01.jpg", "000084_02.JPG", "000099_01.jpg", "000084_sku_marker.jpg", "notes.txt"]) {
    fs.writeFileSync(path.join(photosDir, f), "x");
  }
  const scan = listReadyPhotos(dir, "000084");
  assert.deepEqual(scan.photos.map((p) => p.name), ["000084_01.jpg", "000084_02.JPG"]);
  // The OTHER item's photo and the stray file are reported; the marker is expected.
  assert.deepEqual(scan.strays.sort(), ["000099_01.jpg", "notes.txt"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing ready folder is empty, not an exception", () => {
  const scan = listReadyPhotos(path.join(os.tmpdir(), "does-not-exist-bc"), "000001");
  assert.deepEqual(scan, { photos: [], strays: [] });
});

test("a SKU with regex metacharacters cannot break the photo filter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-pub-"));
  const photosDir = path.join(dir, "listing_photos");
  fs.mkdirSync(photosDir);
  fs.writeFileSync(path.join(photosDir, "FIX-1+2_01.jpg"), "x");
  const scan = listReadyPhotos(dir, "FIX-1+2");
  assert.equal(scan.photos.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
