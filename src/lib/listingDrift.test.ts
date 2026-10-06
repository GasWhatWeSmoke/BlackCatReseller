// Drift is only useful if it is quiet when nothing changed. A column that lights up
// on all 103 items — because whitespace differs, or because a field was never
// recorded — teaches the operator to ignore it, and then the one listing that really
// is stale gets ignored too.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDrift, samePrice, sameText, diffWords, pushWorthwhile,
  type LiveSnapshot,
} from "./listingDrift.ts";
import type { ExportCopy } from "./listingCopy.ts";

const copy = (over: Partial<ExportCopy> = {}): ExportCopy => ({
  autoTitle: "Quiksilver Mens Graphic Crewneck T-shirt Blue Print Size L",
  autoTitleKeyDetail: null,
  title: "Quiksilver Mens Graphic Crewneck T-shirt Blue Print Size L",
  description: "Quiksilver men's blue t-shirt with a graphic print. Size L.",
  category: "Men > Tops & Tees", publicNotes: "", whenMade: "2020 - 2026 (Recently)",
  sleeve: null, exportSize: "L", categoryGroup: "Clothing", collarCut: false,
  department: "Men", material: null, style: null, neckline: null, secondaryColor: null,
  fit: null, trueVintage: false, etsyEligible: "none", etsyAllowed: false, copyWarnings: [],
  ...over,
});

const live = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  niftyTitle: "Quiksilver Mens Graphic Crewneck T-shirt Blue Print Size L",
  niftyDescription: "Quiksilver men's blue t-shirt with a graphic print. Size L.",
  lastUploadPrice: 24.99, listedPrice: 24.99,
  ...over,
});

test("an unchanged listing reports no drift", () => {
  const d = computeDrift(live(), copy(), 24.99);
  assert.equal(d.hasDrift, false);
  assert.deepEqual(d.changedFields, []);
  assert.equal(pushWorthwhile(d), false);
});

test("the real case: a canonicalized brand makes the live title stale", () => {
  // Straight out of the database — the stored brand was fixed to "Mortal Kombat"
  // yesterday and the listing on Nifty still says "mortal combat".
  const d = computeDrift(
    live({ niftyTitle: "mortal combat Mens Graphic Crewneck T-shirt Black Blue Yellow Print Size M" }),
    copy({ title: "Mortal Kombat Mens Graphic Crewneck T-shirt Black Blue Yellow Print Size M" }),
    24.99,
  );
  assert.deepEqual(d.changedFields, ["title"]);
  assert.equal(pushWorthwhile(d), true);
});

test("a reprice is drift — this is the stale-price incident", () => {
  const d = computeDrift(live({ lastUploadPrice: 24.99, listedPrice: 34.99 }), copy(), 34.99);
  assert.deepEqual(d.changedFields, ["price"]);
  const price = d.fields.find((f) => f.field === "price")!;
  assert.equal(price.live, "$24.99");
  assert.equal(price.next, "$34.99");
});

test("a never-recorded field is UNKNOWN, not changed", () => {
  // niftyDescription arrived after 103 listings were already live. Calling that a
  // change would demand re-pushing every item on day one for nothing.
  const d = computeDrift(live({ niftyDescription: null }), copy(), 24.99);
  assert.equal(d.hasDrift, false);
  assert.deepEqual(d.unknownFields, ["description"]);
});

test("whitespace and line breaks are not drift", () => {
  const d = computeDrift(
    live({ niftyDescription: "Quiksilver men's blue t-shirt with a graphic print.\n\nSize L." }),
    copy({ description: "Quiksilver men's blue t-shirt with a graphic print.  Size L." }),
    24.99,
  );
  assert.equal(d.hasDrift, false);
});

test("case IS drift — a title fix is usually a capitalization fix", () => {
  const d = computeDrift(live({ niftyTitle: "2pac Unisex Graphic Tee" }), copy({ title: "2Pac Unisex Graphic Tee" }), 24.99);
  assert.deepEqual(d.changedFields, ["title"]);
});

test("floating-point cents are the same price", () => {
  assert.equal(samePrice(34.99, 34.990000000000002), true);
  assert.equal(samePrice(34.99, 34.98), false);
  assert.equal(samePrice(null, null), true);
  assert.equal(samePrice(null, 10), false);
});

test("sameText ignores surrounding and repeated whitespace only", () => {
  assert.equal(sameText("  a  b ", "a b"), true);
  assert.equal(sameText("a b", "a c"), false);
  assert.equal(sameText(null, ""), true);
});

test("a price that was never uploaded cannot be compared", () => {
  const d = computeDrift(live({ lastUploadPrice: null, listedPrice: null }), copy(), 19.99);
  assert.ok(d.unknownFields.includes("price"));
  assert.equal(d.hasDrift, false);
});

test("the word diff shows the substitution, not two whole titles", () => {
  const ops = diffWords("OP Mens Colorblock Baggy Shorts", "Ocean Pacific Mens Colorblock Baggy Shorts");
  assert.deepEqual(ops, [
    { type: "remove", text: "OP" },
    { type: "add", text: "Ocean Pacific" },
    { type: "same", text: "Mens Colorblock Baggy Shorts" },
  ]);
});

test("the word diff shows an inserted word in place", () => {
  const ops = diffWords("Ghost Unisex Graphic T-shirt Black", "Ghost Unisex Graphic Crewneck T-shirt Black");
  assert.deepEqual(ops.map((o) => o.type), ["same", "add", "same"]);
  assert.equal(ops[1].text, "Crewneck");
});

test("the word diff renders a case-only change as the new spelling", () => {
  const ops = diffWords("mortal combat Mens Tee", "Mortal Kombat Mens Tee");
  assert.equal(ops.filter((o) => o.type !== "same").length > 0, true);
  // "mortal"/"Mortal" match case-insensitively and render as the NEW casing, because
  // that is what will be on Nifty after the push.
  assert.equal(ops[0].text, "Mortal");
});

test("an identical title diffs to a single unchanged run", () => {
  const ops = diffWords("Same Title Here", "Same Title Here");
  assert.deepEqual(ops, [{ type: "same", text: "Same Title Here" }]);
});

test("diffing against an empty live title is all additions", () => {
  const ops = diffWords("", "Brand New Title");
  assert.deepEqual(ops, [{ type: "add", text: "Brand New Title" }]);
});
