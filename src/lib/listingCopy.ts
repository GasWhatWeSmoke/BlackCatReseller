// The listing copy that actually SHIPS — title, description, category and the
// attribute resolution behind them.
//
// This was inlined in export-item.ts, which meant only the exporter could answer
// "what would this item be listed as right now". The Listings tab has to answer the
// same question WITHOUT writing files or touching the database, and it must get the
// identical answer — a screen that shows one title and pushes another is worse than
// no screen. So the computation lives here, pure, and export-item.ts calls it.
//
// It is deliberately NOT previewListingItem(): that one layers unsaved form edits over
// stored columns for a live-typing preview and reads `sleeve` as if it were a column.
// Export DERIVES sleeve from the style/notes/details, which is why an exported title
// can say "Long Sleeve" when the preview does not. This module is the export truth.
import {
  buildListing, isEtsyAllowed, isVintage, sanitizeDescription, isDescriptionWeak,
  assessTitle, cleanAttr, measurementClause, desalesify, marketingHits, detectSleeve,
  collarCutFromNotes, autoOneSize, itemCategory, buildTitleWithMeta,
} from "./listing.ts";
import { canonicalizeListingAttributes } from "./normalize.ts";
import { stripStudioPropTokens } from "./studioProps.ts";
import { ocrTagText } from "./listing.ts";
import { normalizeWhenMade, VINTAGE_WHEN_MADE_DEFAULT } from "./listingOptions.ts";

/** The Item columns the copy is built from (a structural subset of the Prisma row). */
export interface CopySource {
  sku: string;
  /** NOT NULL in the schema — defaults to "Unknown", never blank. */
  brand: string;
  size: string | null;
  itemType: string | null;
  category: string | null;
  color: string | null;
  pattern: string | null;
  condition: string | null;
  whenMade: string | null;
  department: string | null;
  material: string | null;
  style: string | null;
  secondaryColor: string | null;
  tertiaryColor: string | null;
  fit: string | null;
  model: string | null;
  styleNumber: string | null;
  subBrand: string | null;
  countryOfOrigin: string | null;
  closure: string | null;
  neckline: string | null;
  lining: string | null;
  graphics: string | null;
  keyDetails: string | null;
  aesthetic: string | null;
  description: string | null;
  customTitle: string | null;
  notes: string | null;
  publicNotes: string | null;
  inseam: string | null;
  chestIn: string | null;
  lengthIn: string | null;
  sleeveIn: string | null;
  shoulderIn: string | null;
  waistIn: string | null;
  hipIn: string | null;
  riseIn: string | null;
  trueVintage: boolean;
  etsyEligible: string | null;
  aiRaw: string | null;
}

export interface ExportCopy {
  /** Generated title before an operator custom-title override is applied. */
  autoTitle: string;
  /** Exact key-detail phrase that survives in autoTitle, if one fills that slot. */
  autoTitleKeyDetail: string | null;
  title: string;
  description: string;
  category: string;
  publicNotes: string;
  /** Nifty's exact "When was it made?" option string. */
  whenMade: string;
  /** Derived, not stored: "Long Sleeve" / "Short Sleeve" / null. */
  sleeve: string | null;
  /** The size as exported — auto "One Size" for a size-less accessory. */
  exportSize: string | null;
  categoryGroup: string;
  collarCut: boolean;
  department: string | null;
  material: string | null;
  style: string | null;
  neckline: string | null;
  secondaryColor: string | null;
  fit: string | null;
  trueVintage: boolean;
  etsyEligible: string;
  etsyAllowed: boolean;
  /** Non-blocking quality notes ("description is thin/generic", "rewrote salesy…"). */
  copyWarnings: string[];
}

const splitText = (s: string | null): string[] | null => {
  if (!s) return null;
  const arr = s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : null;
};

export function buildExportCopy(item: CopySource): ExportCopy {
  // Extra AI-detected attributes (for marketplace item specifics) live in aiRaw.
  let ai: Record<string, unknown> = {};
  try { ai = item.aiRaw ? JSON.parse(item.aiRaw) : {}; } catch { ai = {}; }
  const aiStr = (k: string) => cleanAttr(ai[k]) ?? null;
  const aiArr = (k: string) =>
    Array.isArray(ai[k]) ? ((ai[k] as unknown[]).map(cleanAttr).filter(Boolean) as string[]) : null;
  // Prefer the user-edited columns; fall back to the AI-detected raw for older items.
  const department = item.department ?? aiStr("department");
  const material = item.material ?? aiStr("material");
  const secondaryColor = item.secondaryColor ?? aiStr("secondaryColor");
  const fit = item.fit ?? aiStr("fit");
  // "Collar was cut off" note = the garment is MODIFIED: it must not be titled or
  // labeled a crewneck anymore (title, eBay Style specific, neckline all honor this).
  const collarCut = collarCutFromNotes(item.notes);
  const rawStyle = item.style ?? aiStr("style");
  const style = collarCut && /crew/i.test(rawStyle || "") ? null : rawStyle;
  const rawNeckline = item.neckline ?? aiStr("neckline");
  const neckline = collarCut && /crew/i.test(rawNeckline || "") ? null : rawNeckline;
  // Sleeve length worth stating ("Long Sleeve"): read everything we know — the style,
  // notes, AI key details, and the AI's own photo description — so a long-sleeve tee
  // is titled as one even though its item type is just "T-shirt".
  const aiDesc = typeof ai["description"] === "string" ? (ai["description"] as string) : "";
  const kdArr = ((): string[] => {
    // Null means an older row whose rich details were never promoted, so retain the
    // aiRaw fallback. An empty string means the operator deliberately cleared every
    // detail in Review and must not resurrect the AI keywords on export.
    if (item.keyDetails !== null && item.keyDetails !== undefined) {
      return item.keyDetails.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    }
    return aiArr("keyDetails") ?? [];
  })();
  // Top-level category (Clothing/Bag/Jewelry/Hat/Shoes/Accessory) — routes the
  // size default, the assist's category drilling, and skips garment-only logic.
  const categoryGroup = itemCategory(item.category, item.itemType);
  const isClothing = categoryGroup === "Clothing";
  // Sleeve detection is garment logic — a scarf's "long" must never become "Long Sleeve".
  const sleeve = (isClothing ? detectSleeve(
    [rawStyle, item.itemType, item.notes, kdArr.join(" "), aiDesc].filter(Boolean).join(" "),
  ) : "") || null;
  // A size-less accessory exports as Nifty's own "One Size" where that's the honest
  // answer (bags, jewelry sans rings, scarves, hats); ring/fitted sizes stay operator-set.
  const exportSize = item.size ?? (autoOneSize(item.itemType, item.category) ? "One Size" : null);

  // True Vintage — the operator's one-click "this is 20+ years old" flag (legacy items
  // may instead carry etsyEligible="vintage").
  const trueVintage = item.trueVintage || item.etsyEligible === "vintage";
  // Etsy era — normalize to Nifty's EXACT option string so the assist exact-matches it.
  // If True Vintage but the era is still modern, force a safe vintage era (the box alone
  // must be enough for Etsy to read it as vintage). Computed before the title so a
  // genuinely-vintage item also earns the "Vintage" keyword.
  let whenMade = normalizeWhenMade(item.whenMade);
  if (trueVintage && !isVintage(whenMade)) whenMade = VINTAGE_WHEN_MADE_DEFAULT;

  // Build listing copy with the FULL attribute set so the TITLE gets strong, ordered
  // keywords (brand/gender/pattern/style/colors/key-detail/fit/size) and the fallback
  // description is rich (construction/graphics/aesthetic), not just brand+color+type.
  // Rich detail: prefer the editable column, fall back to the raw vision JSON (B27).
  //
  // Same canonicalization the live preview applies, so what an operator approved on
  // screen is what lands in the listing -- the database really did hold "Quiksilver"
  // and "Quicksilver" as two brands.
  const listingItem = canonicalizeListingAttributes({
    ...item, style, material, secondaryColor, department, fit, whenMade, sleeve, neckline,
    tagText: ocrTagText(ai),
    tertiaryColor: item.tertiaryColor ?? aiStr("tertiaryColor"),
    closure: item.closure ?? aiStr("closure"),
    lining: item.lining ?? aiStr("lining"),
    graphics: splitText(item.graphics) ?? aiArr("graphics"),
    keyDetails: kdArr.length ? kdArr : null,
    aesthetic: splitText(item.aesthetic) ?? aiArr("aesthetic"),
  });
  const autoTitle = buildTitleWithMeta(listingItem);
  const listingCopy = buildListing(listingItem);
  // Operator title override: a non-blank customTitle replaces the generated title on
  // everything downstream (item.json, notes.txt, niftyTitle → so the sync still matches
  // the title actually live on Nifty).
  // The ruler's tokens are cut out of an operator title too (see studioProps.ts).
  const customTitle = stripStudioPropTokens(item.customTitle);
  if (customTitle) listingCopy.title = customTitle.slice(0, 80);
  // A stored public-notes line is the generated title as it was at export time,
  // so it can carry the ruler after the fields it came from were cleaned.
  const publicNotes = stripStudioPropTokens(item.publicNotes) || listingCopy.publicNotes;
  // Description source — keep public copy factual, never salesy:
  //  • Heavily salesy column copy (>=2 marketing markers) → REBUILD from the structured
  //    fields. The deterministic builder is factual by construction, and the fields (brand,
  //    color, material, graphics, measurements…) carry the real facts, so this is cleaner
  //    and safer than surgically rewriting marketing prose.
  //  • Mild/clean column copy → de-hyped (desalesify) and used if still strong.
  //  • Otherwise → the deterministic builder.
  const rawColDesc = sanitizeDescription(item.description);
  const descHype = marketingHits(rawColDesc);
  const colDesc = desalesify(rawColDesc);
  const builderDesc = listingCopy.description;
  const heavySalesy = descHype.length >= 2;
  let description: string;
  let descRebuilt = false;
  if (heavySalesy && !isDescriptionWeak(builderDesc)) {
    description = builderDesc; descRebuilt = true;
  } else if (!isDescriptionWeak(colDesc)) {
    description = colDesc;
  } else {
    description = builderDesc; descRebuilt = true;
  }
  // Append flat measurements to whatever description we use (the vision/operator copy may
  // not list them) — unless already present (B10).
  const measClause = measurementClause(item as unknown as Parameters<typeof measurementClause>[0]);
  if (measClause && !/\bmeasures\b/i.test(description)) description = `${description} ${measClause}`.trim();
  // Disclosure guarantee: operator notes ("Collar is cut off", "Slight Fade") are public
  // flaw/modification info. The deterministic builder includes them, but the vision-copy
  // path didn't. Append BEFORE the final de-hype + crewneck passes so the note text gets
  // the same treatment (a hype-y or crewneck-mentioning note can't sneak through), and
  // dedup on NORMALIZED text (desalesify may have reworded punctuation inside the
  // builder's copy — naive containment appended the note twice).
  const noteText = sanitizeDescription(item.notes);
  if (noteText) {
    const normTxt = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const naked = noteText.replace(/[.\s]+$/, "");
    if (naked && !normTxt(description).includes(normTxt(naked))) {
      description = `${description} ${naked}.`.trim();
    }
  }
  // Final guarantee: no salesy phrasing survives in the exported copy (idempotent).
  description = desalesify(description);
  // A cut collar means the garment isn't a crewneck anymore — the vision-written copy
  // often still calls it one, so scrub the word from whatever description was chosen.
  // Handles noun uses ("has a crewneck and…", "with a crewneck.") and adjective uses
  // ("black crewneck t-shirt"), then stitches the grammar back together.
  if (collarCut) {
    description = description
      // noun position (take the article along): "has a crewneck and…" → "has and…"
      .replace(/(?:\b(?:a|an|the)\s+)?crew[\s-]?neck(?:line)?(?:\s+collar)?(?=\s*(?:[,.;:!?)]|and\b|with\b)|\s*$)/gi, "")
      // adjective position: "black crewneck t-shirt" → "black t-shirt"
      .replace(/\bcrew[\s-]?neck(?:line)?\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\b(has|have|features?|includes?|with)\s+(?:and|,)\s*/gi, "$1 ")
      .replace(/\b(has|have|features?|includes?)\s*,\s*/gi, "$1 ")
      .replace(/,\s+and\b/gi, " and")
      .replace(/\s+(?:and|with|a|an|the|plus|featuring)\s*([.,;:!?])/gi, "$1")
      .replace(/,\s*([.;:!?])/g, "$1")
      .replace(/\s+([.,;:!?])/g, "$1").trim();
  }
  // Quality check (non-blocking): flag weak/generic/salesy copy so the operator sees it (B29).
  const titleCheck = assessTitle(listingCopy.title);
  const copyWarnings: string[] = [];
  if (!titleCheck.ok) copyWarnings.push(`title: ${titleCheck.issues.join(", ")}`);
  if (descHype.length) {
    copyWarnings.push(descRebuilt
      ? `rebuilt description from item details (original was salesy: ${descHype.slice(0, 3).join(", ")})`
      : `rewrote salesy phrasing (removed: ${descHype.slice(0, 4).join(", ")})`);
  }
  if (isDescriptionWeak(description)) copyWarnings.push("description is thin/generic");

  const etsyEligible = trueVintage ? "vintage" : (item.etsyEligible ?? "none");
  return {
    autoTitle: autoTitle.title, autoTitleKeyDetail: autoTitle.keyDetail,
    title: listingCopy.title, description, category: listingCopy.category, publicNotes,
    whenMade, sleeve, exportSize, categoryGroup, collarCut,
    department, material, style, neckline, secondaryColor, fit,
    trueVintage, etsyEligible, etsyAllowed: isEtsyAllowed(etsyEligible, whenMade, trueVintage),
    copyWarnings,
  };
}
