// Pure-logic characterization tests for listing.ts (spec §28 / build step 7).
// These assert the function's ACTUAL CURRENT behavior (verified by running it),
// not an aspirational ideal. Run with:  node --test src/lib/listing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEASUREMENTS,
  measurementClause,
  measurementsFor,
  estimateWeightOz,
  estimateDims,
  needsInseam,
  isEtsyAllowed,
  ozToLb,
  ozToLbOz,
  cleanAttr,
  isVintage,
  assessTitle,
  buildTitle,
  buildTitleWithMeta,
  buildCategory,
  sanitizeDescription,
  isDescriptionWeak,
  marketingHits,
  desalesify,
  buildDescription,
  buildListing,
  type ListingItem, isNewWithTags } from "./listing.ts";

// Minimal item factory — every test overrides only what it needs.
function item(overrides: Partial<ListingItem> = {}): ListingItem {
  return {
    sku: "SKU1",
    brand: "Unknown",
    color: null,
    pattern: null,
    itemType: null,
    size: null,
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MEASUREMENTS (const shape)
// ---------------------------------------------------------------------------
test("MEASUREMENTS has 7 entries in a fixed order", () => {
  assert.equal(MEASUREMENTS.length, 7);
  assert.deepEqual(
    MEASUREMENTS.map((m) => m.key),
    ["chestIn", "lengthIn", "sleeveIn", "shoulderIn", "waistIn", "hipIn", "riseIn"],
  );
});

test("MEASUREMENTS entries carry key/label/word", () => {
  assert.deepEqual(MEASUREMENTS[0], { key: "chestIn", label: "Chest / Pit-to-Pit", word: "chest" });
  assert.deepEqual(
    MEASUREMENTS.map((m) => m.word),
    ["chest", "length", "sleeve", "shoulder", "waist", "hip", "rise"],
  );
  // Every entry is a non-empty string triple.
  for (const m of MEASUREMENTS) {
    assert.equal(typeof m.key, "string");
    assert.ok(m.key.length > 0);
    assert.ok(m.label.length > 0);
    assert.ok(m.word.length > 0);
  }
});

// ---------------------------------------------------------------------------
// measurementClause
// ---------------------------------------------------------------------------
test("measurementClause joins all set measurements with the inseam last", () => {
  assert.equal(
    measurementClause(item({ chestIn: "22", lengthIn: "28", inseam: "32" })),
    'Measures 22" chest, 28" length and 32" inseam laid flat.',
  );
});

test("measurementClause returns empty string when nothing is set", () => {
  assert.equal(measurementClause(item()), "");
});

test("measurementClause handles a single measurement (no list connector)", () => {
  assert.equal(measurementClause(item({ chestIn: "22" })), 'Measures 22" chest laid flat.');
});

test("measurementClause uses 'and' for exactly two parts", () => {
  assert.equal(
    measurementClause(item({ chestIn: "22", lengthIn: "28" })),
    'Measures 22" chest and 28" length laid flat.',
  );
});

test("measurementClause drops junk values like 'unknown'", () => {
  assert.equal(
    measurementClause(item({ chestIn: "unknown", lengthIn: "28" })),
    'Measures 28" length laid flat.',
  );
});

test("measurementClause includes inseam even when it is the only value", () => {
  assert.equal(measurementClause(item({ inseam: "30" })), 'Measures 30" inseam laid flat.');
});

// ---------------------------------------------------------------------------
// measurementsFor
// ---------------------------------------------------------------------------
test("measurementsFor(bottoms) returns waist/rise/hip/length in MEASUREMENTS order", () => {
  // NOTE: the function selects a key SET but returns them in MEASUREMENTS order
  // (lengthIn precedes waistIn/hipIn/riseIn), not the order listed in the impl.
  assert.deepEqual(measurementsFor("jeans").map((m) => m.key), [
    "lengthIn",
    "waistIn",
    "hipIn",
    "riseIn",
  ]);
});

test("measurementsFor(dress) returns chest/length/waist/hip", () => {
  assert.deepEqual(measurementsFor("dress").map((m) => m.key), [
    "chestIn",
    "lengthIn",
    "waistIn",
    "hipIn",
  ]);
});

test("measurementsFor(tops) returns chest/length/sleeve/shoulder", () => {
  assert.deepEqual(measurementsFor("hoodie").map((m) => m.key), [
    "chestIn",
    "lengthIn",
    "sleeveIn",
    "shoulderIn",
  ]);
  // Case-insensitive + substring match: "T-Shirt" is a top.
  assert.deepEqual(measurementsFor("T-Shirt").map((m) => m.key), [
    "chestIn",
    "lengthIn",
    "sleeveIn",
    "shoulderIn",
  ]);
});

test("measurementsFor(null/unknown) falls back to chest+length", () => {
  assert.deepEqual(measurementsFor(null).map((m) => m.key), ["chestIn", "lengthIn"]);
  assert.deepEqual(measurementsFor(undefined).map((m) => m.key), ["chestIn", "lengthIn"]);
  assert.deepEqual(measurementsFor("toga").map((m) => m.key), ["chestIn", "lengthIn"]);
  assert.deepEqual(measurementsFor("").map((m) => m.key), ["chestIn", "lengthIn"]);
});

// ---------------------------------------------------------------------------
// estimateWeightOz
// ---------------------------------------------------------------------------
test("estimateWeightOz maps known types (case/space-insensitive)", () => {
  assert.equal(estimateWeightOz("hoodie"), 22);
  assert.equal(estimateWeightOz(" Hoodie "), 22);
  assert.equal(estimateWeightOz("jacket"), 24);
  assert.equal(estimateWeightOz("t-shirt"), 6);
  assert.equal(estimateWeightOz("boots"), 48);
});

test("estimateWeightOz falls back to 12 for unknown/null", () => {
  assert.equal(estimateWeightOz("frockcoat"), 12);
  assert.equal(estimateWeightOz(null), 12);
  assert.equal(estimateWeightOz(""), 12);
});

// ---------------------------------------------------------------------------
// estimateDims
// ---------------------------------------------------------------------------
test("estimateDims returns the small mailer for light tops", () => {
  assert.deepEqual(estimateDims("t-shirt"), { length: 9, width: 6, height: 1 });
});

test("estimateDims returns the bulky mailer for hoodies/jackets", () => {
  assert.deepEqual(estimateDims("hoodie"), { length: 13, width: 10, height: 3 });
});

test("estimateDims returns the box for shoes/bags", () => {
  assert.deepEqual(estimateDims("shoes"), { length: 13, width: 10, height: 5 });
});

test("estimateDims defaults to the standard flat mailer for null/unknown", () => {
  assert.deepEqual(estimateDims(null), { length: 13, width: 10, height: 1 });
  assert.deepEqual(estimateDims("toga"), { length: 13, width: 10, height: 1 });
});

// ---------------------------------------------------------------------------
// needsInseam
// ---------------------------------------------------------------------------
test("needsInseam true for pants-type bottoms (substring match)", () => {
  assert.equal(needsInseam("jeans"), true);
  assert.equal(needsInseam("Cargo Pants"), true);
  assert.equal(needsInseam("joggers"), true);
  assert.equal(needsInseam("Leggings"), true);
});

test("needsInseam false for tops, shorts, skirts, null, empty", () => {
  assert.equal(needsInseam("shirt"), false);
  assert.equal(needsInseam("shorts"), false); // shorts not in INSEAM_TYPES
  assert.equal(needsInseam("skirt"), false);
  assert.equal(needsInseam(null), false);
  assert.equal(needsInseam(""), false);
});

// ---------------------------------------------------------------------------
// isEtsyAllowed
// ---------------------------------------------------------------------------
test("isEtsyAllowed trueVintage flag short-circuits to true", () => {
  assert.equal(isEtsyAllowed("none", null, true), true);
  assert.equal(isEtsyAllowed(null, "2020s", true), true);
});

test("isEtsyAllowed allows handmade/craft/party (case-insensitive)", () => {
  assert.equal(isEtsyAllowed("handmade", null), true);
  assert.equal(isEtsyAllowed("HANDMADE", null), true);
  assert.equal(isEtsyAllowed("craft", null), true);
  assert.equal(isEtsyAllowed("party", null), true);
});

test("isEtsyAllowed legacy 'vintage' requires a 20+ yr era", () => {
  assert.equal(isEtsyAllowed("vintage", "1990s"), true);
  assert.equal(isEtsyAllowed("vintage", "2010s"), false);
  assert.equal(isEtsyAllowed("vintage", null), false);
});

test("isEtsyAllowed denies none/null/unknown eligibility", () => {
  assert.equal(isEtsyAllowed("none", null), false);
  assert.equal(isEtsyAllowed(null, null), false);
  assert.equal(isEtsyAllowed(undefined, undefined), false);
  assert.equal(isEtsyAllowed("clothing", "1990s"), false);
});

// ---------------------------------------------------------------------------
// ozToLb / ozToLbOz
// ---------------------------------------------------------------------------
test("ozToLb returns pounds rounded to one decimal", () => {
  assert.equal(ozToLb(8), 0.5);
  assert.equal(ozToLb(24), 1.5);
  assert.equal(ozToLb(0), 0);
  assert.equal(ozToLb(16), 1);
  assert.equal(ozToLb(20), 1.3); // 1.25 -> 1.3 (round of 12.5/10)
});

test("ozToLbOz splits into whole lb + remainder oz", () => {
  assert.deepEqual(ozToLbOz(40), { lb: 2, oz: 8 });
  assert.deepEqual(ozToLbOz(15), { lb: 0, oz: 15 });
  assert.deepEqual(ozToLbOz(16), { lb: 1, oz: 0 });
  assert.deepEqual(ozToLbOz(0), { lb: 0, oz: 0 });
});

// ---------------------------------------------------------------------------
// cleanAttr
// ---------------------------------------------------------------------------
test("cleanAttr keeps real strings (trimmed)", () => {
  assert.equal(cleanAttr("Nylon"), "Nylon");
  assert.equal(cleanAttr(" Denim "), "Denim");
});

test("cleanAttr returns undefined for junk/empty/non-strings", () => {
  assert.equal(cleanAttr("unknown"), undefined);
  assert.equal(cleanAttr("No Brand"), undefined);
  assert.equal(cleanAttr("  "), undefined);
  assert.equal(cleanAttr(""), undefined);
  assert.equal(cleanAttr(null), undefined);
  assert.equal(cleanAttr(undefined), undefined);
  assert.equal(cleanAttr(42), undefined);
  assert.equal(cleanAttr({}), undefined);
});

// ---------------------------------------------------------------------------
// isVintage
// ---------------------------------------------------------------------------
test("isVintage true for decade eras 1920s-1990s", () => {
  assert.equal(isVintage("1990s"), true);
  assert.equal(isVintage("1980s"), true);
  assert.equal(isVintage("1920s"), true);
  // The \b19\d0s\b regex ALSO matches 1900s and 1910s (digit-0-then-0s).
  assert.equal(isVintage("1900s"), true);
  assert.equal(isVintage("1910s"), true);
});

test("isVintage true for 'before ...' and the 2000-2006 range", () => {
  assert.equal(isVintage("Before 2007"), true);
  assert.equal(isVintage("2000-2006"), true);
  assert.equal(isVintage("2000 - 2006"), true);
});

test("isVintage false for modern eras, empty, null", () => {
  assert.equal(isVintage("2000s"), false); // not a \d0s decade match, not in range
  assert.equal(isVintage("2010s"), false);
  assert.equal(isVintage(""), false);
  assert.equal(isVintage(null), false);
  assert.equal(isVintage(undefined), false);
});

// ---------------------------------------------------------------------------
// assessTitle
// ---------------------------------------------------------------------------
test("assessTitle passes a strong keyword-rich title", () => {
  assert.deepEqual(
    assessTitle("AKOO Sportswear Mens Colorblock Bomber Jacket Red Size L"),
    { ok: true, issues: [] },
  );
});

test("assessTitle flags too-short titles with too few keywords", () => {
  const r = assessTitle("Nike Tee");
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes("too short"));
  assert.ok(r.issues.includes("too few keywords"));
});

test("assessTitle flags a title containing 'unknown'", () => {
  const r = assessTitle("Unknown Brand Mens Cotton Crewneck Shirt Blue Size M");
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, ["contains 'unknown'"]);
});

test("assessTitle flags an over-80-char title", () => {
  const long =
    "Brand Mens Vintage Colorblock Bomber Jacket Red Blue Yellow Patches Embroidered Quilted Size XL";
  assert.ok(long.length > 80);
  const r = assessTitle(long);
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes("over 80 chars"));
});

test("assessTitle strips the 'Size ...' tail before counting keywords", () => {
  // 4 core words before "Size", >=20 chars -> ok despite being plain.
  assert.deepEqual(assessTitle("Long Brand Name Hoodie"), { ok: true, issues: [] });
});

// ---------------------------------------------------------------------------
// buildTitle
// ---------------------------------------------------------------------------
test("buildTitle orders brand/gender/pattern/style/type/colors/detail/size", () => {
  const it = item({
    brand: "AKOO",
    color: "Red",
    secondaryColor: "Blue",
    tertiaryColor: "Yellow",
    pattern: "Colorblock",
    itemType: "Jacket",
    style: "Bomber",
    department: "Men",
    keyDetails: ["Patches"],
    size: "L",
  });
  assert.equal(buildTitle(it), "AKOO Mens Colorblock Bomber Jacket Red Blue Yellow Patches Size L");
});

test("buildTitle never surfaces an Unknown brand", () => {
  const it = item({ brand: "Unknown", color: "Black", itemType: "Hoodie", size: "M" });
  const t = buildTitle(it);
  assert.equal(t, "Hoodie Black Size M");
  assert.ok(!/unknown/i.test(t));
});

test("buildTitle returns empty string when brand+type+size are all empty", () => {
  assert.equal(buildTitle(item()), "");
});

test("buildTitle anti-generic guard pulls in aesthetic + selling-point material only", () => {
  // Only Brand(empty)+Type+Size would survive, so aesthetic/material get appended —
  // but a GENERIC material ("Cotton") is not a search keyword and stays out.
  const generic = item({
    brand: "Unknown", pattern: "Solid", itemType: "Shirt", size: "M",
    aesthetic: ["streetwear"], material: "Cotton",
  });
  assert.equal(buildTitle(generic), "Shirt Streetwear Size M");
  // A specialty/100% material IS a selling point and gets pulled in.
  const specialty = item({
    brand: "Unknown", pattern: "Solid", itemType: "Shirt", size: "M",
    aesthetic: ["streetwear"], material: "100% Cotton",
  });
  // A stated "100% <fabric>" goes in as written, on the type (user rule, 2026-09-03).
  assert.equal(buildTitle(specialty), "100% Cotton Shirt Streetwear Size M");
});

test("buildTitle stays within eBay's 80-char limit, keeping brand/type/size", () => {
  const it = item({
    brand: "Patagonia Outdoor Gear",
    color: "Forest Green",
    secondaryColor: "Charcoal Gray",
    tertiaryColor: "Burnt Orange",
    pattern: "Colorblock",
    itemType: "Windbreaker Jacket",
    style: "Packable",
    department: "Women",
    whenMade: "1990s",
    keyDetails: ["Embroidered Logo"],
    fit: "Oversized",
    size: "XXL",
  });
  const t = buildTitle(it);
  assert.ok(t.length <= 80, `title length ${t.length} should be <= 80`);
  assert.ok(t.startsWith("Patagonia Outdoor Gear"));
  assert.ok(t.includes("Windbreaker Jacket"));
  assert.ok(t.endsWith("Size XXL"));
  assert.ok(t.includes("Vintage"));
});

test("buildTitle dedupes a style descriptor that restates the item type", () => {
  // style "Graphic Tee" + itemType "T-Shirt" -> keep just "Graphic".
  const it = item({ brand: "Unknown", style: "Graphic Tee", itemType: "T-Shirt", size: "L" });
  const t = buildTitle(it);
  assert.ok(t.includes("Graphic"));
  assert.ok(!/tee/i.test(t)); // garment noun dropped from the style
});

// ---------------------------------------------------------------------------
// buildCategory
// ---------------------------------------------------------------------------
test("buildCategory maps known item types (case-insensitive)", () => {
  assert.equal(buildCategory(item({ itemType: "t-shirt" })), "Tops & Tees");
  assert.equal(buildCategory(item({ itemType: "Hoodie" })), "Sweatshirts & Hoodies");
  assert.equal(buildCategory(item({ itemType: "jeans" })), "Jeans");
  assert.equal(buildCategory(item({ itemType: "jacket" })), "Coats & Jackets");
});

test("buildCategory NEVER echoes a raw itemType — an unmapped type falls back to its group", () => {
  // It used to return the itemType verbatim. That reads like a category but no
  // marketplace taxonomy contains it, so the upload assist typed a phrase that
  // matched no branch and left the listing on "Please select a subcategory".
  assert.equal(buildCategory(item({ itemType: "Poncho" })), "Clothing");
  assert.equal(buildCategory(item({ itemType: "Utility Kilt" })), "Clothing");
  // Non-clothing groups keep resolving to their own real branch.
  assert.equal(buildCategory(item({ itemType: "Hair Clip", category: "Accessory" })), "Accessories");
});

test("buildCategory maps the phrasings the vision model actually produces", () => {
  // Every one of these appeared verbatim on a real item and used to reach Nifty
  // as its own category.
  assert.equal(buildCategory(item({ itemType: "long sleeve button down" })), "Tops & Tees");
  assert.equal(buildCategory(item({ itemType: "Polo" })), "Tops & Tees");
  assert.equal(buildCategory(item({ itemType: "Button-up Shirt" })), "Tops & Tees");
  for (const [type, expected] of [
    ["Henley", "Tops & Tees"], ["Flannel", "Tops & Tees"], ["Tank Top", "Tops & Tees"],
    ["Cardigan", "Sweaters"], ["Blazer", "Coats & Jackets"], ["Bomber", "Coats & Jackets"],
    ["Windbreaker", "Coats & Jackets"], ["Joggers", "Pants"], ["Sweatpants", "Pants"],
    ["Chinos", "Pants"], ["Leggings", "Pants"], ["Romper", "Jumpsuits & Rompers"],
    ["Swim Trunks", "Shorts"],
  ] as const) {
    assert.equal(buildCategory(item({ itemType: type })), expected, type);
  }
});

test("buildCategory: a more specific word still wins over a generic one", () => {
  // "crewneck" alone is a tee, but a crewneck SWEATSHIRT is not.
  assert.equal(buildCategory(item({ itemType: "Crewneck Sweatshirt" })), "Sweatshirts & Hoodies");
  assert.equal(buildCategory(item({ itemType: "Crewneck" })), "Tops & Tees");
  assert.equal(buildCategory(item({ itemType: "Denim Jacket" })), "Coats & Jackets");
});

test("buildCategory falls back to 'Clothing' when itemType is null", () => {
  assert.equal(buildCategory(item({ itemType: null })), "Clothing");
});

// ---------------------------------------------------------------------------
// sanitizeDescription
// ---------------------------------------------------------------------------
test("sanitizeDescription collapses whitespace, strips 'Description:', capitalizes", () => {
  assert.equal(sanitizeDescription("Description: a nice   jacket."), "A nice jacket.");
});

test("sanitizeDescription removes AI disclaimers", () => {
  assert.equal(
    sanitizeDescription("As an AI, I cannot see. This is a blue jacket."),
    "This is a blue jacket.",
  );
});

test("sanitizeDescription scrubs unknown/unbranded/no brand", () => {
  assert.equal(sanitizeDescription("Unknown Brand jacket in blue."), "Jacket in blue.");
  assert.equal(sanitizeDescription("Unbranded blue shirt."), "Blue shirt.");
  assert.equal(sanitizeDescription("brand: unknown. nice shirt."), "Nice shirt.");
});

test("sanitizeDescription only capitalizes the FIRST letter, not each sentence", () => {
  // Characterization: "done" after the period stays lowercase here.
  assert.equal(
    sanitizeDescription("  multiple    spaces here . done ."),
    "Multiple spaces here. done.",
  );
});

test("sanitizeDescription returns empty string for empty/null", () => {
  assert.equal(sanitizeDescription(""), "");
  assert.equal(sanitizeDescription(null), "");
  assert.equal(sanitizeDescription(undefined), "");
});

// ---------------------------------------------------------------------------
// isDescriptionWeak
// ---------------------------------------------------------------------------
test("isDescriptionWeak true for empty/null/short", () => {
  assert.equal(isDescriptionWeak(""), true);
  assert.equal(isDescriptionWeak(null), true);
  assert.equal(isDescriptionWeak(undefined), true);
  assert.equal(isDescriptionWeak("Short."), true);
});

test("isDescriptionWeak true when fewer than 16 words OR under 100 chars", () => {
  const sixteenWords =
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
  // 16 words but under 100 chars -> still weak.
  assert.ok(sixteenWords.length < 100);
  assert.equal(isDescriptionWeak(sixteenWords), true);
});

test("isDescriptionWeak true when junk words remain after cleaning", () => {
  const withUnknown =
    "This is a long enough description with at least sixteen words present here for sure unknown right okay.";
  assert.equal(isDescriptionWeak(withUnknown), true);
});

test("isDescriptionWeak false for a long, clean, factual description", () => {
  const strong =
    "This is a perfectly normal factual description of a blue cotton jacket with many words exceeding the limit easily and a hundred characters long for the requirement.";
  assert.ok(strong.length >= 100);
  assert.equal(isDescriptionWeak(strong), false);
});

// ---------------------------------------------------------------------------
// marketingHits  (the heart of the anti-hype guarantee)
// ---------------------------------------------------------------------------
test("marketingHits detects 'perfect for'", () => {
  assert.deepEqual(marketingHits("This jacket is perfect for any occasion."), ["perfect for"]);
});

test("marketingHits detects 'elevate' / 'elevate your wardrobe'", () => {
  const hits = marketingHits("Elevate your wardrobe with this piece.");
  assert.ok(hits.includes("elevate"));
  assert.ok(hits.includes("elevate your wardrobe"));
});

test("marketingHits detects hype verbs like 'delivers'", () => {
  assert.deepEqual(marketingHits("Delivers a bold aesthetic that turns heads."), ["delivers"]);
});

test("marketingHits detects 'must-have' / wardrobe-staple phrasing", () => {
  const hits = marketingHits("A must-have wardrobe staple you've been searching for.");
  assert.ok(hits.includes("a must-have"));
  assert.ok(hits.some((h) => h.includes("wardrobe staple")));
});

test("marketingHits detects hype adjectives + slang (stunning/gorgeous/fire/vibes)", () => {
  const hits = marketingHits("A stunning gorgeous piece, fire vibes.");
  for (const w of ["stunning", "gorgeous", "fire", "vibes"]) assert.ok(hits.includes(w), w);
});

test("marketingHits returns [] for clean factual copy and empty input", () => {
  assert.deepEqual(marketingHits("Blue cotton jacket with a full zip front. Size L."), []);
  assert.deepEqual(marketingHits(""), []);
  assert.deepEqual(marketingHits(null), []);
});

test("marketingHits ODDITY: 'effortlessly' is NOT detected (only the bare 'effortless')", () => {
  // BUG/oddity: the detect regex uses \beffortless\b, so the common adverb
  // "effortlessly" slips past detection (though desalesify still strips it).
  assert.deepEqual(marketingHits("Effortlessly stylish jacket."), []);
  assert.deepEqual(marketingHits("This is effortless."), ["effortless"]);
});

// ---------------------------------------------------------------------------
// desalesify  (must strip hype + be idempotent)
// ---------------------------------------------------------------------------
test("desalesify drops a 'perfect for' CTA clause but keeps the fact", () => {
  assert.equal(desalesify("Blue cotton jacket, perfect for any occasion."), "Blue cotton jacket.");
});

test("desalesify strips the 'elevate your wardrobe with' lead-in", () => {
  assert.equal(
    desalesify("Elevate your wardrobe with this blue cotton jacket."),
    "This blue cotton jacket.",
  );
});

test("desalesify removes a 'must-have wardrobe staple...' hype span in place", () => {
  assert.equal(
    desalesify("This blue jacket has a full zip front, the must-have wardrobe staple you've been searching for."),
    "This blue jacket has a full zip front.",
  );
});

test("desalesify strips 'effortlessly' (softener) keeping the garment fact", () => {
  assert.equal(desalesify("Effortlessly stylish blue jacket with a zip front."),
    "Stylish blue jacket with a zip front.");
});

test("desalesify neutralizes hype verbs like 'delivers' to 'has'", () => {
  assert.equal(
    desalesify("This jacket delivers a bold aesthetic and a relaxed fit."),
    "This jacket has a bold aesthetic and a relaxed fit.",
  );
});

test("desalesify is decimal-safe (does not split 22.5 into a new sentence)", () => {
  assert.equal(
    desalesify("Measures 22.5 inches chest. Has a zip front."),
    "Measures 22.5 inches chest. Has a zip front.",
  );
});

test("desalesify capitalizes every resulting sentence", () => {
  assert.equal(
    desalesify("blue jacket. it has a zip front. size large."),
    "Blue jacket. It has a zip front. Size large.",
  );
});

test("desalesify returns empty string for empty/null", () => {
  assert.equal(desalesify(""), "");
  assert.equal(desalesify(null), "");
  assert.equal(desalesify(undefined), "");
});

test("desalesify is idempotent (running twice == running once)", () => {
  const heavy =
    "Elevate your wardrobe! This stunning must-have piece effortlessly turns heads. Perfect for any occasion. Blue cotton jacket with a full zip front.";
  const once = desalesify(heavy);
  const twice = desalesify(once);
  assert.equal(once, twice);
});

test("desalesify output of heavy copy has no detectable marketing hits", () => {
  const heavy =
    "Elevate your wardrobe! This stunning must-have piece effortlessly turns heads. Perfect for any occasion. Blue cotton jacket.";
  const cleaned = desalesify(heavy);
  // Characterization: residue "turns heads" survives the clause split, but it is
  // NOT one of the detectable marketing phrases, so marketingHits over the output
  // is empty — the export-facing guarantee.
  assert.deepEqual(marketingHits(cleaned), []);
});

// ---------------------------------------------------------------------------
// buildDescription  (factual, never salesy, never leaks Unknown)
// ---------------------------------------------------------------------------
test("buildDescription builds a full factual breakdown for a rich item", () => {
  const it = item({
    brand: "AKOO",
    color: "Red",
    secondaryColor: "Blue",
    tertiaryColor: "Yellow",
    pattern: "Colorblock",
    itemType: "Jacket",
    style: "Bomber",
    department: "Men",
    closure: "Full Zip",
    neckline: "Ribbed Collar",
    material: "100% Nylon",
    lining: "Quilted",
    graphics: ["'Racing' patch"],
    aesthetic: ["vintage racing"],
    fit: "Relaxed",
    chestIn: "22",
    lengthIn: "28",
    size: "L",
    notes: "Small stain on left cuff",
  });
  assert.equal(
    buildDescription(it),
    "AKOO men's bomber jacket in a red, blue and yellow colorblock design. " +
      "Features a full zip front, ribbed collar and 'Racing' patch. Made of 100% nylon. " +
      "Interior has a quilted lining. The jacket has a vintage racing look. Relaxed fit. " +
      'Measures 22" chest and 28" length laid flat. Small stain on left cuff. Size L.',
  );
});

test("buildDescription drops generic materials and generic construction details", () => {
  // Plain "Nylon" is not a selling point — no "Made of nylon." sentence; and vision's
  // "belt loops" style non-details never reach the copy.
  const it = item({
    brand: "Levi's", color: "Blue", itemType: "Jeans", material: "Cotton",
    graphics: ["belt loops", "embroidered back-pocket arcs"], size: "32x32",
  });
  const d = buildDescription(it);
  assert.ok(!/made of/i.test(d), `unexpected material sentence in: ${d}`);
  assert.ok(!/belt\s*loops/i.test(d), `belt loops leaked into: ${d}`);
  assert.ok(/embroidered back-pocket arcs/i.test(d), `real detail missing from: ${d}`);
  // 100%/specialty still passes the gate.
  assert.match(buildDescription(item({ color: "Gray", itemType: "Sweater", material: "100% Cashmere", size: "M" })), /made of 100% cashmere/i);
  assert.match(buildDescription(item({ color: "Brown", itemType: "Jacket", material: "Leather", size: "L" })), /made of leather/i);
});

test("buildDescription output contains no marketing hits", () => {
  const it = item({
    brand: "AKOO",
    color: "Red",
    secondaryColor: "Blue",
    pattern: "Colorblock",
    itemType: "Jacket",
    style: "Bomber",
    department: "Men",
    closure: "Full Zip",
    material: "Nylon",
    aesthetic: ["vintage racing"],
    size: "L",
  });
  assert.deepEqual(marketingHits(buildDescription(it)), []);
});

test("buildDescription never leaks 'Unknown' for a missing brand", () => {
  const d = buildDescription(item({ brand: "Unknown", color: "Black", pattern: "Solid", itemType: "Hoodie", size: "M" }));
  assert.equal(d, "Black hoodie. Size M.");
  assert.ok(!/unknown/i.test(d));
});

test("buildDescription falls back to 'piece' / 'Item' when type is missing", () => {
  assert.equal(buildDescription(item()), "Piece.");
});

test("buildDescription pluralizes 'have' for plural item types like jeans", () => {
  const d = buildDescription(item({ brand: "Levis", color: "Blue", itemType: "Jeans", size: "32", aesthetic: ["vintage"] }));
  assert.equal(d, "Levis blue jeans. The jeans have a vintage look. Size 32.");
});

test("buildDescription renders 2-color floral dress with pattern clause", () => {
  const d = buildDescription(item({ color: "Blue", secondaryColor: "White", pattern: "Floral", itemType: "Dress", size: "S" }));
  assert.equal(d, "Dress in blue and white with a floral pattern. Size S.");
});

test("buildDescription adds 'a graphic print' for a graphic pattern with no graphics list", () => {
  const d = buildDescription(item({ color: "White", pattern: "Graphic", itemType: "Tee", size: "L" }));
  assert.equal(d, "White tee with a graphic print. Size L.");
});

// ---------------------------------------------------------------------------
// buildListing
// ---------------------------------------------------------------------------
test("buildListing returns title/description/category/publicNotes", () => {
  const it = item({
    brand: "AKOO",
    color: "Red",
    secondaryColor: "Blue",
    tertiaryColor: "Yellow",
    pattern: "Colorblock",
    itemType: "Jacket",
    style: "Bomber",
    department: "Men",
    size: "L",
  });
  const c = buildListing(it);
  assert.deepEqual(Object.keys(c).sort(), ["category", "description", "publicNotes", "title"]);
  assert.equal(c.title, buildTitle(it));
  assert.equal(c.description, buildDescription(it));
  assert.equal(c.category, buildCategory(it));
  assert.equal(c.category, "Coats & Jackets");
  // publicNotes is a copy of the title (short public summary).
  assert.equal(c.publicNotes, c.title);
});

test("buildListing composes the three builders consistently", () => {
  const it = item({ brand: "Unknown", color: "Black", itemType: "Hoodie", size: "M" });
  const c = buildListing(it);
  assert.equal(c.title, "Hoodie Black Size M");
  assert.equal(c.category, "Sweatshirts & Hoodies");
  assert.ok(!/unknown/i.test(c.description));
  assert.ok(!/unknown/i.test(c.title));
});

// ===========================================================================
// HARDENING PASS — adversarial gap analysis (added cases).
// Every expected value below was confirmed by RUNNING the implementation.
// ===========================================================================

// ---- measurementsFor: classification overlaps + ordering -------------------
test("measurementsFor classifies bottoms via substring (cargo/shorts/skirt)", () => {
  // BOTTOM_TYPES is checked first; all return the bottoms key set in MEASUREMENTS order.
  for (const t of ["cargo", "shorts", "skirt", "cargo pants", "  JEANS  "]) {
    assert.deepEqual(measurementsFor(t).map((m) => m.key), ["lengthIn", "waistIn", "hipIn", "riseIn"], t);
  }
});

test("measurementsFor classifies dresses (romper/jumpsuit/sundress)", () => {
  for (const t of ["romper", "jumpsuit", "sundress"]) {
    assert.deepEqual(measurementsFor(t).map((m) => m.key), ["chestIn", "lengthIn", "waistIn", "hipIn"], t);
  }
});

test("measurementsFor: 'tank top' resolves to TOP (no 'tank'/'top' in BOTTOM list)", () => {
  // "top" substring is only in TOP_TYPES; BOTTOM is checked first but doesn't match.
  assert.deepEqual(measurementsFor("tank top").map((m) => m.key),
    ["chestIn", "lengthIn", "sleeveIn", "shoulderIn"]);
});

// ---- estimateWeightOz: keys that only exist in plural form -----------------
test("estimateWeightOz: 'chino' (singular) is NOT a key -> default 12", () => {
  // The map only has the plural "chinos"; singular falls through to the default.
  assert.equal(estimateWeightOz("chino"), 12);
  assert.equal(estimateWeightOz("chinos"), 16);
});

test("estimateWeightOz handles multi-word keys case/space-insensitively", () => {
  assert.equal(estimateWeightOz("LONG SLEEVE"), 9);
  assert.equal(estimateWeightOz("cami"), 4);
  assert.equal(estimateWeightOz("purse"), 16);
});

// ---- estimateDims: bulky/small/box buckets + null default ------------------
test("estimateDims: cardigan is bulky, belt/scarf are small, windbreaker/vest/sandals are flat mailer", () => {
  assert.deepEqual(estimateDims("cardigan"), { length: 13, width: 10, height: 3 });
  assert.deepEqual(estimateDims("belt"), { length: 9, width: 6, height: 1 });
  assert.deepEqual(estimateDims("scarf"), { length: 9, width: 6, height: 1 });
  assert.deepEqual(estimateDims("windbreaker"), { length: 13, width: 10, height: 1 });
  assert.deepEqual(estimateDims("vest"), { length: 13, width: 10, height: 1 });
  assert.deepEqual(estimateDims("sandals"), { length: 13, width: 10, height: 1 });
});

// ---- needsInseam: every substring trigger + casing ------------------------
test("needsInseam matches singular substrings (chino/cargo/trouser) case-insensitively", () => {
  assert.equal(needsInseam("chino"), true);     // INSEAM_TYPES has "chino" (no 's')
  assert.equal(needsInseam("Cargo"), true);
  assert.equal(needsInseam("trouser"), true);
  assert.equal(needsInseam("sweatpants"), true); // substring "sweatpant"
});

// ---- isEtsyAllowed: explicit false flag + mixed-case 'vintage' -------------
test("isEtsyAllowed: 'vintage' eligibility is case-insensitive and honors the era", () => {
  assert.equal(isEtsyAllowed("Vintage", "1990s"), true);
  assert.equal(isEtsyAllowed("vintage", "before 2007"), true);
  assert.equal(isEtsyAllowed("VINTAGE", "2015"), false); // not a vintage era
});

test("isEtsyAllowed: explicit trueVintage=false does not short-circuit; eligibility still applies", () => {
  assert.equal(isEtsyAllowed("handmade", null, false), true);
  assert.equal(isEtsyAllowed("none", null, false), false);
  assert.equal(isEtsyAllowed("PARTY", null), true); // case-insensitive
});

// ---- ozToLb: rounding boundaries (banker-ish round of *10) -----------------
test("ozToLb rounds (oz/16*10) to nearest int then /10", () => {
  assert.equal(ozToLb(4), 0.3);   // 0.25 -> round(2.5)=3 -> 0.3
  assert.equal(ozToLb(12), 0.8);  // 0.75 -> round(7.5)=8 -> 0.8
  assert.equal(ozToLb(1), 0.1);   // 0.0625 -> round(0.625)=1 -> 0.1
  assert.equal(ozToLb(40), 2.5);
});

test("ozToLb handles negative input (no clamping)", () => {
  assert.equal(ozToLb(-16), -1);
});

// ---- ozToLbOz: remainder branch -------------------------------------------
test("ozToLbOz returns non-zero lb AND non-zero oz remainder", () => {
  assert.deepEqual(ozToLbOz(20), { lb: 1, oz: 4 });
  assert.deepEqual(ozToLbOz(7), { lb: 0, oz: 7 });
});

// ---- cleanAttr: remaining JUNK_VALUES members ------------------------------
test("cleanAttr strips every JUNK_VALUES sentinel (undefined/null/not visible)", () => {
  assert.equal(cleanAttr("undefined"), undefined);
  assert.equal(cleanAttr("NULL"), undefined);
  assert.equal(cleanAttr("not visible"), undefined);
  assert.equal(cleanAttr("nil"), undefined);
  assert.equal(cleanAttr("not applicable"), undefined);
});

// ---- isVintage: regex corner cases ----------------------------------------
test("isVintage requires the trailing 's' on a decade and a 19x0 prefix", () => {
  assert.equal(isVintage("1995"), false);     // no trailing 's'
  assert.equal(isVintage("Mid 1990s"), true); // substring decade still matches
  assert.equal(isVintage("1890s"), false);    // 18xx, not 19xx
  assert.equal(isVintage("BEFORE 2000"), true);
  assert.equal(isVintage("2000 - 2006 era"), true); // surrounding text OK
});

// ---- assessTitle: exact length boundaries ---------------------------------
test("assessTitle: 20 chars + 4 words passes; 19 chars is 'too short'", () => {
  assert.deepEqual(assessTitle("AAAA BBBB CCCC DDDDD"), { ok: true, issues: [] }); // len 20
  const r = assessTitle("AAAA BBBB CCCC DDDD"); // len 19
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes("too short"));
});

test("assessTitle: exactly 80 chars is NOT over-length (only >80 is)", () => {
  const t80 = "A".repeat(80);
  assert.equal(t80.length, 80);
  assert.ok(!assessTitle(t80).issues.includes("over 80 chars"));
  const t81 = "A".repeat(81);
  assert.ok(assessTitle(t81).issues.includes("over 80 chars"));
});

// ---- buildTitle: gender precedence, pattern, fit, dedupe -------------------
test("isNewWithTags: matches the NWT family and never NWOT", () => {
  for (const yes of ["New with tags", "new with tags", "NWT", "nwt", "New With Tag",
                     "new w/ tags", "Brand new with tags"]) {
    assert.equal(isNewWithTags(yes), true, yes);
  }
  // NWOT is a different, weaker claim; stamping NWT on it would be a false one.
  for (const no of ["New without tags", "new without tags", "NWOT", "nwot",
                    "Like new", "Good", "Pre-owned", "", null, undefined]) {
    assert.equal(isNewWithTags(no), false, String(no));
  }
});

test("buildTitle: NWT leads the title when the condition says new with tags", () => {
  const base = { brand: "Nike", itemType: "Hoodie", color: "Black", size: "L" };
  const plain = buildTitle(item(base));
  const nwt = buildTitle(item({ ...base, condition: "New with tags" }));
  assert.equal(plain.includes("NWT"), false);
  assert.ok(nwt.startsWith("NWT "), nwt);
  // Everything else about the title is unchanged — NWT is purely additive.
  assert.equal(nwt, `NWT ${plain}`);
});

test("buildTitle: other conditions add nothing to the title", () => {
  const base = { brand: "Nike", itemType: "Hoodie", color: "Black", size: "L" };
  const plain = buildTitle(item(base));
  for (const c of ["New without tags", "Like new", "Good", "Fair", "Pre-owned"]) {
    assert.equal(buildTitle(item({ ...base, condition: c })), plain, c);
  }
});

test("buildListing: NWT reaches the exported title and public notes", () => {
  const it = item({ brand: "Nike", itemType: "Hoodie", color: "Black", size: "L",
                    condition: "New with tags" });
  const copy = buildListing(it);
  assert.ok(copy.title.startsWith("NWT "), copy.title);
  assert.equal(copy.title, buildTitle(it));
});

test("buildTitle: NWT survives trimming but never pushes past 80 chars", () => {
  const long = item({
    condition: "New with tags",
    brand: "Sportswear Company International", itemType: "Bomber Jacket",
    department: "Men", pattern: "Colorblock", style: "Varsity", fit: "Oversized",
    color: "Red", secondaryColor: "Blue", tertiaryColor: "Yellow",
    keyDetails: ["Embroidered Patches"], size: "XL",
  });
  const t = buildTitle(long);
  assert.ok(t.length <= 80, `${t.length}: ${t}`);
  assert.ok(t.includes("NWT"), t);
  // The pinned tokens still win.
  assert.ok(/Bomber Jacket/.test(t) && /Size XL/.test(t), t);
});

test("buildTitle: 'women' wins over the 'men' substring", () => {
  assert.equal(buildTitle(item({ brand: "Levis", itemType: "Jeans", department: "Women", size: "M" })),
    "Levis Womens Jeans Size M");
});

test("buildTitle: department boy/kid maps to 'Kids'", () => {
  assert.equal(buildTitle(item({ brand: "Gap", itemType: "Shirt", department: "Boys", color: "Red", size: "S" })),
    "Gap Kids Shirt Red Size S");
});

test("buildTitle: 'Multicolor' becomes 'Colorblock' only with 2+ colors", () => {
  assert.equal(buildTitle(item({ brand: "X", itemType: "Jacket", pattern: "Multicolor", color: "Red", secondaryColor: "Blue", size: "L" })),
    "X Colorblock Jacket Red Blue Size L");
  assert.equal(buildTitle(item({ brand: "X", itemType: "Jacket", pattern: "Multicolor", color: "Red", size: "L" })),
    "X Multicolor Jacket Red Size L");
});

test("buildTitle: a 'Regular' fit adds nothing and is dropped", () => {
  assert.equal(buildTitle(item({ brand: "X", itemType: "Shirt", fit: "Regular", color: "Blue", size: "M" })),
    "X Shirt Blue Size M");
  assert.equal(buildTitle(item({ brand: "X", itemType: "Shirt", fit: "Oversized", color: "Blue", size: "M" })),
    "X Shirt Blue Oversized Size M");
});

test("buildTitle: a keyDetail already in the title is not repeated", () => {
  assert.equal(buildTitle(item({ brand: "X", itemType: "Jacket", pattern: "Colorblock", color: "Red", keyDetails: ["Colorblock"], size: "L" })),
    "X Colorblock Jacket Red Size L");
});

test("buildTitle keeps a size value that already contains 'Size' (e.g. 'One Size')", () => {
  // A size that already includes the word "Size" must not be doubled ("Size One Size"),
  // which would dedupe to "Size One" and drop the suffix. It's emitted verbatim instead.
  assert.equal(buildTitle(item({ brand: "X", itemType: "Hat", color: "Black", size: "One Size" })),
    "X Hat Black One Size");
  // A plain size still gets the "Size " prefix.
  assert.equal(buildTitle(item({ brand: "X", itemType: "Hat", color: "Black", size: "OS" })),
    "X Hat Black Size OS");
});

test("buildTitle ODDITY: a brand containing the item-type word swallows the (pinned) type", () => {
  // "Jacket Co" already contains "Jacket", so dedupeWords removes the pinned item
  // type even though it is priority 100. The title no longer states the garment type.
  assert.equal(buildTitle(item({ brand: "Jacket Co", itemType: "Jacket", color: "Red", size: "L" })),
    "Jacket Co Red Size L");
});

test("buildTitle: a 20+yr era injects a 'Vintage' keyword", () => {
  assert.equal(buildTitle(item({ brand: "X", itemType: "Jacket", whenMade: "1980s", color: "Red", size: "L" })),
    "X Vintage Jacket Red Size L");
});

// ---- buildCategory: trimming + whitespace fallback -------------------------
test("buildCategory falls back to 'Clothing' for a whitespace-only or empty itemType", () => {
  // A whitespace-only itemType must not reach the listing as a blank category.
  assert.equal(buildCategory(item({ itemType: "  " })), "Clothing");
  assert.equal(buildCategory(item({ itemType: "" })), "Clothing");
});

// ---- sanitizeDescription: mid-sentence scrubs + edge inputs ----------------
test("sanitizeDescription strips an embedded 'no brand' leaving the surrounding words", () => {
  // Characterization: "no brand" is removed in place, leaving "This has visible, ...".
  assert.equal(sanitizeDescription("This has no brand visible, blue tee."),
    "This has visible, blue tee.");
});

test("sanitizeDescription: a string that is only 'unknown' becomes empty", () => {
  assert.equal(sanitizeDescription("unknown"), "");
});

test("sanitizeDescription removes a mid-string 'i am unable' disclaimer clause", () => {
  assert.equal(sanitizeDescription("I am unable to identify this. Red shirt."), "Red shirt.");
});

test("sanitizeDescription drops leading punctuation before capitalizing", () => {
  assert.equal(sanitizeDescription(",,, red shirt."), "Red shirt.");
});

// ---- isDescriptionWeak: the >=16 words AND >=100 chars boundary ------------
test("isDescriptionWeak: exactly 16 words and exactly 100+ chars is NOT weak", () => {
  const s = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papaXXXX";
  assert.equal(s.split(/\s+/).length, 16);
  assert.ok(s.length >= 100);
  assert.equal(isDescriptionWeak(s), false);
});

// ---- marketingHits: dedup, case-insensitivity, and SLIP-THROUGHs ----------
test("marketingHits dedupes repeated phrases and is case-insensitive", () => {
  assert.deepEqual(marketingHits("perfect for this, perfect for that."), ["perfect for"]);
  assert.deepEqual(marketingHits("PERFECT FOR everyone. STUNNING."), ["perfect for", "stunning"]);
});

test("marketingHits detects a spread of hype tokens (timeless/iconic/premium/eye-catching)", () => {
  assert.deepEqual(marketingHits("A timeless iconic look."), ["timeless", "iconic"]);
  assert.deepEqual(marketingHits("A coveted premium luxurious piece."), ["premium", "luxurious"]);
  assert.deepEqual(marketingHits("An eye-catching design."), ["eye-catching"]);
});

test("marketingHits BUG: 'buttery-soft'/'cozy'/'comfy' softeners are NOT detected", () => {
  // These appear in MARKETING_SOFTENERS (desalesify strips them) but are absent from
  // MARKETING_DETECT, so marketingHits — the export's copyWarnings source — misses them.
  assert.deepEqual(marketingHits("A buttery-soft cozy comfy hoodie."), []);
});

test("marketingHits BUG: common resale-slang hype slips past detection", () => {
  // "wardrobe essential" (only "wardrobe staple" is listed), "must own" (only
  // "must-have"), and slang like "drip"/"flex"/"steal" are not in MARKETING_DETECT.
  assert.deepEqual(marketingHits("The ultimate wardrobe essential."), []);
  assert.deepEqual(marketingHits("A must own for fall."), []);
  assert.deepEqual(marketingHits("This has serious drip."), []);
  assert.deepEqual(marketingHits("A real flex."), []);
  assert.deepEqual(marketingHits("What a steal at this price."), []);
});

// ---- desalesify: more spans, leadins, residue, idempotency -----------------
test("desalesify strips a 'buttery-soft/cozy/comfy' softener pileup", () => {
  assert.equal(desalesify("A buttery-soft cozy comfy hoodie."), "A hoodie.");
});

test("desalesify drops '... is pure fire' / 'are heat' hype, keeping the subject", () => {
  assert.equal(desalesify("This jacket is pure fire."), "This jacket.");
  assert.equal(desalesify("These boots are heat."), "These boots.");
});

test("desalesify removes 'comfortable and stylish' as a hype span", () => {
  // Characterization: a dangling comma is left ("hoodie, with").
  assert.equal(desalesify("Blue hoodie, comfortable and stylish, with a kangaroo pocket."),
    "Blue hoodie, with a kangaroo pocket.");
});

test("desalesify strips a leading 'Introducing the' lead-in and trailing CTA", () => {
  assert.equal(
    desalesify("Introducing the new collection. This blue jacket has a zip front. Don't miss out!"),
    "New collection. This blue jacket has a zip front.",
  );
});

test("desalesify ODDITY: 'this beauty' span removal can leave a dangling preposition", () => {
  // The HYPE_SPAN "this beauty" is removed in place, leaving "Check out with ...".
  assert.equal(desalesify("Check out this beauty with a zip front."), "Check out with a zip front.");
});

test("desalesify strips an 'add a pop of color with' lead-in, keeping the item", () => {
  assert.equal(desalesify("Add a pop of color with this red dress."), "This red dress.");
});

test("desalesify ODDITY: 'Your new obsession' collapses to a bare residue word", () => {
  // "your new ... obsession" is a HYPE_SPAN; what remains ("awaits") is kept and capitalized.
  assert.equal(desalesify("Your new obsession awaits."), "Awaits.");
});

test("desalesify wholly drops a hype-only sentence (main-character energy / levels up)", () => {
  assert.equal(desalesify("Has main-character energy."), "");
  assert.equal(desalesify("Levels up any outfit."), "");
  assert.equal(desalesify("Flatters every figure beautifully."), "");
});

test("desalesify protects a multi-decimal measurement from the sentence splitter", () => {
  // 3.5 must NOT split; "stunning" is removed leaving an actual residue we assert verbatim.
  assert.equal(desalesify("This jacket has a 3.5 inch collar and is stunning."),
    "This jacket has a 3.5 inch collar and.");
});

test("desalesify fixes a dangling article after an adjective is stripped", () => {
  // "An print" (no adjective to justify "an") is normalized to "A print".
  assert.equal(desalesify("An print on the front."), "A print on the front.");
});

test("desalesify is idempotent across a broad set of hype inputs", () => {
  for (const c of [
    "A buttery-soft cozy comfy hoodie.",
    "This jacket is pure fire.",
    "Has main-character energy.",
    "Your new obsession awaits.",
    "Grab yours before they sell out, trust me.",
    "Introducing the new collection. This blue jacket has a zip front. Don't miss out!",
  ]) {
    const once = desalesify(c);
    assert.equal(desalesify(once), once, c);
  }
});

// ---- buildDescription: closure/neckline/lining phrasing branches -----------
test("buildDescription phrases a Pullover closure as 'a pullover design'", () => {
  assert.equal(buildDescription(item({ brand: "Nike", color: "Black", itemType: "Hoodie", closure: "Pullover", size: "M" })),
    "Nike black hoodie. Features a pullover design. Size M.");
});

test("buildDescription phrases a 'Hooded' neckline as 'a hooded design'", () => {
  assert.equal(buildDescription(item({ color: "Gray", itemType: "Hoodie", neckline: "Hooded", size: "L" })),
    "Gray hoodie. Features a hooded design. Size L.");
});

test("buildDescription phrases back/side/fly closures distinctly", () => {
  assert.equal(buildDescription(item({ color: "Red", itemType: "Dress", closure: "Back Zip", size: "S" })),
    "Red dress. Features a back zip closure. Size S.");
  assert.equal(buildDescription(item({ color: "Blue", itemType: "Jeans", closure: "Button Fly", size: "32" })),
    "Blue jeans. Features a button fly. Size 32.");
});

test("buildDescription: lining containing 'lined' uses 'Interior is ...', else 'has a ... lining'", () => {
  assert.equal(buildDescription(item({ color: "Green", itemType: "Coat", lining: "Sherpa Lined", size: "L" })),
    "Green coat. Interior is sherpa lined. Size L.");
  assert.equal(buildDescription(item({ color: "Green", itemType: "Jacket", lining: "Quilted", size: "M" })),
    "Green jacket. Interior has a quilted lining. Size M.");
});

test("buildDescription renders a textile pattern as 'with a <pattern> pattern'", () => {
  assert.equal(buildDescription(item({ color: "Blue", secondaryColor: "White", pattern: "Striped", itemType: "Shirt", size: "M" })),
    "Shirt in blue and white with a striped pattern. Size M.");
});

test("buildDescription keeps graphics VERBATIM (quoted patch text, acronyms, casing)", () => {
  assert.equal(buildDescription(item({ color: "Black", itemType: "Tee", graphics: ["'NO RULS 1980'", "Y2K star"], size: "L" })),
    "Black tee. Features 'NO RULS 1980' and Y2K star. Size L.");
});

test("buildDescription: a 'graphic' pattern WITH a graphics list does not add 'a graphic print'", () => {
  assert.equal(buildDescription(item({ color: "White", pattern: "Graphic", itemType: "Tee", graphics: ["Skull print"], size: "L" })),
    "White tee. Features Skull print. Size L.");
});

test("buildDescription: a singular type ending in 'ss' uses 'has', plural types use 'have'", () => {
  assert.equal(buildDescription(item({ color: "Red", itemType: "Dress", aesthetic: ["chic"], size: "S" })),
    "Red dress. The dress has a chic look. Size S.");
  assert.equal(buildDescription(item({ color: "Brown", itemType: "Boots", aesthetic: ["rugged"], size: "10" })),
    "Brown boots. The boots have a rugged look. Size 10.");
});

test("buildDescription: a size value already containing 'size' avoids 'Size One Size'", () => {
  assert.equal(buildDescription(item({ color: "Black", itemType: "Hat", size: "One Size" })),
    "Black hat. One Size.");
});

test("buildDescription drops junk operator notes ('unknown')", () => {
  assert.equal(buildDescription(item({ color: "Blue", itemType: "Shirt", notes: "unknown", size: "M" })),
    "Blue shirt. Size M.");
});

// ---- measurementClause: all seven + inseam, and whitespace-only values -----
test("measurementClause joins all seven flat measurements plus inseam last", () => {
  assert.equal(
    measurementClause(item({ chestIn: "22", lengthIn: "28", sleeveIn: "24", shoulderIn: "18", waistIn: "30", hipIn: "40", riseIn: "10", inseam: "32" })),
    'Measures 22" chest, 28" length, 24" sleeve, 18" shoulder, 30" waist, 40" hip, 10" rise and 32" inseam laid flat.',
  );
});

test("measurementClause treats a whitespace-only value as unset", () => {
  assert.equal(measurementClause(item({ chestIn: "  ", lengthIn: "28" })),
    'Measures 28" length laid flat.');
});

// ---------------------------------------------------------------------------
// Accessories expansion (2026-08-05): category routing, size exemption,
// weight/dims/price estimates for bags / jewelry / hats / belts / scarves.
// ---------------------------------------------------------------------------
import { itemCategory, sizelessOk, autoOneSize, estimatePrice } from "./listing.ts";

test("itemCategory: explicit column wins and normalizes", () => {
  assert.equal(itemCategory("Bag", "T-Shirt"), "Bag");
  assert.equal(itemCategory("jewellery", null), "Jewelry");
  assert.equal(itemCategory("accessories", null), "Accessory");
  assert.equal(itemCategory("clothing", "Necklace"), "Clothing");
});

test("itemCategory: inferred from the specific itemType when no column", () => {
  assert.equal(itemCategory(null, "Crossbody Bag"), "Bag");
  assert.equal(itemCategory(null, "Necklace"), "Jewelry");
  assert.equal(itemCategory(null, "Bucket Hat"), "Hat");
  assert.equal(itemCategory(null, "Belt"), "Accessory");
  assert.equal(itemCategory(null, "Scarf"), "Accessory");
  assert.equal(itemCategory(null, "Sneakers"), "Shoes");
  assert.equal(itemCategory(null, "Hoodie"), "Clothing");
  assert.equal(itemCategory(null, null), "Clothing");
});

test("sizelessOk: accessories may pass the gate without a size; clothing/shoes may not", () => {
  for (const t of ["Handbag", "Necklace", "Ring", "Bucket Hat", "Belt", "Scarf", "Watch"]) {
    assert.equal(sizelessOk(t, null), true, t);
  }
  for (const t of ["T-Shirt", "Jeans", "Dress", "Sneakers"]) {
    assert.equal(sizelessOk(t, null), false, t);
  }
  // The stored category column routes even when the type is novel.
  assert.equal(sizelessOk("Mystery Thing", "Jewelry"), true);
});

test("autoOneSize: bags/scarves/hats auto-export One Size; rings never do", () => {
  assert.equal(autoOneSize("Tote Bag", null), true);
  assert.equal(autoOneSize("Scarf", null), true);
  assert.equal(autoOneSize("Ring", null), false);
  assert.equal(autoOneSize("Jeans", null), false);
});

test("estimateWeightOz: specific accessory subtypes hit their own weights", () => {
  assert.equal(estimateWeightOz("Crossbody Bag"), 12);
  assert.equal(estimateWeightOz("Tote Bag"), 18);       // "tote" beats generic "bag"
  assert.equal(estimateWeightOz("Handbag"), 18);
  assert.equal(estimateWeightOz("Duffel Bag"), 34);
  assert.equal(estimateWeightOz("Necklace"), 3);
  assert.equal(estimateWeightOz("Watch"), 8);
  assert.equal(estimateWeightOz("Baseball Cap"), 4);    // falls through to "cap"
  assert.equal(estimateWeightOz("Bucket Hat"), 4);
  assert.equal(estimateWeightOz("Belt"), 7);
  assert.equal(estimateWeightOz("Scarf"), 4);
  // existing clothing keys unchanged
  assert.equal(estimateWeightOz("jeans"), 24);
  assert.equal(estimateWeightOz("t-shirt"), 6);
});

test("estimateDims: jewelry ships tiny, bags ship boxed, backpacks ship big", () => {
  assert.deepEqual(estimateDims("Necklace"), { length: 7, width: 5, height: 2 });
  assert.deepEqual(estimateDims("Handbag"), { length: 13, width: 10, height: 5 });
  assert.deepEqual(estimateDims("Backpack"), { length: 18, width: 14, height: 8 });
  assert.deepEqual(estimateDims("Scarf"), { length: 9, width: 6, height: 1 });
  assert.deepEqual(estimateDims("Baseball Cap"), { length: 9, width: 6, height: 1 });
  // existing clothing behavior unchanged
  assert.deepEqual(estimateDims("jeans"), { length: 13, width: 10, height: 1 });
  assert.deepEqual(estimateDims("unknown thing"), { length: 13, width: 10, height: 1 });
});

test("estimatePrice: type-based suggestions exist for every tested category; unknown -> null", () => {
  assert.equal(estimatePrice("T-Shirt"), 15);
  assert.equal(estimatePrice("Jeans"), 30);
  assert.equal(estimatePrice("Handbag"), 35);
  assert.equal(estimatePrice("Belt"), 15);
  assert.equal(estimatePrice("Scarf"), 14);
  assert.equal(estimatePrice("Necklace"), 16);
  assert.equal(estimatePrice("Bucket Hat"), 18);
  assert.equal(estimatePrice("Totally Unknown Widget"), null);
});

test("buildCategory: accessories land in real accessory categories, never 'Clothing'", () => {
  assert.equal(buildCategory(item({ itemType: "Crossbody Bag" })), "Bags & Purses");
  assert.equal(buildCategory(item({ itemType: "Necklace" })), "Jewelry");
  assert.equal(buildCategory(item({ itemType: "Watch" })), "Watches");
  assert.equal(buildCategory(item({ itemType: "Belt" })), "Belts");
  assert.equal(buildCategory(item({ itemType: "Scarf" })), "Scarves & Wraps");
  assert.equal(buildCategory(item({ itemType: "Bucket Hat" })), "Hats");
  assert.equal(buildCategory(item({ itemType: "Wallet" })), "Wallets");
  // Novel type + category column -> the category-group fallback, not "Clothing".
  assert.equal(buildCategory(item({ itemType: "Hair Accessory", category: "Accessory" })), "Accessories");
  // Clothing behavior unchanged.
  assert.equal(buildCategory(item({ itemType: "Hoodie" })), "Sweatshirts & Hoodies");
  assert.equal(buildCategory(item({ itemType: "Jeans" })), "Jeans");
});

test("measurementsFor: accessories get honest length-based fields (or none)", () => {
  assert.deepEqual(measurementsFor("Handbag").map((m) => m.key), ["lengthIn"]);
  assert.deepEqual(measurementsFor("Necklace").map((m) => m.key), ["lengthIn"]);
  assert.deepEqual(measurementsFor("Ring"), []);
  assert.deepEqual(measurementsFor("Bucket Hat"), []);
  assert.deepEqual(measurementsFor("Belt").map((m) => m.key), ["lengthIn"]);
  // Clothing unchanged (filter preserves the MEASUREMENTS const order).
  assert.deepEqual(measurementsFor("jeans").map((m) => m.key), ["lengthIn", "waistIn", "hipIn", "riseIn"]);
  assert.deepEqual(measurementsFor("t-shirt").map((m) => m.key), ["chestIn", "lengthIn", "sleeveIn", "shoulderIn"]);
});

test("buildTitle: accessory titles read cleanly with subtype + colors", () => {
  const t = buildTitle(item({
    brand: "Coach", itemType: "Crossbody Bag", color: "Brown", department: "Women",
    material: "Leather", keyDetails: ["Gold-Tone Hardware"], size: null,
  }));
  assert.match(t, /Coach/);
  assert.match(t, /Womens/);
  assert.match(t, /Crossbody Bag/);
  assert.match(t, /Brown/);
  assert.ok(t.length <= 80);
});

test("buildDescription: a jewelry item reads as an item breakdown, no garment grammar", () => {
  const d = buildDescription(item({
    brand: "Unknown", itemType: "Necklace", color: "Gold", department: "Women",
    material: "Gold-Tone Metal", keyDetails: ["Pendant"], graphics: ["engraved floral pendant"],
  }));
  assert.match(d, /necklace/i);
  assert.doesNotMatch(d, /unknown/i);
  assert.doesNotMatch(d, /sleeve|inseam|crewneck/i);
});

// ---------------------------------------------------------------------------
// 2026-08-06 review regressions: word-boundary category inference + head-noun
// lookup. Substring matching used to route "Tie-Dye Shirt" to Accessory and
// "Dress Shirt" to the "Dresses" category.
// ---------------------------------------------------------------------------
test("itemCategory: qualifier words never drag a garment out of Clothing", () => {
  assert.equal(itemCategory(null, "Tie-Dye Shirt"), "Clothing");
  assert.equal(itemCategory(null, "Patchwork Jeans"), "Clothing");
  assert.equal(itemCategory(null, "Pinstripe Trousers"), "Clothing");
  assert.equal(itemCategory(null, "Ringer Tee"), "Clothing");
  assert.equal(itemCategory(null, "Baseball Jersey"), "Clothing");
});

test("itemCategory: 'Watch Cap' is headwear, not jewelry", () => {
  assert.equal(itemCategory(null, "Watch Cap"), "Hat");
  assert.equal(itemCategory(null, "Watch"), "Jewelry");
});

test("sizelessOk: garment types with accessory-ish substrings still require a size", () => {
  for (const t of ["Tie-Dye Shirt", "Patchwork Jeans", "Pinstripe Trousers", "Ringer Tee"]) {
    assert.equal(sizelessOk(t, null), false, t);
  }
});

test("autoOneSize: Earrings auto-export One Size ('ring' matches only as a whole word)", () => {
  assert.equal(autoOneSize("Earrings", null), true);
  assert.equal(autoOneSize("Ring", null), false);
  assert.equal(autoOneSize("Fitted Hat", null), false);
});

test("buildCategory/estimateWeightOz: head noun wins for garment compounds", () => {
  assert.equal(buildCategory(item({ itemType: "Dress Shirt" })), "Tops & Tees");
  assert.equal(estimateWeightOz("Dress Shirt"), 9); // its own exact key, unchanged
  assert.equal(buildCategory(item({ itemType: "Denim Dress" })), "Dresses");
  // bag subtypes keep their tuned values via explicit compound keys
  assert.equal(estimateWeightOz("Tote Bag"), 18);
  assert.equal(estimateWeightOz("Duffel Bag"), 34);
  assert.deepEqual(estimateDims("Duffel Bag"), { length: 18, width: 14, height: 8 });
});

// --- model / sub-brand / evidence-gated origin (2026-08-19) ---------------
// The title is where identification quality becomes money, so these lock in both
// the new keywords and the rule that none of them may be invented.

test("buildTitle: the model number rides just under the pinned tokens", () => {
  const t = buildTitle(item({
    brand: "Levi's", model: "501", itemType: "Jeans", size: "32x30",
    color: "Blue", material: "Denim", fit: "Original", department: "Men",
  }));
  assert.match(t, /Levi's/);
  assert.match(t, /\b501\b/);
  assert.match(t, /Jeans/);
  assert.match(t, /Size 32x30/);
  // A buyer hunting this types "Levi's 501", so the two must stay adjacent.
  assert.match(t, /Levi's 501/);
});

test("buildTitle: a style number stands in when there is no model name", () => {
  const t = buildTitle(item({ brand: "Carhartt", styleNumber: "J130", itemType: "Jacket" }));
  assert.match(t, /J130/);
});

test("buildTitle: the model is preferred over the style number when both exist", () => {
  const t = buildTitle(item({
    brand: "Levi's", model: "501", styleNumber: "005010000", itemType: "Jeans",
  }));
  assert.match(t, /501/);
  assert.doesNotMatch(t, /005010000/);
});

test("buildTitle: a sub-brand travels with the brand, not as a droppable token", () => {
  const t = buildTitle(item({
    brand: "Levi's", subBrand: "Silver Tab", itemType: "Jeans", size: "32x30",
  }));
  assert.match(t, /Levi's Silver Tab/);
});

test("buildTitle: a sub-brand already inside the brand is not repeated", () => {
  const t = buildTitle(item({
    brand: "Levi's Silver Tab", subBrand: "Silver Tab", itemType: "Jeans",
  }));
  assert.equal((t.match(/Silver Tab/g) ?? []).length, 1);
});

test("buildTitle: no brand means no sub-brand floating on its own", () => {
  const t = buildTitle(item({ brand: "Unknown", subBrand: "Silver Tab", itemType: "Jeans" }));
  assert.doesNotMatch(t, /Silver Tab/);
});

test("buildTitle: every word starts with a capital, without wrecking acronyms", () => {
  // Brands reach the title exactly as they were read, so lowercase ones ("one step
  // up", "free people") used to ship lowercase in the middle of a listing title.
  const lower = buildTitle(item({ brand: "one step up", itemType: "Tank Top", color: "Brown", size: "L" }));
  assert.match(lower, /One Step Up/);
  assert.doesNotMatch(lower, /one step up/);

  // Lower-casing the rest of a word would be a worse bug than the one being fixed:
  // these have to survive exactly as they are.
  assert.match(buildTitle(item({ brand: "DKNY", itemType: "Skirt", size: "8" })), /DKNY/);
  assert.match(buildTitle(item({ brand: "4S", itemType: "T-Shirt", size: "S" })), /4S/);
  assert.match(
    buildTitle(item({ brand: "Harley-Davidson", itemType: "Tube Top", size: "L" })),
    /Harley-Davidson/,
  );
});

test("buildTitle: 'Made in USA' needs a label, a note, or the description that says so", () => {
  // Claimed from countryOfOrigin (tag OCR off a label) or from the phrase itself in the
  // operator's notes, the description, a key detail, or the OCR read - never a guess.
  const claimed = buildTitle(item({
    brand: "Levi's", itemType: "Jeans", countryOfOrigin: "USA", size: "32x30",
  }));
  assert.match(claimed, /Made in USA/);

  for (const origin of [null, "", "Vietnam", "Mexico", "China"]) {
    const t = buildTitle(item({ brand: "Levi's", itemType: "Jeans", countryOfOrigin: origin }));
    assert.doesNotMatch(t, /Made in USA/, `origin ${JSON.stringify(origin)} must not claim USA`);
  }
  // The user rule (2026-09-03): stated anywhere, it makes the title.
  const stated: Partial<ListingItem>[] = [
    { notes: "made in usa, great shape" },
    { description: "Heavyweight tee. Made in the U.S.A. Single stitch." },
    { tagText: "LEVI STRAUSS & CO. | MADE IN USA | 100% COTTON" },
    { keyDetails: ["Made In USA"] },
  ];
  for (const extra of stated) {
    const t = buildTitle(item({ brand: "Levi's", itemType: "Jeans", size: "32x30", ...extra }));
    assert.match(t, /Made in USA/, JSON.stringify(extra));
  }
  const elsewhere = buildTitle(item({
    brand: "Levi's", itemType: "Jeans", description: "Made in China.", notes: "usa seller",
  }));
  assert.doesNotMatch(elsewhere, /Made in USA/);
});

test("buildTitle: a stated 100% fabric goes in the title as written", () => {
  // Item 000129: the material column already says it.
  const sweater = buildTitle(item({
    brand: "Joseph & Lyman", itemType: "Sweater", material: "100% Merino Wool", size: "L",
    description: "Black crewneck sweater. Made from 100% Italian Merino wool, manufactured in China.",
  }));
  assert.match(sweater, /100% Merino Wool Sweater/);
  // Only the description says it: the phrase is lifted from there, qualifier and all.
  const fromDescription = buildTitle(item({
    brand: "Joseph & Lyman", itemType: "Sweater", material: "Wool", size: "L",
    description: "Made from 100% Italian Merino wool.",
  }));
  assert.match(fromDescription, /100% Italian Merino Wool Sweater/);
  // A note or the label read counts, and a plain "Cotton" column does not stop it.
  assert.match(buildTitle(item({ brand: "Gildan", itemType: "T-Shirt", material: "Cotton", notes: "100% cotton" })),
    /100% Cotton T-Shirt/);
  assert.match(buildTitle(item({ brand: "Gildan", itemType: "T-Shirt", tagText: "100% COTTON | MADE IN HONDURAS" })),
    /100% Cotton T-Shirt/);
  // A blend, or a percentage on something that is not a fabric, is not a composition.
  assert.doesNotMatch(buildTitle(item({ brand: "Gildan", itemType: "T-Shirt", material: "Cotton blend", notes: "100% authentic" })),
    /100%/);
});

test("buildTitle: a country that merely contains the letters is not the USA", () => {
  // Guarding the substring trap: no country should back into the claim.
  const t = buildTitle(item({ brand: "Levi's", itemType: "Jeans", countryOfOrigin: "Usaka" }));
  assert.doesNotMatch(t, /Made in USA/);
});

test("buildTitle: still never prints a placeholder brand", () => {
  const t = buildTitle(item({ brand: "Unknown", itemType: "T-Shirt", color: "Black", size: "L" }));
  assert.doesNotMatch(t, /unknown/i);
  assert.match(t, /T-Shirt/);
});

test("buildTitle: the new tokens respect the 80-character ceiling", () => {
  const t = buildTitle(item({
    brand: "Polo Ralph Lauren", subBrand: "Purple Label", model: "Custom Fit Oxford",
    itemType: "Button-Up Shirt", size: "XXL", color: "Navy", secondaryColor: "White",
    pattern: "Striped", department: "Men", fit: "Slim", countryOfOrigin: "USA",
    keyDetails: ["Embroidered Pony"], whenMade: "1990s",
  }));
  assert.ok(t.length <= 80, `title was ${t.length} chars: ${t}`);
  // The pinned tokens survive whatever else is trimmed.
  assert.match(t, /Polo Ralph Lauren/);
  assert.match(t, /Button-Up Shirt/);
});

test("buildTitle: missing model and sub-brand change nothing", () => {
  const before = buildTitle(item({ brand: "Nike", itemType: "Hoodie", color: "Black", size: "L" }));
  const after = buildTitle(item({
    brand: "Nike", itemType: "Hoodie", color: "Black", size: "L",
    model: null, styleNumber: null, subBrand: null, countryOfOrigin: null,
  }));
  assert.equal(before, after);
});

// --- brand folded into the model field (2026-09-02) ------------------------
// The vision model writes "Wrangler 2000" for a Wrangler. The title de-dupes the
// repeat while the brand matches, so nobody sees it until the brand is corrected -
// then the old name kept riding in the title of a Lee. Intake and the brand editors
// scrub it out with this helper.
import { stripBrandFromModel, isGenericDetail } from "./listing.ts";

test("stripBrandFromModel drops a leading brand, whole-word and case-insensitive", () => {
  assert.equal(stripBrandFromModel("Wrangler 2000", "Wrangler"), "2000");
  assert.equal(stripBrandFromModel("wrangler 2000", "Wrangler"), "2000");
  assert.equal(stripBrandFromModel("Polo Ralph Lauren Custom Fit", "Polo Ralph Lauren"), "Custom Fit");
});

test("stripBrandFromModel leaves a model that merely resembles the brand alone", () => {
  assert.equal(stripBrandFromModel("Wranglers 2000", "Wrangler"), "Wranglers 2000");
  assert.equal(stripBrandFromModel("Wrangler 2000", "Lee"), "Wrangler 2000");
  assert.equal(stripBrandFromModel("501", "Levi's"), "501");
});

test("stripBrandFromModel treats regex characters in a brand literally", () => {
  assert.equal(stripBrandFromModel("Levi's 501", "Levi's"), "501");
  assert.equal(stripBrandFromModel("A.P.C. Petit Standard", "A.P.C."), "Petit Standard");
  assert.equal(stripBrandFromModel("APC Petit Standard", "A.P.C."), "APC Petit Standard");
});

test("stripBrandFromModel returns empty when the model was only the brand, or nothing", () => {
  assert.equal(stripBrandFromModel("Wrangler", "Wrangler"), "");
  assert.equal(stripBrandFromModel(null, "Wrangler"), "");
  assert.equal(stripBrandFromModel("2000", null), "2000");
  assert.equal(stripBrandFromModel("2000", "Unknown"), "2000");
});

test("buildTitle: a corrected brand no longer drags the old brand in via the model", () => {
  const stale = item({ brand: "Lee", model: "Wrangler 2000", itemType: "Shorts", size: "32" });
  assert.match(buildTitle(stale), /Wrangler/); // the bug, as stored on older items
  const fixed = item({ ...stale, model: stripBrandFromModel(stale.model, "Wrangler") || null });
  const t = buildTitle(fixed);
  assert.doesNotMatch(t, /Wrangler/);
  assert.match(t, /Lee 2000/);
});

// --- solid colors, fragment details, fabric word (2026-09-02) ----------------
// Item 000120, blue denim cargo shorts, shipped as "Wrangler 2000 Unisex Cargo Shorts
// Blue White Black Pockets Size 32": stitching colors on a solid garment, a detail cut
// down to a fragment by the de-dupe, and no "Denim" anywhere. These lock in the fixes.

test("buildTitle: a solid garment carries only its primary color", () => {
  const t = buildTitle(item({
    brand: "Wrangler", itemType: "Shorts", pattern: "Solid",
    color: "Blue", secondaryColor: "White", tertiaryColor: "Black", size: "32",
  }));
  assert.ok(t.includes("Blue"), t);
  assert.ok(!t.includes("White") && !t.includes("Black"), t);
});

test("buildTitle: a colorblock garment keeps its second and third colors", () => {
  const t = buildTitle(item({
    brand: "Nike", itemType: "Windbreaker", pattern: "Colorblock",
    color: "Blue", secondaryColor: "White", tertiaryColor: "Black", size: "L",
  }));
  assert.ok(t.includes("Blue") && t.includes("White") && t.includes("Black"), t);
});

test("buildDescription: a solid garment is described in one color", () => {
  const d = buildDescription(item({
    brand: "Wrangler", itemType: "Shorts", pattern: "Solid",
    color: "Blue", secondaryColor: "White", tertiaryColor: "Black",
  }));
  assert.ok(d.includes("blue"), d);
  assert.ok(!d.includes("white") && !d.includes("black"), d);
});

test("buildTitle: a key detail sharing a word with the title is skipped, not left as a fragment", () => {
  const t = buildTitle(item({
    brand: "Wrangler", itemType: "Shorts", style: "Cargo", size: "32",
    keyDetails: ["Cargo Pockets", "High Rise"],
  }));
  assert.ok(!t.includes("Pockets"), t);
  assert.ok(t.includes("High Rise"), t);
  assert.equal((t.match(/Cargo/g) ?? []).length, 1, t);
});

test("buildTitleWithMeta identifies the exact key detail visible in the title", () => {
  // SKU 000144: the first two details overlap the Disney brand, so neither can be
  // inserted intact. Review must mark Star Wars, which is the next eligible line.
  const details = ["Disney Parks", "Walt Disney World", "Star Wars", "Fleece-Lined"];
  const built = buildTitleWithMeta(item({
    brand: "Disney", itemType: "Hoodie", color: "Black", size: "L", keyDetails: details,
  }));
  assert.equal(built.keyDetail, "Star Wars");
  assert.match(built.title, /Star Wars/);

  // Order is the operator control: moving another eligible line first changes both
  // the title and the marker from the same source-of-truth calculation.
  const reordered = buildTitleWithMeta(item({
    brand: "Disney", itemType: "Hoodie", color: "Black", size: "L",
    keyDetails: ["Fleece-Lined", ...details.slice(0, 3)],
  }));
  assert.equal(reordered.keyDetail, "Fleece-Lined");
  assert.match(reordered.title, /Fleece-Lined/);
  assert.doesNotMatch(reordered.title, /Star Wars/);
});

test("buildTitleWithMeta does not mark a detail removed by the 80-character trim", () => {
  const built = buildTitleWithMeta(item({
    brand: "Sportswear Company International",
    model: "Limited Edition Performance Collection",
    itemType: "Windbreaker Jacket",
    department: "Women",
    whenMade: "1990s",
    pattern: "Colorblock",
    style: "Packable",
    color: "Red",
    secondaryColor: "Blue",
    tertiaryColor: "Yellow",
    fit: "Oversized",
    keyDetails: ["Embroidered Logo"],
    size: "XXL",
  }));
  assert.equal(built.keyDetail, null);
  assert.doesNotMatch(built.title, /Embroidered Logo/);
  assert.ok(built.title.length <= 80, built.title);
});

test("isGenericDetail: seam construction is not a search keyword", () => {
  assert.equal(isGenericDetail("Double Stitching"), true);
  assert.equal(isGenericDetail("Triple Stitching"), true);
  assert.equal(isGenericDetail("Contrast Stitching"), false);
});

test("buildTitle: a specialty fabric sits directly on the item type", () => {
  assert.ok(buildTitle(item({ brand: "Wrangler", itemType: "Shorts", material: "Denim", size: "32" })).includes("Denim Shorts"));
  assert.ok(buildTitle(item({ brand: "Schott", itemType: "Jacket", material: "100% Leather", size: "L" })).includes("Leather Jacket"));
  // Generic fibers stay out of the phrase.
  assert.ok(!buildTitle(item({ brand: "Nike", itemType: "Hoodie", material: "Cotton", color: "Grey", size: "L", style: "Pullover" })).includes("Cotton Hoodie"));
});

test("buildTitle: the fabric word is not repeated when the item type already carries it", () => {
  const t = buildTitle(item({ brand: "Levi's", itemType: "Denim Jacket", material: "Denim", size: "L" }));
  assert.equal((t.match(/Denim/g) ?? []).length, 1, t);
});

test("buildTitle: item 000120 end to end", () => {
  const t = buildTitle(item({
    brand: "Wrangler", model: "2000", styleNumber: "2000", itemType: "Shorts", category: "Clothing",
    color: "Blue", secondaryColor: "White", tertiaryColor: "Black", pattern: "Solid",
    material: "Denim", department: "Unisex", style: "Cargo", fit: "Regular", closure: "Button-Up",
    keyDetails: ["Cargo Pockets", "Double Stitching", "High Rise", "Vintage Wash"],
    aesthetic: ["workwear", "90s", "streetwear", "utilitarian"], size: "32",
  }));
  assert.equal(t, "Wrangler 2000 Unisex Cargo Denim Shorts Blue High Rise Size 32");
});

test("assessTitle: a registration number or the ruler's print is flagged for the operator", () => {
  // Both have reached a title from upstream bugs; at approval time they are warnings.
  assert.ok(assessTitle("Extreme Courtide RN4 11965 Unisex Graphic T-Shirt Black Size M").issues.includes("registration number in title"));
  assert.ok(assessTitle("Joseph & Lyman WPL 10167 Mens Crewneck Sweater Black Size L").issues.includes("registration number in title"));
  assert.ok(assessTitle("Empire Model 403 Womens Wide Leg Denim Jeans Blue Size 10").issues.includes("ruler print in title"));
  assert.ok(assessTitle("Rocky Mountain 403 Unisex Vintage Denim Jeans Black Size 29").issues.includes("ruler print in title"));
  assert.ok(assessTitle("Empire Unisex Corduroy Jeans Brown Button Fly Size 27").issues.includes("ruler print in title"));
  const fine = assessTitle("Free People Womens Empire Waist Floral Maxi Dress Blue Size M");
  assert.ok(!fine.issues.includes("ruler print in title"));
  assert.ok(!fine.issues.includes("registration number in title"));
  assert.ok(!assessTitle("Levi's 501 Mens Straight Denim Jeans Blue Size 32x30").issues.includes("ruler print in title"));
});
