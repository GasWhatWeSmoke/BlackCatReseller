// buildExportCopy was lifted OUT of export-item.ts so a screen can show what a push
// would send. The whole point is that both callers get the identical answer, so these
// tests pin the behaviors that used to live inside the exporter — especially the ones
// the live preview does NOT reproduce (derived sleeve, cut-collar scrubbing, salesy
// rewrite), because those are exactly the differences that would make a Listings tab
// lie about what it is about to push.
import test from "node:test";
import assert from "node:assert/strict";
import { buildExportCopy, type CopySource } from "./listingCopy.ts";

function source(over: Partial<CopySource> = {}): CopySource {
  return {
    sku: "000001", brand: "Quiksilver", size: "L", itemType: "T-shirt", category: "Clothing",
    color: "Blue", pattern: "Graphic", condition: "Good", whenMade: null,
    department: "Men", material: null, style: null, secondaryColor: null, tertiaryColor: null,
    fit: null, model: null, styleNumber: null, subBrand: null, countryOfOrigin: null,
    closure: null, neckline: null, lining: null, graphics: null, keyDetails: null,
    aesthetic: null, description: null, customTitle: null, notes: null, publicNotes: null,
    inseam: null, chestIn: null, lengthIn: null, sleeveIn: null, shoulderIn: null,
    waistIn: null, hipIn: null, riseIn: null, trueVintage: false, etsyEligible: "none",
    aiRaw: null,
    ...over,
  };
}

test("a sentence about the photo shoot never reaches the listing description", () => {
  // Three of the seven items left after the 2026-09-06 run carried one of these.
  const desc =
    "Brown corduroy pants with a button fly closure and rear patch pockets with black buttons. " +
    "The fabric displays a classic corduroy texture with a soft hand and a straight leg. " +
    "A wooden hanger is visible in the background. " +
    "A white care label is visible inside the neck area, displaying the text 'BC-000147' and a QR code. " +
    "The item is displayed on a hanger and laid flat. " +
    "Measures 26\" inseam laid flat.";
  const out = buildExportCopy(source({ itemType: "Pants", category: "Pants", description: desc, brand: "YSL" })).description;
  assert.doesNotMatch(out, /hanger|QR code|BC-000147|background/i);
  assert.match(out, /button fly closure/);
  assert.match(out, /Measures 26" inseam laid flat/);
});

test("the title leads with the brand and carries the size", () => {
  const copy = buildExportCopy(source());
  assert.match(copy.title, /^Quiksilver /);
  assert.match(copy.title, /Size L$/);
  assert.ok(copy.title.length <= 80, `title must fit Nifty's 80 chars, got ${copy.title.length}`);
});

test("a customTitle overrides the generated title and is still capped at 80", () => {
  const long = "x".repeat(200);
  assert.equal(buildExportCopy(source({ customTitle: "  My Exact Title  " })).title, "My Exact Title");
  assert.equal(buildExportCopy(source({ customTitle: long })).title.length, 80);
});

test("brand spellings are canonicalized in the copy, not just in the database", () => {
  // The exporter has to agree with the stored-brand cleanup, or a fixed brand would
  // still ship misspelled.
  assert.match(buildExportCopy(source({ brand: "Quicksilver" })).title, /^Quiksilver /);
  assert.match(buildExportCopy(source({ brand: "Polo by Ralph Lauren" })).title, /^Polo Ralph Lauren /);
});

test("sleeve length is DERIVED, which is why export can say Long Sleeve", () => {
  // There is no `sleeve` column. previewListingItem reads one and finds nothing;
  // export reads the style/notes/details. This difference is real and load-bearing:
  // four live listings say "Long Sleeve" for exactly this reason.
  const plain = buildExportCopy(source());
  assert.equal(plain.sleeve, null);
  const sleeved = buildExportCopy(source({ style: "Long Sleeve Crewneck" }));
  assert.equal(sleeved.sleeve, "Long Sleeve");
  assert.match(sleeved.title, /Long Sleeve/);
});

test("a cut collar is never described as a crewneck", () => {
  const copy = buildExportCopy(source({
    notes: "Collar is cut off",
    neckline: "Crewneck",
    style: "Crewneck",
    description: "A black crewneck t-shirt with a crewneck collar.",
  }));
  assert.doesNotMatch(copy.description, /crew\s*-?\s*neck/i);
  assert.doesNotMatch(copy.title, /crew\s*-?\s*neck/i);
  assert.equal(copy.collarCut, true);
  assert.equal(copy.neckline, null);
});

test("operator notes reach the public description exactly once", () => {
  const copy = buildExportCopy(source({ notes: "Slight fade on the left sleeve" }));
  const hits = copy.description.toLowerCase().split("slight fade on the left sleeve").length - 1;
  assert.equal(hits, 1, `flaw disclosure must appear once, appeared ${hits}x`);
});

test("a heavily salesy description is rebuilt from the item's facts", () => {
  const copy = buildExportCopy(source({
    material: "Cotton",
    description: "RARE vintage grail piece! Must have! Super rare! Y2K heat!",
  }));
  assert.doesNotMatch(copy.description, /rare|grail|must have|heat/i);
  assert.ok(copy.copyWarnings.some((w) => /salesy/i.test(w)), copy.copyWarnings.join("; "));
});

test("flat measurements are appended once, not on every rebuild", () => {
  const copy = buildExportCopy(source({ chestIn: "22", lengthIn: "29" }));
  assert.equal(copy.description.toLowerCase().split("measures").length - 1, 1);
  assert.match(copy.description, /22/);
});

test("True Vintage forces a vintage era even when whenMade is modern", () => {
  const copy = buildExportCopy(source({ trueVintage: true, whenMade: "2020 - 2026 (Recently)" }));
  assert.doesNotMatch(copy.whenMade, /2020/);
  assert.equal(copy.etsyEligible, "vintage");
  assert.equal(copy.etsyAllowed, true);
});

test("ordinary resale clothing is not offered to Etsy", () => {
  const copy = buildExportCopy(source());
  assert.equal(copy.etsyEligible, "none");
  assert.equal(copy.etsyAllowed, false);
});

test("a size-less accessory exports as One Size; a garment does not", () => {
  const bag = buildExportCopy(source({ size: null, itemType: "Tote Bag", category: "Bag" }));
  assert.equal(bag.exportSize, "One Size");
  const tee = buildExportCopy(source({ size: null }));
  assert.equal(tee.exportSize, null);
});

test("rich attributes fall back to the raw vision JSON for older items", () => {
  // Items enriched before those columns existed keep their detail in aiRaw, and the
  // exporter has always read it. Losing that in the extraction would quietly thin out
  // every pre-existing listing's copy.
  const copy = buildExportCopy(source({
    material: null,
    aiRaw: JSON.stringify({ material: "Merino Wool", keyDetails: ["Embroidered Logo"] }),
  }));
  assert.equal(copy.material, "Merino Wool");
  assert.match(copy.description, /merino/i);
  assert.match(copy.title, /Embroidered/i);
});

test("an explicitly cleared key-details column never resurrects aiRaw keywords", () => {
  const copy = buildExportCopy(source({
    keyDetails: "",
    aiRaw: JSON.stringify({ keyDetails: ["Star Wars", "Fleece-Lined"] }),
  }));
  assert.doesNotMatch(copy.title, /Star Wars|Fleece-Lined/i);
  assert.doesNotMatch(copy.description, /Star Wars|Fleece-Lined/i);
});

test("export title metadata selects the detail after derived title fields", () => {
  // Export derives Long Sleeve before buildTitle chooses a detail. Review must not
  // mark that first line as the detail too; it is now the sleeve token, so Crewneck
  // is the first remaining line that can fill the dedicated key-detail slot.
  const copy = buildExportCopy(source({
    brand: "Nabee",
    itemType: "Sweater",
    pattern: "Lace",
    keyDetails: "Long Sleeve\nCrewneck",
  }));
  assert.match(copy.autoTitle, /Long Sleeve/);
  assert.match(copy.autoTitle, /Crewneck/);
  assert.equal(copy.autoTitleKeyDetail, "Crewneck");
  assert.equal(copy.title, copy.autoTitle);
});

test("a generic fiber stays out of the copy even when it is known", () => {
  // "cotton" tells a buyer nothing they didn't assume; only "100%" or a specialty
  // fabric earns the words. Resolved onto the item either way.
  const copy = buildExportCopy(source({ material: "Cotton" }));
  assert.equal(copy.material, "Cotton");
  assert.doesNotMatch(copy.description, /cotton/i);
});

test('KNOWN: normalization collapses "100% Cotton" to "Cotton", dropping it from the copy', () => {
  // Not what this module decides — the material alias table (added with the brand
  // cleanup) rewrites "100% Cotton" to "Cotton" BEFORE the builder asks whether the
  // material is worth mentioning, and the builder's rule is "100% … or a specialty
  // fabric". So a genuine 100%-cotton selling point silently stops being stated.
  // Pinned as a test rather than fixed here: changing it rewrites descriptions on
  // existing listings, which is a decision for the operator, not a side effect of
  // building the editor.
  const copy = buildExportCopy(source({ material: "100% Cotton" }));
  assert.equal(copy.material, "100% Cotton", "the stored value is untouched");
  assert.doesNotMatch(copy.description, /cotton/i);
});

test("malformed aiRaw does not throw", () => {
  const copy = buildExportCopy(source({ aiRaw: "{not json" }));
  assert.ok(copy.title.length > 0);
});

test("the copy is deterministic — the same item twice gives the same push", () => {
  // A Listings tab that showed one title and pushed another would be worse than none.
  const it = source({ description: "Soft cotton tee.", chestIn: "21", notes: "Small stain" });
  assert.deepEqual(buildExportCopy(it), buildExportCopy(it));
});
