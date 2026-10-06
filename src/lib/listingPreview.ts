// Builds the ListingItem that the title/description preview is generated from, so
// every screen that shows an operator "what this will be listed as" agrees with what
// export-item.ts actually writes.
//
// Three layers, most specific first:
//   1. the operator's unsaved form edits (so the preview reacts as they type),
//   2. the stored columns,
//   3. the raw vision JSON, for older items whose rich detail was never promoted
//      into its own column.
//
// Review and the item detail page carry DIFFERENT form field sets — Review is a fast
// triage pass over a handful of attributes, the detail page edits everything. Layer 2
// is what lets the smaller form still preview the full title: fields Review does not
// render fall through to the stored item instead of vanishing, so the title it shows
// is the title that will export.
import type { ListingItem } from "./listing";
import { ocrTagText } from "./listing.ts";
import { canonicalizeListingAttributes } from "./normalize.ts";

type Loose = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null;

/** Split a comma/newline-delimited text column into the array the builder wants. */
const splitList = (v: unknown): string[] | null => {
  if (Array.isArray(v)) {
    const a = v.map(String).map((x) => x.trim()).filter(Boolean);
    return a.length ? a : null;
  }
  if (typeof v !== "string") return null;
  const a = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return a.length ? a : null;
};

export function previewListingItem(item: Loose | null, overrides: Loose = {}): ListingItem {
  let raw: Loose = {};
  try {
    const source = item?.aiRaw;
    if (typeof source === "string" && source) raw = JSON.parse(source) as Loose;
  } catch {
    raw = {};
  }
  // `in` rather than a truthiness check: an operator clearing a field to "" or null is
  // a real edit, and must not silently fall back to the stored value.
  const pick = (key: string): unknown =>
    key in overrides ? overrides[key] : key in (item ?? {}) ? (item as Loose)[key] : raw[key];
  const text = (key: string): string | null => str(pick(key)) ?? str(raw[key]);
  const list = (key: string): string[] | null => {
    if (key === "keyDetails") {
      // Review materializes a legacy raw list before editing. From then on, a non-null
      // override or stored value is authoritative even when it is the empty string;
      // only a genuinely unset legacy column falls back to aiRaw.
      if (key in overrides && overrides[key] !== null && overrides[key] !== undefined) {
        return splitList(overrides[key]);
      }
      const stored = item && key in item ? item[key] : undefined;
      if (stored !== null && stored !== undefined) return splitList(stored);
      return splitList(raw[key]);
    }
    return splitList(pick(key)) ?? splitList(raw[key]);
  };

  // Canonical spellings are applied HERE rather than only at intake so that items
  // stored before the normalization table existed preview -- and export -- the same
  // way new ones do. The same helper runs in export-item.ts, so the title an
  // operator approves is the title that ships. Unrecognized values pass through, so
  // a graphic-tee brand like "Saint Pablo Tour Merch" is untouched.
  return canonicalizeListingAttributes({
    sku: str(item?.sku) ?? "",
    brand: text("brand") ?? "Unknown",
    color: text("color"),
    secondaryColor: text("secondaryColor"),
    tertiaryColor: text("tertiaryColor"),
    pattern: text("pattern"),
    itemType: text("itemType"),
    category: text("category"),
    style: text("style"),
    material: text("material"),
    sleeve: text("sleeve"),
    department: text("department"),
    fit: text("fit"),
    model: text("model"),
    styleNumber: text("styleNumber"),
    subBrand: text("subBrand"),
    countryOfOrigin: text("countryOfOrigin"),
    closure: text("closure"),
    neckline: text("neckline"),
    lining: text("lining"),
    graphics: list("graphics"),
    keyDetails: list("keyDetails"),
    aesthetic: list("aesthetic"),
    inseam: text("inseam"),
    chestIn: text("chestIn"),
    lengthIn: text("lengthIn"),
    sleeveIn: text("sleeveIn"),
    shoulderIn: text("shoulderIn"),
    waistIn: text("waistIn"),
    hipIn: text("hipIn"),
    riseIn: text("riseIn"),
    size: text("size"),
    whenMade: text("whenMade"),
    // Drives the NWT title keyword.
    condition: text("condition"),
    notes: text("notes"),
    // Stated facts (Made in USA, 100% fabric) are read from these for the title.
    description: text("description"),
    tagText: ocrTagText(raw),
  });
}
