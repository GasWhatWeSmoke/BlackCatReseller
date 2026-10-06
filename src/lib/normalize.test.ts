// The value of this layer is entirely in what it REFUSES to do. Applying an
// exact alias is easy; the tests that matter are the ones proving an almost-match
// is never applied and an unrecognized value is never damaged, because both of
// those failures reach a live listing looking confident.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKey,
  editDistance,
  normalizeValue,
  normalizeBrand,
  canonicalBrand,
  canonicalMaterial,
  canonicalColor,
  canonicalFit,
  detectSubBrand,
  canonicalNames,
  canonicalizeListingAttributes,
} from "./normalize.ts";

test("the two spec examples canonicalize", () => {
  assert.equal(canonicalBrand("Polo by Ralph Lauren"), "Polo Ralph Lauren");
  assert.equal(canonicalBrand("Levi Strauss & Co."), "Levi's");
});

test("the three spellings of Quiksilver in real inventory collapse to one", () => {
  // The database really did carry all three of these as separate brands.
  assert.equal(canonicalBrand("Quiksilver"), "Quiksilver");
  assert.equal(canonicalBrand("Quicksilver"), "Quiksilver");
  assert.equal(canonicalBrand("Quicksliver Quikjean"), "Quiksilver");
});

test("a near miss is suggested, never applied", () => {
  // OCR read these two strings off real tags. Rewriting them silently is how an
  // item gets confidently mislabelled, so the value is left alone.
  for (const misread of ["QLIKSILVER", "QUIKSILVAR"]) {
    const result = normalizeBrand(misread);
    assert.equal(result.value, misread, `${misread} must not be rewritten`);
    assert.equal(result.canonical, false);
    assert.equal(result.suggestion, "Quiksilver");
  }
});

test("the brand misread this was built for reaches its suggestion", () => {
  // Vision reported "Roast" for an item whose brand is "Roar".
  const result = normalizeBrand("Roast");
  assert.equal(result.value, "Roast");
  assert.equal(result.suggestion, "Roar");
});

test("unrecognized brands survive untouched", () => {
  // On a graphic tee the brand field legitimately holds the design or the act.
  for (const kept of [
    "Saint Pablo Tour Merch",
    "Authentic MARS ATTACKS No Signs Of Intelligent Life Here",
    "Get Lost Perv",
    "YES band shirt",
  ]) {
    const result = normalizeBrand(kept);
    assert.equal(result.value, kept);
    assert.equal(result.canonical, false);
    assert.equal(result.suggestion, undefined);
  }
});

test("whitespace is tidied even when nothing is recognized", () => {
  assert.equal(canonicalBrand("Grim Reaper  "), "Grim Reaper");
  assert.equal(canonicalBrand("  spaced   out  "), "spaced out");
});

test("empty and non-string input is safe", () => {
  for (const empty of ["", "   ", null, undefined, 42, {}]) {
    const result = normalizeValue("brand", empty);
    assert.equal(result.canonical, false);
    assert.equal(result.suggestion, undefined);
  }
  assert.equal(normalizeValue("brand", "").value, "");
});

test("a short brand is never fuzzy-matched", () => {
  // At four characters an edit distance of two is most of the word.
  const result = normalizeBrand("Vera");
  assert.equal(result.value, "Vera");
  assert.equal(result.suggestion, undefined);
});

test("known short brands still match exactly", () => {
  assert.equal(canonicalBrand("Gap"), "Gap");
  assert.equal(canonicalBrand("Vans"), "Vans");
  assert.equal(canonicalBrand("the gap"), "Gap");
});

test("normalizeKey folds apostrophes and punctuation", () => {
  assert.equal(normalizeKey("Levi's"), "levis");
  assert.equal(normalizeKey("Levis"), "levis");
  assert.equal(normalizeKey("Levi Strauss & Co."), "levi strauss co");
  assert.equal(normalizeKey("Abercrombie & Fitch"), "abercrombie fitch");
});

test("editDistance is a real Levenshtein with an early bail-out", () => {
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("abc", "abd"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
  // Past the cap it reports "more than max" rather than the true distance.
  assert.ok(editDistance("abc", "xyzzyx", 2) > 2);
});

test("materials, colors and fits canonicalize", () => {
  assert.equal(canonicalMaterial("100% cotton"), "Cotton");
  assert.equal(canonicalMaterial("pleather"), "Faux Leather");
  assert.equal(canonicalColor("navy blue"), "Navy");
  assert.equal(canonicalColor("heather gray"), "Grey");
  assert.equal(canonicalFit("slim fit"), "Slim");
  assert.equal(canonicalFit("true to size"), "Regular");
});

test("sub-brands are detected but do not replace the brand", () => {
  assert.equal(detectSubBrand("Levi's", "Levi's Silver Tab 501"), "Silver Tab");
  assert.equal(detectSubBrand("Lee", "Lee Dungarees jacket"), "Dungarees");
  assert.equal(detectSubBrand("Levi's", "plain 501 jeans"), null);
  assert.equal(detectSubBrand("Nobody", "Silver Tab"), null);
  assert.equal(detectSubBrand("Levi's", null), null);
});

test("the table exposes its canonical names", () => {
  const brands = canonicalNames("brand");
  assert.ok(brands.includes("Levi's"));
  assert.ok(brands.includes("Quiksilver"));
  assert.ok(brands.length > 100, "the seed list should be substantial");
});

test("a canonical name is never displaced by another entry's alias", () => {
  // "Ralph Lauren" is its own brand and also appears inside Polo aliases.
  assert.equal(canonicalBrand("Ralph Lauren"), "Ralph Lauren");
  assert.equal(canonicalBrand("Polo Ralph Lauren"), "Polo Ralph Lauren");
});

test("canonicalizeListingAttributes fixes the fields a listing prints", () => {
  const out = canonicalizeListingAttributes({
    brand: "Quicksilver", color: "navy blue", secondaryColor: "heather gray",
    material: "100% cotton", fit: "slim fit", itemType: "Jacket", size: "L",
  });
  assert.equal(out.brand, "Quiksilver");
  assert.equal(out.color, "Navy");
  assert.equal(out.secondaryColor, "Grey");
  assert.equal(out.material, "Cotton");
  assert.equal(out.fit, "Slim");
  // Untouched fields survive verbatim.
  assert.equal(out.itemType, "Jacket");
  assert.equal(out.size, "L");
});

test("canonicalizeListingAttributes leaves unknowns and blanks alone", () => {
  const out = canonicalizeListingAttributes({
    brand: "Saint Pablo Tour Merch", color: "", material: null, fit: undefined,
  });
  assert.equal(out.brand, "Saint Pablo Tour Merch");
  assert.equal(out.color, "");
  assert.equal(out.material, null);
  assert.equal(out.fit, undefined);
});

import { canonicalizeListingAttributes as canonicalize, isRegistrationNumber } from "./normalize.ts";

test("a registration number off the label is never a style number", () => {
  for (const v of ["WPL 10167", "RN 12345", "CA 34567", "rn#12345", "WPL10167", "RN4 11965"]) {
    assert.equal(isRegistrationNumber(v), true, v);
  }
  for (const v of ["501-0000", "CK1234", "116", "WPL", "RN 12"]) {
    assert.equal(isRegistrationNumber(v), false, v);
  }
  const out = canonicalize({ brand: "Joseph & Lyman", model: "RN 12345", styleNumber: "WPL 10167" });
  assert.equal(out.model, null);
  assert.equal(out.styleNumber, null);
  assert.equal(canonicalize({ styleNumber: "501-0000" }).styleNumber, "501-0000");
});
