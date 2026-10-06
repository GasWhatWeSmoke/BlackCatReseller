// Canonical spellings for brands and attributes.
//
// The inventory had "Quiksilver", "Quicksilver" and "Quicksliver Quikjean" as
// three separate brands for one company, and "Ralph Lauren" sitting beside
// "Polo Ralph Lauren". Tag OCR makes this worse before it makes it better: it
// reads real characters off a real label, but it reads them imperfectly.
//
// The rule that matters is the conservative one. An exact alias is applied; a
// near miss is only ever SUGGESTED. Auto-correcting an almost-match is how a
// listing ends up with confidently wrong branding, which is worse than an
// unpolished one -- and a value nobody recognises is left exactly as it came in,
// because on a graphic tee the brand field legitimately holds "Megadeth" or
// "Saint Pablo Tour Merch".
// The import attribute is required so this module loads under Node's native TS
// runner in the test gate, not just through the bundler.
import table from "../../config/normalization.json" with { type: "json" };
import { scrubStudioProps } from "./studioProps.ts";

export type NormalizeField = "brand" | "material" | "color" | "fit";

export interface NormalizedValue {
  /** The value to use. Equals `original` unless an exact alias matched. */
  value: string;
  /** True when an alias or canonical spelling matched exactly. */
  canonical: boolean;
  /** A near miss worth showing the operator. NEVER applied automatically. */
  suggestion?: string;
  /** What came in, after whitespace cleanup. */
  original: string;
}

type AliasTable = Record<string, string[]>;

const TABLES: Record<NormalizeField, AliasTable> = {
  brand: table.brands as AliasTable,
  material: table.materials as AliasTable,
  color: table.colors as AliasTable,
  fit: table.fits as AliasTable,
};

/**
 * The lookup key: lowercase, apostrophes deleted (so "Levi's" and "Levis" agree),
 * every other non-alphanumeric run collapsed to a single space.
 */
export function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Collapse whitespace. "Grim Reaper  " really was stored with trailing spaces. */
function tidy(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

const INDEXES = new Map<NormalizeField, Map<string, string>>();

function indexFor(field: NormalizeField): Map<string, string> {
  const cached = INDEXES.get(field);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(TABLES[field])) {
    index.set(normalizeKey(canonical), canonical);
    for (const alias of aliases) {
      const key = normalizeKey(alias);
      // First writer wins: a canonical spelling is never displaced by another
      // entry's alias list.
      if (key && !index.has(key)) index.set(key, canonical);
    }
  }
  INDEXES.set(field, index);
  return index;
}

/** Levenshtein distance, bailing out once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// Short strings are excluded from fuzzy matching entirely: below five characters
// a distance of two is most of the word, which would happily turn "Vans" into
// "Vera" and call it a correction. Five is deliberate -- it is what lets "Roast"
// reach "Roar", the exact brand misread this was built for.
const MIN_FUZZY_LENGTH = 5;
const MAX_FUZZY_DISTANCE = 2;

function nearestKnown(key: string, index: Map<string, string>): string | undefined {
  if (key.length < MIN_FUZZY_LENGTH) return undefined;
  let best: string | undefined;
  let bestDistance = MAX_FUZZY_DISTANCE + 1;
  let tied = false;
  for (const [candidateKey, canonical] of index) {
    const distance = editDistance(key, candidateKey, MAX_FUZZY_DISTANCE);
    if (distance > MAX_FUZZY_DISTANCE) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = canonical;
      tied = false;
    } else if (distance === bestDistance && canonical !== best) {
      tied = true;
    }
  }
  // An ambiguous near miss is not a suggestion, it is a coin flip.
  return tied ? undefined : best;
}

export function normalizeValue(field: NormalizeField, raw: unknown): NormalizedValue {
  const original = tidy(typeof raw === "string" ? raw : "");
  if (!original) return { value: "", canonical: false, original: "" };

  const key = normalizeKey(original);
  if (!key) return { value: original, canonical: false, original };

  const index = indexFor(field);
  const exact = index.get(key);
  if (exact) return { value: exact, canonical: true, original };

  const suggestion = nearestKnown(key, index);
  return suggestion
    ? { value: original, canonical: false, suggestion, original }
    : { value: original, canonical: false, original };
}

export function normalizeBrand(raw: unknown): NormalizedValue {
  return normalizeValue("brand", raw);
}

/** Canonical brand string, or the cleaned input when unknown. Never empty-ifies. */
export function canonicalBrand(raw: unknown): string {
  return normalizeValue("brand", raw).value;
}

export function canonicalMaterial(raw: unknown): string {
  return normalizeValue("material", raw).value;
}

export function canonicalColor(raw: unknown): string {
  return normalizeValue("color", raw).value;
}

export function canonicalFit(raw: unknown): string {
  return normalizeValue("fit", raw).value;
}

/**
 * The sub-brand line for a brand, if this text names one -- "Levi's Silver Tab"
 * is a materially different listing from "Levi's".
 */
export function detectSubBrand(brand: string, text: string | null | undefined): string | null {
  const subs = (table.subBrands as Record<string, string[]>)[brand];
  if (!subs || !text) return null;
  const haystack = normalizeKey(text);
  for (const sub of subs) {
    const key = normalizeKey(sub);
    if (key && new RegExp(`(^| )${key}( |$)`).test(haystack)) return sub;
  }
  return null;
}

/**
 * Apply canonical spellings to the attribute fields of an item-shaped object.
 *
 * Used by BOTH the live preview and the export so an operator never sees
 * "Quiksilver" on screen and finds "Quicksilver" in the listing. Unrecognized
 * values are left exactly as they are, and empty fields stay empty.
 */
// An RN, CA, or WPL number is a registration the label carries, not a style number;
// the vision model has offered one as the style number ("WPL 10167" on 000129), and
// the title builder would have put it right after the brand.
// OCR splits the digits sometimes ("RN4 11965" on 000137), so spaces inside them count.
const REGISTRATION_RE = /^(?:RN|CA|WPL)\s*#?\s*:?\s*\d[\d\s]{1,8}\d$/i;
export function isRegistrationNumber(v: unknown): boolean {
  return typeof v === "string" && REGISTRATION_RE.test(v.trim());
}

export function canonicalizeListingAttributes<T extends Record<string, unknown>>(it: T): T {
  // The studio ruler's print leaves first: it is not an attribute to canonicalize,
  // and this is the one place both the preview and the export pass through.
  const out: Record<string, unknown> = scrubStudioProps({ ...it });
  for (const key of ["model", "styleNumber"]) {
    if (isRegistrationNumber(out[key])) out[key] = null;
  }
  const apply = (key: string, fn: (v: unknown) => string) => {
    const value = out[key];
    if (typeof value === "string" && value.trim()) {
      const canonical = fn(value);
      if (canonical) out[key] = canonical;
    }
  };
  apply("brand", canonicalBrand);
  apply("color", canonicalColor);
  apply("secondaryColor", canonicalColor);
  apply("tertiaryColor", canonicalColor);
  apply("material", canonicalMaterial);
  apply("fit", canonicalFit);
  return out as T;
}

/** Every canonical name for a field. Exposed for tests and for vocabulary seeding. */
export function canonicalNames(field: NormalizeField): string[] {
  return Object.keys(TABLES[field]);
}
