// The studio ruler ("Empire Model 403") can never reach a title, whatever the
// columns or aiRaw hold. Run with:  node --test src/lib/studioProps.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStudioPropBrand,
  isStudioPropCode,
  mentionsStudioProp,
  scrubStudioProps,
  stripStudioPropTokens,
} from "./studioProps.ts";
import { previewListingItem } from "./listingPreview.ts";
import { buildTitle } from "./listing.ts";

const RULER = /\b403\b|empir/i;

test("the ruler's print is recognised in every spelling it has arrived in", () => {
  for (const v of ["Empire", "Empiré", "EMPIRE", "Empire Brand", "empire level"]) {
    assert.equal(isStudioPropBrand(v), true, v);
  }
  for (const v of ["Model 403", "403", "MODEL403", "Empire Model 403", "Mordel 403"]) {
    assert.equal(isStudioPropCode(v), true, v);
  }
  for (const v of ["Empire logo on waistband", "Model 403 text on ruler", "Empiré", "A ruler shows the inseam"]) {
    assert.equal(mentionsStudioProp(v), true, v);
  }
});

test("a real brand, model, and silhouette are left alone", () => {
  assert.equal(isStudioPropBrand("Empire Waist Co"), false);
  assert.equal(isStudioPropBrand("Carhartt"), false);
  for (const v of ["501", "403-0000", "1403", "J97", "WPL 10167"]) {
    assert.equal(isStudioPropCode(v), false, v);
  }
  assert.equal(mentionsStudioProp("Empire waist"), false);
  assert.equal(mentionsStudioProp("Button Fly"), false);
  const real = { brand: "Carhartt", model: "Detroit Jacket", styleNumber: "J97", keyDetails: "Blanket Lined" };
  assert.deepEqual(scrubStudioProps(real), real);
});

test("a title built from a row the ruler got into never carries it", () => {
  // Item 000126 as batch 39 stored it.
  const stored = {
    sku: "000126", brand: "Empire", model: "Model 403", styleNumber: null, itemType: "Jeans",
    color: "Blue", department: "Women", size: "10", fit: "Wide Leg",
    keyDetails: "Ultra Lowrise\nEmpire Brand\nModel 403",
    aiRaw: JSON.stringify({ brand: "Empiré", model: "Model 403", styleNumber: "403" }),
  };
  const title = buildTitle(previewListingItem(stored));
  assert.doesNotMatch(title, RULER, title);
  assert.match(title, /Ultra Lowrise/, "the real key detail still makes the title");

  // Empty columns fall back to aiRaw, which carries the same values.
  const fromRaw = buildTitle(previewListingItem({
    sku: "x", brand: null, model: null, styleNumber: null, itemType: "Jeans", color: "Blue",
    aiRaw: JSON.stringify({ brand: "Empire", model: "Model 403", styleNumber: "403", keyDetails: ["Model 403", "Button Fly"] }),
  }));
  assert.doesNotMatch(fromRaw, RULER, fromRaw);
  assert.match(fromRaw, /Button Fly/);
});

test("scrubbing a stored row keeps the list shape it was given", () => {
  const row = scrubStudioProps({
    brand: "Empire", subBrand: "Empiré", model: "403", styleNumber: "Model 403",
    keyDetails: "Wide Leg\nModel 403\nEmpire Brand",
  });
  assert.equal(row.brand, "Unknown");
  assert.equal(row.subBrand, null);
  assert.equal(row.model, null);
  assert.equal(row.styleNumber, null);
  assert.equal(row.keyDetails, "Wide Leg");
  const asArray = scrubStudioProps({ keyDetails: ["Wide Leg", "Model 403"] });
  assert.deepEqual(asArray.keyDetails, ["Wide Leg"]);
  assert.equal(scrubStudioProps({ keyDetails: "Model 403" }).keyDetails, null);
});

test("a stored public-notes line or custom title loses the ruler's tokens", () => {
  // Both are real public-notes lines batch 39 exported.
  assert.equal(
    stripStudioPropTokens("Abercrombie & Fitch Model 403 Womens Mini Shorts Olive Cargo Pockets Size 2"),
    "Abercrombie & Fitch Womens Mini Shorts Olive Cargo Pockets Size 2",
  );
  assert.equal(
    stripStudioPropTokens("Rocky Mountain 403 Unisex Vintage Cargo Denim Jeans Black Size 29"),
    "Rocky Mountain Unisex Vintage Cargo Denim Jeans Black Size 29",
  );
  assert.equal(stripStudioPropTokens("Empire Model 403 Unisex Corduroy Jeans Brown"), "Unisex Corduroy Jeans Brown");
  assert.equal(stripStudioPropTokens("Levi's 501 Mens Jeans"), "Levi's 501 Mens Jeans");
  assert.equal(stripStudioPropTokens(null), "");
  assert.equal(stripStudioPropTokens(""), "");
});
