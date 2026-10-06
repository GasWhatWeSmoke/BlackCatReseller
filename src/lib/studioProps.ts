// The studio ruler that lies beside every garment for the measurement photos is
// printed "Empire Model 403", and batch 39 shipped eight items carrying that as
// their brand, model, or style number. Intake now drops the ruler's print before
// anything is stored (worker/black_cat_worker/props.py is the one list of studio
// props), and this is the same rule at the other end of the pipe: whatever sits
// in a column or in aiRaw, the ruler's maker and model never reach a title, a
// public-notes line, or a key detail. Keep the patterns here in step with props.py.

const PROP_BRAND_KEYS = new Set(["empire", "empir", "empire brand", "empire level"]);
// "Model 403", "403", "MODEL403", "Empire Model 403", "Mordel 403" (an OCR misread).
const PROP_CODE_RE = /^(?:empir[eé]?\s*)?(?:m[a-z]{3,5}\s*)?[#.:]?\s*4[0o]3$/i;
// The ruler written into prose or a list entry. "Empire" alone is deliberately not
// here: an empire waist is a silhouette. JavaScript's \b is ASCII-only, so the
// accented spelling ends on a lookahead rather than a word boundary.
const PROP_MENTION_RE =
  /\bempir[eé]\s*®?(?:\s+brand)?\s+model\s*403\b|\bmodel\s*403\b|\bempiré(?![a-z0-9])|\bempir[eé]\s*®?\s+(?:brand|logo)\b|\bruler\b|\btape\s+measure\b|\bmeasuring\s+tape\b/i;

// Same key as normalize.ts's normalizeKey (kept local so the two modules stay acyclic).
function key(raw: string): string {
  return raw.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** The ruler's maker offered as a brand. */
export function isStudioPropBrand(v: unknown): boolean {
  return typeof v === "string" && PROP_BRAND_KEYS.has(key(v));
}

/** The ruler's own model number offered as a model or style number. */
export function isStudioPropCode(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.replace(/\s+/g, " ").trim();
  return !!t && (isStudioPropBrand(t) || PROP_CODE_RE.test(t));
}

/** A graphic, key detail, or sentence that is about the ruler. */
export function mentionsStudioProp(v: unknown): boolean {
  return typeof v === "string" && PROP_MENTION_RE.test(v);
}

// The ruler in a FINISHED title: its model number anywhere, its maker in the brand slot
// (the first word) or written as "Empire brand" / "Empire model". An empire waist and an
// "Empire State" graphic are not the ruler. This is the last check, at approval time.
const PROP_IN_TITLE_RE = /\b4[0o]3\b|\bempiré|^\s*empir[eé](?![a-z])|\bempir[eé]\s+(?:brand|model)\b/i;
export function titleCarriesStudioProp(title: string | null | undefined): boolean {
  return !!title && PROP_IN_TITLE_RE.test(title);
}

/**
 * A title-shaped line (a custom title, a stored public-notes line) with the ruler's
 * tokens cut out: "Rocky Mountain 403 Unisex Jeans" -> "Rocky Mountain Unisex Jeans".
 * Empty in, empty out, so callers can `||` onto the generated line.
 */
export function stripStudioPropTokens(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\bempir[eé]\s*®?(?:\s+brand)?\s+model\s*4[0o]3\b/gi, " ")
    .replace(/\bmodel\s*4[0o]3\b/gi, " ")
    .replace(/\b4[0o]3\b/g, " ")
    .replace(/^\s*empir[eé](?![a-z0-9])\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scrub the ruler out of the attributes a title is built from. Works on a stored
 * Item row (keyDetails as a newline/comma list) and on the preview's ListingItem
 * (keyDetails as an array) alike. Brand falls back to "Unknown", which is what the
 * title builder already treats as "no brand".
 */
export function scrubStudioProps<T extends Record<string, unknown>>(it: T): T {
  const out: Record<string, unknown> = { ...it };
  if (isStudioPropBrand(out.brand)) out.brand = "Unknown";
  if (isStudioPropBrand(out.subBrand)) out.subBrand = null;
  for (const k of ["model", "styleNumber"]) {
    if (isStudioPropCode(out[k])) out[k] = null;
  }
  const details = out.keyDetails;
  if (Array.isArray(details)) {
    out.keyDetails = details.filter((d) => !mentionsStudioProp(d));
  } else if (typeof details === "string" && mentionsStudioProp(details)) {
    const kept = details.split(/[\n,]+/).map((d) => d.trim()).filter((d) => d && !mentionsStudioProp(d));
    out.keyDetails = kept.length ? kept.join("\n") : null;
  }
  return out as T;
}
