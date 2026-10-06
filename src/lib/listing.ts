// Builds listing copy (title / description / category) from an item's detected
// attributes. Used by the export so item.json + notes.txt carry ready-to-use
// text, and so the assisted upload can auto-fill Nifty's fields.
// Brand-privacy rule: never surface an "Unknown" brand publicly.

import { titleCarriesStudioProp } from "./studioProps.ts";

export interface ListingItem {
  sku: string;
  brand: string;
  color: string | null;
  secondaryColor?: string | null;
  tertiaryColor?: string | null;
  pattern: string | null;
  itemType: string | null;
  // Top-level category (Clothing | Bag | Jewelry | Hat | Shoes | Accessory) — AI-detected,
  // editable. Routes size requirements, weight/dims fallbacks, and Nifty category drilling
  // for non-clothing items. Null = legacy item, treated as Clothing.
  category?: string | null;
  // AI-detected style descriptor (e.g. "Bomber", "Cargo", "Crewneck") and main
  // fabric (e.g. "Nylon", "Denim") — used to strengthen the title keywords.
  style?: string | null;
  material?: string | null;
  // Sleeve length when it's title-worthy ("Long Sleeve"), detected by the export from
  // the vision read + notes. A long-sleeve tee MUST say so in the title (user rule).
  sleeve?: string | null;
  // Who it's styled for ("Men"/"Women"/"Unisex"/"Kids") -> a gender title keyword.
  department?: string | null;
  // Cut/fit ("Slim","Relaxed","Oversized",...) — title keyword + description detail.
  fit?: string | null;
  /** The product line a buyer searches for after the brand: "501", "Detroit Jacket". */
  model?: string | null;
  /** A style/product number printed on a tag. Falls back for the model token. */
  styleNumber?: string | null;
  /** A sub-line that materially changes the item: "Silver Tab", "Reverse Weave". */
  subBrand?: string | null;
  /** Read off a care label. Gates the "Made in USA" keyword, which is never guessed. */
  countryOfOrigin?: string | null;
  // Construction details the vision model reads off the photos (best-effort).
  closure?: string | null;     // "Full Zip", "Snap-Button", "Pullover", ...
  neckline?: string | null;    // "Ribbed Collar", "Hooded", "Crewneck", ...
  lining?: string | null;      // "Quilted", "Fleece-Lined", ...
  // Visible graphics / patches / prints / readable text, each a short phrase.
  graphics?: string[] | null;
  // Short standout keywords for the title ("Patches","Embroidered","Quilted").
  keyDetails?: string[] | null;
  // Style/aesthetic tags ("vintage racing","streetwear","varsity","Y2K").
  aesthetic?: string[] | null;
  size: string | null;
  // Flat measurements in inches (operator-measured), added to the description.
  inseam?: string | null;
  chestIn?: string | null;
  lengthIn?: string | null;
  sleeveIn?: string | null;
  shoulderIn?: string | null;
  waistIn?: string | null;
  hipIn?: string | null;
  riseIn?: string | null;
  // Etsy "When was it made?" era; drives a "Vintage" keyword when 20+ years old.
  whenMade?: string | null;
  // Resale condition (CONDITION_OPTIONS). "New with tags" earns an NWT title keyword —
  // it is the single strongest buy signal on a resale listing, and buyers filter and
  // scan for it in the title itself.
  condition?: string | null;
  notes: string | null;
  /** The stored description: read for facts it STATES (Made in USA, 100% fabric) that belong in the title. */
  description?: string | null;
  /** What tag OCR read off the labels, joined: the label stating the same facts itself. */
  tagText?: string | null;
}

// Flat garment measurements (inches). Keys map to Item columns. Shown per garment type.
export const MEASUREMENTS: { key: string; label: string; word: string }[] = [
  { key: "chestIn", label: "Chest / Pit-to-Pit", word: "chest" },
  { key: "lengthIn", label: "Length", word: "length" },
  { key: "sleeveIn", label: "Sleeve", word: "sleeve" },
  { key: "shoulderIn", label: "Shoulder", word: "shoulder" },
  { key: "waistIn", label: "Waist", word: "waist" },
  { key: "hipIn", label: "Hip", word: "hip" },
  { key: "riseIn", label: "Rise", word: "rise" },
];

const TOP_TYPES = ["t-shirt", "tee", "shirt", "blouse", "top", "hoodie", "sweatshirt", "sweater",
  "cardigan", "jacket", "coat", "blazer", "vest", "flannel", "polo", "henley", "bomber", "windbreaker", "parka"];
const BOTTOM_TYPES = ["pants", "jeans", "chino", "trouser", "slacks", "jogger", "sweatpant", "cargo", "legging", "shorts", "skirt"];
const DRESS_TYPES = ["dress", "romper", "jumpsuit"];

// ---- Accessory / non-clothing type routing -------------------------------------
// The vision model now emits SPECIFIC types ("Crossbody Bag", "Bucket Hat",
// "Necklace"). These sets route a specific type to its family so weight/dims/
// category/size behavior degrade sensibly instead of falling to garment defaults.
const BAG_TYPES = ["handbag", "purse", "shoulder bag", "crossbody", "tote", "backpack", "clutch",
  "messenger", "duffel", "duffle", "wallet", "pouch", "fanny pack", "belt bag", "satchel", "bag"];
const JEWELRY_TYPES = ["necklace", "bracelet", "ring", "earring", "earrings", "brooch", "watch",
  "pendant", "chain", "anklet", "cufflink", "jewelry"];
const HAT_TYPES = ["baseball cap", "snapback", "trucker hat", "dad hat", "beanie", "bucket hat",
  "cowboy hat", "fedora", "visor", "sun hat", "beret", "cap", "hat"];
const SIZELESS_ACCESSORY_TYPES = ["scarf", "bandana", "sunglasses", "tie", "keychain",
  "hair accessory", "headband", "wristband", "lanyard", "pin", "patch"];

// WORD-boundary type matching (2026-08-06 review fix): the old substring check
// routed "Tie-Dye Shirt" to Accessory (…"tie"…), "Patchwork Jeans" to Accessory
// ("patch"), and "Earrings" past autoOneSize's "ring" exclusion. An entry matches
// only as a whole whitespace token (singular/plural tolerated) or, for multi-word
// entries, as a word-bounded phrase — "tie-dye" is one token and never matches "tie".
function typeIn(itemType: string | null | undefined, list: string[]): boolean {
  const k = (itemType || "").trim().toLowerCase();
  if (!k) return false;
  const tokens = k.split(/\s+/);
  const tokMatch = (tok: string, t: string) => tok === t || tok === `${t}s` || `${tok}s` === t;
  return list.some((t) =>
    t.includes(" ") ? ` ${k} `.includes(` ${t} `) : tokens.some((tok) => tokMatch(tok, t)),
  );
}

// Garment nouns that pin a type to Clothing no matter what other words surround
// them — checked FIRST so "Tie-Dye Shirt"/"Patchwork Jeans"/"Pinstripe Trousers"
// can never be dragged into an accessory family by a qualifier word.
const CLOTHING_NOUNS = ["shirt", "t-shirt", "tshirt", "tee", "top", "blouse", "polo", "henley",
  "hoodie", "sweatshirt", "sweater", "cardigan", "pullover", "turtleneck", "jacket", "coat",
  "blazer", "vest", "flannel", "windbreaker", "parka", "bomber", "jersey", "uniform",
  "pants", "jeans", "chinos", "trousers", "slacks", "joggers", "sweatpants", "leggings",
  "shorts", "skirt", "dress", "gown", "romper", "jumpsuit", "overalls", "tank", "camisole",
  "cami", "kimono", "poncho", "robe", "swimsuit", "bikini", "trunks"];

// Canonical top-level category from the stored category column and/or the itemType.
// Prefers the explicit column; falls back to inferring from the type string.
// Inference order matters: garment nouns first, and Hat BEFORE Jewelry so a
// "Watch Cap" (a beanie) is headwear, not a watch.
export function itemCategory(category: string | null | undefined, itemType: string | null | undefined): string {
  const c = (category || "").trim().toLowerCase();
  if (c) {
    if (c.startsWith("cloth") || c.startsWith("apparel") || c.startsWith("garment")) return "Clothing";
    if (c.startsWith("bag") || c.startsWith("purse")) return "Bag";
    if (c.startsWith("jewel")) return "Jewelry";
    if (c.startsWith("hat") || c.startsWith("headwear")) return "Hat";
    if (c.startsWith("shoe") || c.startsWith("footwear")) return "Shoes";
    if (c.startsWith("accessor")) return "Accessory";
  }
  if (typeIn(itemType, CLOTHING_NOUNS)) return "Clothing";
  if (typeIn(itemType, BAG_TYPES)) return "Bag";
  if (typeIn(itemType, HAT_TYPES)) return "Hat";
  if (typeIn(itemType, JEWELRY_TYPES)) return "Jewelry";
  if (typeIn(itemType, ["sneaker", "boot", "sandal", "heel", "loafer", "shoe"])) return "Shoes";
  if (typeIn(itemType, SIZELESS_ACCESSORY_TYPES) || typeIn(itemType, ["belt", "glove"])) return "Accessory";
  return "Clothing";
}

// Whether a blank size may pass the Ready gate for this item. Clothing and shoes
// always need a size; rings/belts/hats CAN have one (kept optional so a known size
// still exports) and everything else accessory-shaped simply has none.
export function sizelessOk(itemType: string | null | undefined, category?: string | null): boolean {
  const cat = itemCategory(category, itemType);
  return cat === "Bag" || cat === "Jewelry" || cat === "Hat" || cat === "Accessory";
}

// Types where a blank size should EXPORT as "One Size" (Nifty's own option) —
// bags, most jewelry, scarves. NOT rings (ring sizes matter) and NOT fitted hats.
export function autoOneSize(itemType: string | null | undefined, category?: string | null): boolean {
  if (typeIn(itemType, ["ring", "fitted"])) return false;
  const cat = itemCategory(category, itemType);
  return cat === "Bag" || cat === "Jewelry" || cat === "Hat" || cat === "Accessory";
}

// Exact-key lookup with graceful degradation for specific subtypes: try the full
// lowercased type first, then every contiguous sub-phrase MOST-SPECIFIC-FIRST —
// longest phrase wins, and on equal length the RIGHTMOST phrase wins because
// English compounds put the HEAD NOUN last ("Dress Shirt" is a shirt, not a
// dress; "Baseball Cap" is a cap). Subtypes whose QUALIFIER carries the tuned
// value ("Tote Bag", "Duffel Bag") get explicit compound keys in the tables
// instead of relying on scan order. (2026-08-06 review fix: the earlier
// leftmost tie-break made "Dress Shirt" resolve through "dress".)
function lookupByType<T>(map: Record<string, T>, itemType: string | null): T | undefined {
  const k = (itemType || "").trim().toLowerCase();
  if (!k) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
  const words = k.split(/\s+/);
  for (let len = words.length - 1; len >= 1; len--) {
    for (let start = words.length - len; start >= 0; start--) {
      const phrase = words.slice(start, start + len).join(" ");
      if (Object.prototype.hasOwnProperty.call(map, phrase)) return map[phrase];
    }
  }
  return undefined;
}

// "Measures 22" chest, 28" length and 32" inseam laid flat." or "" if none set. Shared
// by buildDescription and the export so measurements appear in EVERY listing (B10).
export function measurementClause(it: ListingItem): string {
  const parts: string[] = [];
  for (const m of MEASUREMENTS) {
    const v = clean((it as unknown as Record<string, string | null>)[m.key]);
    if (v) parts.push(`${v}" ${m.word}`);
  }
  const inseamV = clean(it.inseam);
  if (inseamV) parts.push(`${inseamV}" inseam`);
  return parts.length ? `Measures ${listPhrase(parts)} laid flat.` : "";
}

// Which flat measurements to show for an item type (inseam stays its own eBay field).
// Accessories reuse the lengthIn column with an honest, type-appropriate label —
// jewelry chains, belts, and scarves are sold by length; rings/earrings/hats need none.
export function measurementsFor(itemType: string | null | undefined, category?: string | null): { key: string; label: string; word: string }[] {
  const k = (itemType || "").trim().toLowerCase();
  const has = (list: string[]) => !!k && list.some((t) => k.includes(t));
  const cat = itemCategory(category, itemType);
  if (cat === "Bag")
    return [{ key: "lengthIn", label: "Width (longest side)", word: "wide" }];
  if (cat === "Jewelry") {
    if (has(["ring", "earring", "brooch", "watch"])) return [];
    return [{ key: "lengthIn", label: "Chain / Overall Length", word: "long" }];
  }
  if (cat === "Hat") return [];
  if (cat === "Accessory") {
    if (has(["belt", "scarf", "tie", "bandana"]))
      return [{ key: "lengthIn", label: "Length", word: "long" }];
    return [];
  }
  let keys: string[];
  if (has(BOTTOM_TYPES)) keys = ["waistIn", "riseIn", "hipIn", "lengthIn"];
  else if (has(DRESS_TYPES)) keys = ["chestIn", "waistIn", "hipIn", "lengthIn"];
  else if (has(TOP_TYPES)) keys = ["chestIn", "lengthIn", "sleeveIn", "shoulderIn"];
  else keys = ["chestIn", "lengthIn"];
  return MEASUREMENTS.filter((m) => keys.includes(m.key));
}

export interface ListingCopy {
  title: string;
  description: string;
  category: string;
  publicNotes: string;
}

// Estimated SHIP weight in ounces (garment + a poly mailer / light box), keyed by
// item type. Resale shipping is usually quoted in lb/oz; these are deliberately a
// touch generous so postage isn't underpaid. Editable per item in Review.
// Realistic shipped weights (garment + poly mailer), in ounces. Editable per
// item in Review. "Jacket" defaults light (track/denim/bomber ≈ 1 lb); bump in
// Review for a heavy leather/wool coat.
const WEIGHT_OZ: Record<string, number> = {
  // light tops
  "t-shirt": 6, tee: 6, "tank top": 4, tank: 4, cami: 4, camisole: 4, top: 7, blouse: 7,
  shirt: 8, "dress shirt": 9, polo: 8, henley: 9, "long sleeve": 9,
  // medium
  hoodie: 22, sweatshirt: 18, sweater: 16, cardigan: 16, vest: 10, flannel: 12,
  pants: 16, jeans: 24, chinos: 16, leggings: 7, joggers: 16, sweatpants: 16,
  shorts: 9, dress: 10, skirt: 9, romper: 12, jumpsuit: 16,
  // heavier outerwear
  jacket: 24, blazer: 20, coat: 40, parka: 44, windbreaker: 14, bomber: 22,
  // hats
  hat: 4, cap: 4, snapback: 5, beanie: 3, "bucket hat": 4, "cowboy hat": 14,
  fedora: 9, visor: 3, beret: 3, "sun hat": 5,
  // bags (shipped in a box or padded mailer) — compound keys pin the subtype
  // values (the head-noun-last scan would otherwise resolve "Tote Bag" -> "bag")
  bag: 16, purse: 16, handbag: 18, "shoulder bag": 16, crossbody: 12,
  "crossbody bag": 12, tote: 18, "tote bag": 18, backpack: 26, clutch: 8,
  messenger: 22, "messenger bag": 22, duffel: 34, "duffel bag": 34, duffle: 34,
  "duffle bag": 34, wallet: 6, pouch: 5, satchel: 20, "fanny pack": 8,
  // jewelry (small padded mailer / box)
  jewelry: 3, necklace: 3, bracelet: 3, ring: 2, earring: 2, earrings: 2,
  brooch: 2, watch: 8, pendant: 3, chain: 3, anklet: 2,
  // other accessories
  scarf: 4, belt: 7, tie: 3, gloves: 4, bandana: 2, sunglasses: 6,
  shoes: 32, sneakers: 36, boots: 48, sandals: 18, heels: 26,
};

export function estimateWeightOz(itemType: string | null): number {
  return lookupByType(WEIGHT_OZ, itemType) ?? 12; // safe default for unknown types
}

// Package DIMENSIONS (inches). Drew ships in a POLY MAILER (~10 x 13 x 1 in) — folded
// down for small/light items, a bit thicker for bulky ones. So dimensions track the
// mailer, not a box. Shoes/bags are the exception (a mailer won't do — use a box).
export interface PackageDims { length: number; width: number; height: number; }
const DIMS_SMALL: PackageDims = { length: 9, width: 6, height: 1 };    // mailer folded for small/light items
const DIMS_TINY: PackageDims = { length: 7, width: 5, height: 2 };     // small padded mailer/box (jewelry, wallets)
const DIMS_MAILER: PackageDims = { length: 13, width: 10, height: 1 }; // standard poly mailer, flat (~10x13x1)
const DIMS_BULKY: PackageDims = { length: 13, width: 10, height: 3 };  // mailer stuffed with a bulky item
const DIMS_BOX: PackageDims = { length: 13, width: 10, height: 5 };    // shoes/bags/structured hats — needs a box
const DIMS_BOX_LARGE: PackageDims = { length: 18, width: 14, height: 8 }; // backpacks/duffels

const DIMS_BY_TYPE: Record<string, PackageDims> = {
  // small / light — fold the mailer down
  "t-shirt": DIMS_SMALL, tee: DIMS_SMALL, "tank top": DIMS_SMALL, tank: DIMS_SMALL,
  cami: DIMS_SMALL, camisole: DIMS_SMALL, top: DIMS_SMALL, blouse: DIMS_SMALL,
  polo: DIMS_SMALL, henley: DIMS_SMALL, "long sleeve": DIMS_SMALL, leggings: DIMS_SMALL,
  scarf: DIMS_SMALL, belt: DIMS_SMALL, hat: DIMS_SMALL, cap: DIMS_SMALL, beanie: DIMS_SMALL,
  snapback: DIMS_SMALL, visor: DIMS_SMALL, beret: DIMS_SMALL, tie: DIMS_SMALL,
  gloves: DIMS_SMALL, bandana: DIMS_SMALL, "bucket hat": DIMS_SMALL,
  // tiny — jewelry & co. ship in a small padded mailer/box
  jewelry: DIMS_TINY, necklace: DIMS_TINY, bracelet: DIMS_TINY, ring: DIMS_TINY,
  earring: DIMS_TINY, earrings: DIMS_TINY, brooch: DIMS_TINY, watch: DIMS_TINY,
  pendant: DIMS_TINY, chain: DIMS_TINY, anklet: DIMS_TINY, wallet: DIMS_TINY,
  pouch: DIMS_TINY, sunglasses: DIMS_TINY,
  // standard garments — poly mailer flat (~10x13x1)
  shirt: DIMS_MAILER, "dress shirt": DIMS_MAILER, pants: DIMS_MAILER, jeans: DIMS_MAILER,
  chinos: DIMS_MAILER, joggers: DIMS_MAILER, sweatpants: DIMS_MAILER, shorts: DIMS_MAILER,
  dress: DIMS_MAILER, skirt: DIMS_MAILER, romper: DIMS_MAILER, windbreaker: DIMS_MAILER,
  vest: DIMS_MAILER, flannel: DIMS_MAILER, sandals: DIMS_MAILER,
  // bulky — same mailer footprint, thicker
  hoodie: DIMS_BULKY, sweatshirt: DIMS_BULKY, sweater: DIMS_BULKY, cardigan: DIMS_BULKY,
  jacket: DIMS_BULKY, bomber: DIMS_BULKY, blazer: DIMS_BULKY, coat: DIMS_BULKY,
  parka: DIMS_BULKY, jumpsuit: DIMS_BULKY, clutch: DIMS_BULKY, "fanny pack": DIMS_BULKY,
  // shoes / bags / crushable structured hats — box
  bag: DIMS_BOX, purse: DIMS_BOX, handbag: DIMS_BOX, "shoulder bag": DIMS_BOX,
  crossbody: DIMS_BOX, tote: DIMS_BOX, messenger: DIMS_BOX, satchel: DIMS_BOX,
  "cowboy hat": DIMS_BOX, fedora: DIMS_BOX, "sun hat": DIMS_BOX,
  shoes: DIMS_BOX, sneakers: DIMS_BOX, boots: DIMS_BOX, heels: DIMS_BOX,
  // big bags
  backpack: DIMS_BOX_LARGE, duffel: DIMS_BOX_LARGE, duffle: DIMS_BOX_LARGE,
  "duffel bag": DIMS_BOX_LARGE, "duffle bag": DIMS_BOX_LARGE,
  "tote bag": DIMS_BOX, "crossbody bag": DIMS_BOX, "messenger bag": DIMS_BOX,
};

export function estimateDims(itemType: string | null): PackageDims {
  return lookupByType(DIMS_BY_TYPE, itemType) ?? DIMS_MAILER; // default: the standard poly mailer
}

// ---- Price ESTIMATE (suggestion only) --------------------------------------------
// Ballpark resale listing prices by item type. This feeds the SUGGESTED price shown
// in Review/Pricing (placeholder + one-click apply) — it is NEVER auto-written to
// listedPrice: a listing must never carry a price the operator didn't set (the same
// invariant the assist enforces against Nifty's own suggested price).
const PRICE_BY_TYPE: Record<string, number> = {
  // tops
  "t-shirt": 15, tee: 15, shirt: 18, "dress shirt": 20, blouse: 16, top: 14, polo: 16,
  henley: 16, "tank top": 10, hoodie: 30, sweatshirt: 25, sweater: 24, cardigan: 22,
  flannel: 20, vest: 18,
  // bottoms & dresses
  pants: 22, jeans: 30, chinos: 22, shorts: 18, joggers: 20, sweatpants: 20,
  leggings: 14, dress: 25, skirt: 18, romper: 20, jumpsuit: 25,
  // outerwear
  jacket: 40, bomber: 45, blazer: 30, coat: 50, parka: 55, windbreaker: 28,
  // hats
  hat: 18, cap: 18, snapback: 20, beanie: 12, "bucket hat": 18, "cowboy hat": 35,
  fedora: 22, visor: 10, beret: 14, "sun hat": 16,
  // bags
  bag: 30, purse: 30, handbag: 35, "shoulder bag": 32, crossbody: 30,
  "crossbody bag": 30, tote: 28, "tote bag": 28, backpack: 32, clutch: 20,
  messenger: 35, "messenger bag": 35, duffel: 38, "duffel bag": 38, duffle: 38,
  "duffle bag": 38, wallet: 18, pouch: 12, satchel: 35, "fanny pack": 18,
  // jewelry
  jewelry: 15, necklace: 16, bracelet: 12, ring: 14, earring: 10, earrings: 10,
  brooch: 12, watch: 40, pendant: 14, chain: 18, anklet: 10,
  // other accessories
  scarf: 14, belt: 15, tie: 12, gloves: 12, bandana: 8, sunglasses: 18,
  // shoes
  shoes: 35, sneakers: 40, boots: 45, sandals: 22, heels: 28,
};

// Suggested listing price for the type, or null when we have no basis — callers
// show it as a placeholder/suggestion chip, never write it to listedPrice.
export function estimatePrice(itemType: string | null): number | null {
  return lookupByType(PRICE_BY_TYPE, itemType) ?? null;
}

// eBay requires an inseam for pants-type bottoms — show the BCA field only for those.
const INSEAM_TYPES = ["pants", "jeans", "chino", "trouser", "slacks", "jogger", "sweatpant", "cargo", "legging"];
export function needsInseam(itemType: string | null): boolean {
  const k = (itemType || "").trim().toLowerCase();
  return !!k && INSEAM_TYPES.some((t) => k.includes(t));
}

// Public: is this item allowed on Etsy? Etsy only permits handmade, vintage (20+ yrs),
// or craft/party supplies — NOT modern resale clothing. Vintage is asserted by the
// operator via the True Vintage checkbox (`trueVintage`); the export guarantees a
// vintage era is sent, so the box alone is sufficient. handmade/craft/party come from
// the etsyEligible dropdown. (Legacy items that stored etsyEligible="vintage" still
// resolve true.)
export function isEtsyAllowed(
  etsyEligible: string | null | undefined,
  whenMade: string | null | undefined,
  trueVintage?: boolean,
): boolean {
  if (trueVintage) return true;
  const e = (etsyEligible || "none").toLowerCase();
  if (e === "handmade" || e === "craft" || e === "party") return true;
  if (e === "vintage") return isVintage(whenMade);   // legacy path: era must be 20+ yrs
  return false;
}

export function ozToLb(oz: number): number {
  return Math.round((oz / 16) * 10) / 10; // 1 decimal lb
}

// Split total ounces into whole pounds + remaining ounces (eBay-style).
export function ozToLbOz(oz: number): { lb: number; oz: number } {
  return { lb: Math.floor(oz / 16), oz: oz % 16 };
}

// Coarse category map (itemType -> a generic resale category). Nifty has its own
// taxonomy; this is a sensible default/suggestion, not an exact Nifty category.
const CATEGORY: Record<string, string> = {
  "t-shirt": "Tops & Tees",
  tee: "Tops & Tees",
  shirt: "Tops & Tees",
  top: "Tops & Tees",
  blouse: "Tops & Tees",
  // The vision model names garments the way a person would ("Polo", "long sleeve
  // button down"), not in whatever vocabulary this table happens to use. Anything
  // missing here used to reach Nifty as its own category — a phrase no marketplace
  // taxonomy contains, so the picker matched nothing and the listing was left with
  // "Please select a subcategory". These are the shapes that actually show up.
  polo: "Tops & Tees",
  "button down": "Tops & Tees", "button-down": "Tops & Tees",
  "button up": "Tops & Tees", "button-up": "Tops & Tees",
  henley: "Tops & Tees", flannel: "Tops & Tees", jersey: "Tops & Tees",
  tank: "Tops & Tees", "tank top": "Tops & Tees", camisole: "Tops & Tees",
  turtleneck: "Tops & Tees", crewneck: "Tops & Tees", "long sleeve": "Tops & Tees",
  "short sleeve": "Tops & Tees",
  cardigan: "Sweaters", pullover: "Sweaters", knit: "Sweaters",
  hoodie: "Sweatshirts & Hoodies",
  sweatshirt: "Sweatshirts & Hoodies",
  sweater: "Sweaters",
  jacket: "Coats & Jackets",
  coat: "Coats & Jackets",
  blazer: "Coats & Jackets", bomber: "Coats & Jackets", windbreaker: "Coats & Jackets",
  parka: "Coats & Jackets", anorak: "Coats & Jackets", vest: "Coats & Jackets",
  pants: "Pants",
  trousers: "Pants", chinos: "Pants", chino: "Pants", slacks: "Pants",
  joggers: "Pants", jogger: "Pants", sweatpants: "Pants", sweatpant: "Pants",
  leggings: "Pants", cargos: "Pants", cargo: "Pants", overalls: "Pants",
  jeans: "Jeans", denim: "Jeans",
  shorts: "Shorts",
  "swim trunks": "Shorts", trunks: "Shorts", boardshorts: "Shorts",
  dress: "Dresses",
  skirt: "Skirts",
  jumpsuit: "Jumpsuits & Rompers", romper: "Jumpsuits & Rompers",
  tracksuit: "Activewear", activewear: "Activewear",
  // hats
  hat: "Hats", cap: "Hats", snapback: "Hats", beanie: "Hats", "bucket hat": "Hats",
  "cowboy hat": "Hats", fedora: "Hats", visor: "Hats", beret: "Hats", "sun hat": "Hats",
  // bags
  bag: "Bags & Purses", purse: "Bags & Purses", handbag: "Bags & Purses",
  "shoulder bag": "Bags & Purses", crossbody: "Bags & Purses", tote: "Bags & Purses",
  clutch: "Bags & Purses", messenger: "Bags & Purses", satchel: "Bags & Purses",
  "fanny pack": "Bags & Purses", backpack: "Backpacks", duffel: "Bags & Purses",
  duffle: "Bags & Purses", wallet: "Wallets", pouch: "Bags & Purses",
  // jewelry
  jewelry: "Jewelry", necklace: "Jewelry", bracelet: "Jewelry", ring: "Jewelry",
  earring: "Jewelry", earrings: "Jewelry", brooch: "Jewelry", pendant: "Jewelry",
  chain: "Jewelry", anklet: "Jewelry", watch: "Watches",
  // other accessories
  belt: "Belts", scarf: "Scarves & Wraps", tie: "Ties", gloves: "Gloves & Mittens",
  bandana: "Scarves & Wraps", sunglasses: "Sunglasses",
  shoes: "Shoes",
  sneakers: "Shoes",
};

// Category-level fallback when the specific type isn't mapped ("Hair Accessory",
// a novel bag subtype, ...) so jewelry never exports under "Clothing".
const CATEGORY_BY_GROUP: Record<string, string> = {
  Bag: "Bags & Purses", Jewelry: "Jewelry", Hat: "Hats", Shoes: "Shoes",
  Accessory: "Accessories", Clothing: "Clothing",
};

function brandPart(brand: string): string {
  return brand && brand !== "Unknown" ? brand : "";
}

/**
 * Drop a brand name the vision model folded into the model field ("Wrangler 2000"
 * for a Wrangler). While the brand matches, the title's word de-dupe hides the
 * repeat, so the extra word costs nothing and nobody sees it. The moment the
 * operator corrects the brand, the OLD name keeps riding in the title after the
 * new one, with no field that visibly holds it. Whole-word, case-insensitive;
 * returns what remains, or "" when the model was nothing but the brand.
 */
export function stripBrandFromModel(model: string | null | undefined, brand: string | null | undefined): string {
  const m = clean(model);
  const b = brandPart(clean(brand));
  if (!m || !b) return m;
  const words = b.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(^|\\s)${words.join("\\s+")}(?=\\s|$)`, "i");
  return m.replace(re, "$1").replace(/\s+/g, " ").trim();
}

// Words a vision model emits to mean "I don't know" — never surface them in public copy.
const JUNK_VALUES = new Set([
  "unknown", "none", "n/a", "na", "null", "nil", "not visible", "unclear",
  "no brand", "unbranded", "not applicable", "undefined",
]);
function clean(v: string | null | undefined): string {
  const s = (v || "").trim();
  return !s || JUNK_VALUES.has(s.toLowerCase()) ? "" : s;
}

// Clean a PROMOTED AI attribute (department/material/graphics/etc.) coming out of the
// raw vision JSON, returning undefined for empty/junk so a stringified "null"/"none"
// can never be stored or reach the title/description. Use everywhere raw aiRaw values
// are read (persist, export, preview).
export function cleanAttr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return clean(v) || undefined;
}

// Detect a title-worthy sleeve length from everything we know about the item (style,
// notes, AI key details + description). Only "Long Sleeve" matters — short sleeve is a
// tee's default and would just pad titles. Guards: a word boundary after "sleeve(s)" so
// "…Long Sleeveless…" can never match, and a negation check so "no long sleeves" doesn't.
export function detectSleeve(hay: string | null | undefined): string {
  const h = (hay || "").toLowerCase();
  if (/\b(?:no|not|isn'?t|without|non)[\s-]+(?:a[\s-]+)?long[\s-]*sleeve/.test(h)) return "";
  if (/\blong[\s-]*sleeves?\b/.test(h)) return "Long Sleeve";
  return "";
}

// The operator's "collar was cut off" note means the garment is MODIFIED — it must not
// be titled/labeled a crewneck anymore (user rule). Matches "collar (is/was) cut (off)",
// "cut off collar", "collar removed" — but NOT damage notes like "collar has a small cut"
// (a damaged crewneck collar is still a crewneck).
export function collarCutFromNotes(notes: string | null | undefined): boolean {
  const n = notes || "";
  return /\bcollar\s+(?:is\s+|was\s+|has been\s+|got\s+)?(?:cut|removed)\b|\bcut[\s-]*(?:off[\s-]*)?collar\b|\bcollar[\s-]*(?:cut|chopped)[\s-]*off\b/i.test(n);
}

// "Vintage" (eBay/Etsy) = ~20+ years old. As of 2026 that's pre-2007 eras.
export function isVintage(whenMade: string | null | undefined): boolean {
  const w = (whenMade || "").toLowerCase();
  if (!w) return false;
  if (/\b19\d0s\b/.test(w) || /\b1920s\b/.test(w)) return true; // 1990s, 1980s, ...
  if (w.includes("before")) return true;                        // before 2007 / 1920
  if (w.includes("2000 - 2006") || w.includes("2000-2006")) return true;
  return false;
}

// Collapse repeated words (case-insensitive), keeping first occurrence + casing.
function dedupeWords(s: string): string {
  const seen = new Set<string>();
  return s
    .split(/\s+/)
    .filter((w) => {
      const k = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!k || seen.has(k)) return !k; // keep punctuation-only tokens (e.g. "-")
      seen.add(k);
      return true;
    })
    .join(" ");
}

// Garment-noun synonym groups, so a style descriptor doesn't re-name the item
// type (e.g. style "Graphic Tee" + itemType "T-Shirt" → keep just "Graphic").
const GARMENT_GROUPS = [
  ["tee", "tees", "t-shirt", "tshirt", "shirt", "top"],
  ["hoodie", "sweatshirt"],
  ["jacket", "coat"],
  ["pant", "pants", "trouser", "trousers", "chino", "chinos"],
  ["short", "shorts"],
  ["sweater", "pullover", "knit", "cardigan"],
  ["dress"], ["skirt"],
  // accessory nouns — so style "Crossbody Bag" + itemType "Handbag" keeps "Crossbody",
  // and "Dad Hat" + "Baseball Cap" keeps "Dad", not a doubled noun.
  ["bag", "bags", "handbag", "purse", "tote", "backpack", "clutch", "satchel"],
  ["hat", "hats", "cap", "caps", "beanie"],
  ["necklace", "chain", "pendant"], ["bracelet"], ["ring"], ["earring", "earrings"],
  ["watch"], ["belt"], ["scarf"], ["wallet"],
];

// Reduce a style descriptor to its distinctive part: drop the trailing garment
// noun when the item type already covers it, and drop the style entirely if it
// just restates the item type.
function styleKeyword(style: string | null | undefined, itemType: string | null): string {
  let s = clean(style);
  if (!s) return "";
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const it = norm(itemType || "");
  const grp = GARMENT_GROUPS.find((g) => g.some((w) => norm(w) === it || (!!it && it.includes(norm(w)))));
  if (grp) {
    s = s.split(/\s+/).filter((w) => !grp.some((g) => norm(g) === norm(w))).join(" ").trim();
  }
  if (!s) return "";
  const ss = norm(s);
  if (it && (ss === it || ss.includes(it) || it.includes(ss))) return "";
  return s;
}

// "Men"/"Women"/... -> a gender title keyword ("Mens"/"Womens"/"Unisex"/"Kids").
// (Order matters: "women" contains the substring "men".)
function genderWord(department: string | null | undefined): string {
  const d = (department || "").toLowerCase();
  if (!d) return "";
  if (d.includes("women") || d.includes("ladies") || d.includes("female")) return "Womens";
  if (d.includes("men") || d.includes("male")) return "Mens";
  if (d.includes("unisex")) return "Unisex";
  if (d.includes("kid") || d.includes("boy") || d.includes("girl") || d.includes("youth") || d.includes("child"))
    return "Kids";
  return "";
}

// Up to three distinct, non-empty, deduped colors (primary, secondary, tertiary).
function colorList(it: ListingItem): string[] {
  const out: string[] = [];
  // A solid garment has ONE color. When the vision model still reports a second and
  // third one it is describing stitching, buttons, or a label, and the title read
  // "Blue White Black" for plain blue denim shorts. The extra colors are kept only
  // when the pattern says the garment really is more than one color.
  const solid = clean(it.pattern).toLowerCase() === "solid";
  for (const c of solid ? [it.color] : [it.color, it.secondaryColor, it.tertiaryColor]) {
    const v = clean(c);
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

// Fit as a title keyword. "Regular"/"Standard"/"True to Size" add nothing, so drop them.
function fitWord(fit?: string | null): string {
  const f = clean(fit);
  if (!f) return "";
  if (/^(regular|standard|true to size|normal)$/i.test(f)) return "";
  return f;
}

// Title-case a free tag ("vintage racing" -> "Vintage Racing").
function titleTag(tag?: string | null): string {
  const t = clean(tag);
  return t ? t.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "";
}

// Pattern as a title word. "Multicolor" reads better as "Colorblock" when 2+ colors
// are present; "Solid" is omitted (it's not a search term).
function titlePattern(pattern: string | null | undefined, colorCount: number): string {
  const p = clean(pattern);
  if (!p || p.toLowerCase() === "solid") return "";
  if (p.toLowerCase() === "multicolor") return colorCount >= 2 ? "Colorblock" : "Multicolor";
  return p;
}

// Standard construction features that EVERY such garment has — never listing-worthy copy
// ("belt loops" on jeans, the care tag…). Vision sometimes reports them as details; drop
// them from titles and descriptions alike.
const GENERIC_DETAIL_RE =
  /\b(belt\s*loops?|(care|size|brand|wash|content|fabric)\s*(tag|label)s?|(standard|double|triple)\s+stitching|inner\s+(tag|label))\b/i;
export function isGenericDetail(s: string | null | undefined): boolean {
  return !!s && GENERIC_DETAIL_RE.test(s);
}

// Material is copy-worthy ONLY when it's a stated selling point: "100% …" or a specialty
// fabric. Generic fibers/blends ("cotton", "polyester", "cotton blend") add nothing a
// buyer can't assume and just pad the copy.
const SPECIALTY_MATERIAL_RE =
  /\b(cashmere|merino|wool|silk|linen|leather|suede|denim|fleece|mohair|alpaca|angora|tweed|velvet|corduroy|down)\b/i;
export function materialWorthMentioning(m: string | null | undefined): boolean {
  if (!m) return false;
  return /100\s*%/.test(m) || SPECIALTY_MATERIAL_RE.test(m);
}

// Facts a label, a note, or the description STATES, which belong in the title whenever
// they are stated (user rule): "Made in USA" and a "100% <fabric>" composition. Never
// inferred - the phrase itself has to be there, in the material, the operator's notes,
// the description, a key detail, or the OCR read of the label.
const MADE_IN_USA_RE =
  /\bmade\s+in\s+(?:the\s+)?(?:u\.?\s?s\.?\s?a\.?|united\s+states(?:\s+of\s+america)?)(?![a-z])/i;
const COMPOSITION_RE =
  /\b100\s*%\s*((?:[a-z]+\s+){0,2}(?:cotton|wool|merino|cashmere|silk|linen|polyester|nylon|rayon|viscose|acrylic|leather|suede|denim|lambswool|alpaca|mohair|hemp|lyocell|tencel|modal|cupro|fleece|down|angora|pima))\b/i;
export function statedFacts(
  texts: (string | null | undefined)[],
): { madeInUsa: boolean; composition: string | null } {
  let madeInUsa = false;
  let composition: string | null = null;
  for (const t of texts) {
    if (!t) continue;
    if (!madeInUsa && MADE_IN_USA_RE.test(t)) madeInUsa = true;
    if (!composition) {
      const m = t.match(COMPOSITION_RE);
      // Title-cased from lowercase: the label shouts "100% COTTON", the title says "100% Cotton".
      if (m) {
        const words = m[1].toLowerCase().split(/\s+/).filter(Boolean);
        composition = `100% ${words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}`;
      }
    }
  }
  return { madeInUsa, composition };
}

// The OCR read of the labels as one line of text, prop lines (the ruler) excluded.
export function ocrTagText(raw: unknown): string | null {
  const ocr = raw && typeof raw === "object" ? (raw as { ocr?: unknown }).ocr : null;
  const lines = ocr && typeof ocr === "object" ? (ocr as { lines?: unknown }).lines : null;
  if (!Array.isArray(lines)) return null;
  const texts: string[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const { text, prop } = line as { text?: unknown; prop?: unknown };
    if (prop || typeof text !== "string" || !text.trim()) continue;
    texts.push(text.trim());
  }
  return texts.length ? texts.join(" | ") : null;
}

// The fabric word a buyer types ("Denim Shorts", "Leather Jacket", "Wool Coat"): just
// the specialty fabric, capitalised, never the fiber percentage or a blend phrase.
function titleMaterial(m: string | null | undefined): string {
  const hit = clean(m).match(SPECIALTY_MATERIAL_RE);
  return hit ? titleTag(hit[1]) : "";
}

// First key detail that shares NO word with the title. Whole-word comparison —
// substring matching would wrongly reject "Embroidered Logo" just because the color
// "Red" appears inside "emb-red-oidered". Any overlap at all disqualifies the detail:
// the word de-dupe later strips the repeated word, so "Cargo Pockets" on cargo shorts
// shipped as a bare "Pockets". The next detail is a better title than a fragment.
function pickKeyDetail(keyDetails: string[] | null | undefined, used: string[]): string {
  const usedWords = new Set(used.filter(Boolean).join(" ").toLowerCase().split(/\s+/));
  for (const d of keyDetails ?? []) {
    const v = clean(d);
    if (!v || isGenericDetail(v)) continue;
    const words = v.toLowerCase().split(/\s+/);
    if (words.some((w) => usedWords.has(w))) continue;
    return titleTag(v);
  }
  return "";
}

// A title is weak if it's basically just "Brand ItemType" with no search keywords.
function descriptiveTokenCount(parts: string[]): number {
  return parts.filter(Boolean).length;
}

// A label's registration number, however OCR spaced its digits ("RN4 11965").
const REGISTRATION_IN_TITLE_RE = /\b(?:RN|CA|WPL)\s*#?\s*\d[\d\s]{1,8}\d\b/i;

// Validate a generated title: not too short, not generic, within eBay's 80-char limit.
// Also the two things that have burned us - a label's registration number and the
// studio ruler's print - which are bugs upstream if they ever get this far, and which
// the operator then sees as a warning at approval time rather than on the marketplace.
export function assessTitle(title: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (REGISTRATION_IN_TITLE_RE.test(title)) issues.push("registration number in title");
  if (titleCarriesStudioProp(title)) issues.push("ruler print in title");
  const core = title.replace(/\bsize\b.*$/i, "").trim();
  const words = core.split(/\s+/).filter(Boolean);
  if (title.trim().length < 20) issues.push("too short");
  if (words.length < 4) issues.push("too few keywords");
  if (title.length > 80) issues.push("over 80 chars");
  if (/\bunknown\b/i.test(title)) issues.push("contains 'unknown'");
  return { ok: issues.length === 0, issues };
}

// Keyword-rich, marketplace-style title. Order favors search and mirrors strong resale
// copy: NWT → Brand → Gender → Vintage → Pattern/Aesthetic → Style → Item Type → Colors →
// Key Detail → Fit → Size. Deduped and capped to 80 chars (eBay's limit), trimming the
// lowest-value descriptors first while always keeping Brand, Item Type, and Size.
// Example target: "AKOO Sportswear Mens Colorblock Bomber Jacket Red Blue Yellow Patches Size L".
/** True for the "new, tags still on it" condition, however it was typed.
 *  Matches the CONDITION_OPTIONS value plus the shorthand operators actually use
 *  ("NWT", "new w/ tags"). Deliberately does NOT match "New without tags": that is
 *  a weaker, different claim, and stamping NWT on it would be a false one. */
export function isNewWithTags(condition: string | null | undefined): boolean {
  if (!condition) return false;
  const c = condition.trim().toLowerCase();
  // Reject the NWOT family FIRST: "new without tags" also contains new/with/tags.
  if (/\bnwot\b/.test(c) || /\bwithout\b/.test(c)) return false;
  if (/\bnwt\b/.test(c)) return true;
  return /\bnew\b/.test(c) && /\bw(?:ith|\/)/.test(c) && /\btags?\b/.test(c);
}

/** Capitalise the first letter of every word, leaving the rest of the word ALONE.
 * Tokens reach the title exactly as they were read, so a brand stored as "one step
 * up" or "free people" shipped lowercase mid-title. Lower-casing the remainder would
 * be worse than the bug - it would turn DKNY into Dkny and 4S into 4s - so only a
 * leading lowercase letter is touched. A hyphen or slash starts a new word, which
 * keeps "harley-davidson" -> "Harley-Davidson" and leaves "V-Neck" untouched. */
export function titleCaseWords(text: string): string {
  return text.replace(/(^|[\s\-/([])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

export type TitleBuildResult = {
  title: string;
  /** The key-detail phrase that survived into the finished title, if any. */
  keyDetail: string | null;
};

/** Build the marketplace title plus the source detail Review needs to explain it. */
export function buildTitleWithMeta(it: ListingItem): TitleBuildResult {
  const brand = brandPart(it.brand);
  // The sub-line rides with the brand rather than as its own token: "Levi's Silver
  // Tab" is one name, and splitting it lets the trimmer drop half of it.
  const subBrand = brand ? clean(it.subBrand) : "";
  const brandText =
    subBrand && !` ${brand.toLowerCase()} `.includes(` ${subBrand.toLowerCase()} `)
      ? `${brand} ${subBrand}`
      : brand;
  // The model number is the single strongest search term after the brand -- a buyer
  // hunting Levi's 501 types "501". Only ever what was read, never a guess.
  const model = clean(it.model) || clean(it.styleNumber) || "";
  // "Made in USA" is a real value signal on vintage denim and a fabrication
  // everywhere else, so it is allowed in only when a care label, a note, or the
  // description actually SAYS so - never from a guess. The origin is normalized to
  // letters only and matched exactly: a country that merely CONTAINS these letters
  // is not the USA.
  const originKey = (it.countryOfOrigin ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const facts = statedFacts([it.material, it.notes, it.description, it.tagText, ...(it.keyDetails ?? [])]);
  const madeInUsa = originKey === "usa" || originKey === "unitedstates" || facts.madeInUsa
    ? "Made in USA"
    : "";
  const gender = genderWord(it.department);
  const vintage = isVintage(it.whenMade) ? "Vintage" : "";
  const colors = colorList(it);
  const pat = titlePattern(it.pattern, colors.length);
  const style = styleKeyword(it.style, it.itemType);
  const sleeve = clean(it.sleeve);
  const type = clean(it.itemType);
  const fit = fitWord(it.fit);
  // "Denim Shorts" and "Leather Jacket" are the search phrase; "Shorts" alone is not.
  // Only a specialty fabric earns the slot (see SPECIALTY_MATERIAL_RE) — "Cotton" and
  // "Polyester" are assumed and just pad the title. A STATED "100% <fabric>" is the
  // exception (user rule): it goes in as written, percentage and all.
  const material = facts.composition ?? titleMaterial(it.material);
  const detail = pickKeyDetail(it.keyDetails, [brandText, model, gender, vintage, pat, style, sleeve, material, type, ...colors, fit]);
  // Don't prepend "Size " to a value that already contains it (e.g. "One Size"), or the
  // word-dedupe collapses "Size One Size" -> "Size One" and silently drops the suffix.
  const sizeText = it.size ? (/\bsize\b/i.test(it.size) ? it.size : `Size ${it.size}`) : "";

  // (text, priority): higher = kept longer. 100 = pinned (never dropped).
  // Keep the exact entry object so the metadata below can tell whether the normal
  // 80-character trimming pass removed the chosen detail.
  const detailEntry = { t: detail, p: 56 };
  const seq: { t: string; p: number }[] = [
    // NWT leads: resale buyers scan for it, and it is the one token worth more than
    // any descriptor. p=95 keeps it through trimming until only the pinned
    // brand/type/size remain.
    { t: isNewWithTags(it.condition) ? "NWT" : "", p: 95 },
    { t: brandText, p: 100 },
    // Order here is RENDER order, so the model sits immediately after the brand:
    // "Levi's 501" is the phrase a buyer types, and splitting it with "Mens" makes
    // the title match worse. Priority 88 keeps it below the pinned brand/type/size
    // and the sleeve rule while outranking every descriptor.
    { t: model, p: 88 },
    { t: gender, p: 60 },
    { t: vintage, p: 74 },
    { t: pat, p: 76 },
    { t: style, p: 82 },
    { t: sleeve, p: 90 },   // user rule: a long-sleeve shirt says so in the title
    // Sits directly on the type so the two read as one phrase ("Denim Shorts").
    { t: material, p: 78 },
    { t: type, p: 100 },
    { t: colors[0] ?? "", p: 72 },
    { t: colors[1] ?? "", p: 50 },
    { t: colors[2] ?? "", p: 40 },
    detailEntry,
    { t: fit, p: 46 },
    // Reads naturally at the end, and is only ever present when a care label
    // actually said so (see originKey above).
    { t: madeInUsa, p: 64 },
  ].filter((x) => x.t);

  // Anti-generic guard: if the title would be near-empty of search terms, pull in an
  // aesthetic tag and/or the material so it isn't just "Brand Type". Material only when
  // it's a selling point (100%/specialty) — "Polyester" is not a search keyword.
  if (descriptiveTokenCount([gender, vintage, pat, style, ...colors, detail, fit, model, material]) < 3) {
    const aes = titleTag(it.aesthetic?.[0]);
    // A "100% Cotton" label is still worth a mention; a fabric already in the title is not.
    const mat = !material && materialWorthMentioning(it.material) ? clean(it.material) : null;
    if (aes) seq.push({ t: aes, p: 58 });
    if (mat) seq.push({ t: mat, p: 47 });
  }
  if (sizeText) seq.push({ t: sizeText, p: 100 });

  const render = (arr: { t: string }[]) => dedupeWords(arr.map((x) => x.t).join(" ")).trim();
  const kept = seq.slice();
  while (render(kept).length > 80 && kept.some((x) => x.p < 100)) {
    let idx = -1, min = 101;
    kept.forEach((x, i) => { if (x.p < 100 && x.p < min) { min = x.p; idx = i; } });
    if (idx === -1) break;
    kept.splice(idx, 1);
  }
  let title = titleCaseWords(render(kept));
  // "Made in USA" is one fixed phrase, not three words to capitalise: the lowercase
  // "in" is how the marketplace, the care label and every buyer writes it.
  if (madeInUsa) title = title.replace("Made In USA", madeInUsa);
  // Safety net (B28): if even the pinned tokens (brand + item type + size) exceed eBay's
  // 80-char limit, hard-cap on a word boundary so we never emit an over-length title.
  if (title.length > 80) {
    const cut = title.slice(0, 80);
    const sp = cut.lastIndexOf(" ");
    title = (sp > 40 ? cut.slice(0, sp) : cut).trim();
  }
  const detailSurvived = !!detail
    && kept.includes(detailEntry)
    && title.toLowerCase().includes(detail.toLowerCase());
  return { title, keyDetail: detailSurvived ? detail : null };
}

export function buildTitle(it: ListingItem): string {
  return buildTitleWithMeta(it).title;
}

export function buildCategory(it: ListingItem): string {
  // Specific type mapping first ("Crossbody Bag" -> "Bags & Purses"), then the
  // detected top-level group.
  const mapped = lookupByType(CATEGORY, it.itemType);
  if (mapped) return mapped;
  const group = itemCategory(it.category, it.itemType);
  // Never fall back to the raw itemType. It reads like a category but no marketplace
  // taxonomy contains "long sleeve button down", so the upload assist typed a phrase
  // that matched no branch, gave up, and left the listing on "Please select a
  // subcategory". The group category is generic but REAL, so the picker can drill it
  // and the item's own keywords still choose the leaf.
  return CATEGORY_BY_GROUP[group] ?? "Clothing";
}

// Join into a natural phrase: ["a","b","c"] -> "a, b and c".
function listPhrase(items: string[]): string {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || "";
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

// Strip anything that reads as low-quality public copy: AI disclaimers, the word
// "unknown", "unbranded"/"no brand", a leading "Description:". Collapse whitespace and
// capitalize. Used for BOTH the vision-written description and the deterministic one,
// so the public copy never exposes a missing field.
// A sentence about the PHOTO SHOOT rather than the garment: the hanger, the backdrop,
// the SKU sticker and its QR code, the care label "displaying the text BC-000147". The
// vision model narrates what it sees, and three of the seven items left after the
// 2026-09-06 run carried one of these into their listing copy. A sentence that also
// states a measurement is kept — "Measures 26\" inseam laid flat" is about the garment.
const STUDIO_SENTENCE =
  /\b(?:hanger|hangers|qr\s*code|sticker|bc-?\s?\d{5,6}|\bsku\b|in the background|the backdrop|photographed|displayed on|displaying the text|laid flat on|on a (?:table|floor|surface|mannequin)|mannequin|tape measure|measuring tape|ruler)\b/i;

export function stripStudioSentences(desc: string): string {
  const parts = desc.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !STUDIO_SENTENCE.test(p) || /\bmeasures?\b/i.test(p));
  return kept.join(" ").trim();
}

export function sanitizeDescription(desc: string | null | undefined): string {
  let s = (desc || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = stripStudioSentences(s);
  s = s.replace(/^description\s*[:\-]\s*/i, "");
  s = s.replace(/\b(as an ai|i'?m sorry|i cannot|i can'?t|i am unable)\b[^.]*\.?/gi, " ");
  s = s.replace(/\bunknown brand\b/gi, " ").replace(/\bbrand\s*[:\-]?\s*unknown\b/gi, " ");
  s = s.replace(/\bunbranded\b/gi, " ").replace(/\bno brand\b/gi, " ").replace(/\bunknown\b/gi, " ");
  s = s.replace(/\s+([.,;])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,.;]+/, "").trim();
  if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// A description is weak/empty if it's too short or still contains junk after cleaning.
// Drives the fallback in the export (prefer a strong vision description, else build one).
export function isDescriptionWeak(desc: string | null | undefined): boolean {
  const s = (desc || "").trim();
  if (!s) return true;
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words < 16 || s.length < 100) return true;
  if (/\b(unknown|as an ai|i cannot|i'?m sorry)\b/i.test(s)) return true;
  return false;
}

// ---- Anti-hype: keep public copy factual, not salesy ----------------------------
// Resale buyers want an accurate item breakdown, not an ad. desalesify() rewrites/strips
// the promotional language a vision model (or an operator) tends to produce. It works at
// the CLAUSE level so garment facts bundled with hype in the same sentence survive (e.g.
// "...button-up front, the wardrobe staple you've been searching for" keeps the front).
// For HEAVILY salesy copy the export prefers the deterministic builder instead (it rebuilds
// a clean description from the structured fields), so desalesify only has to handle mild-to-
// moderate hype well. Idempotent — safe to run twice.

// Hype verbs -> neutral "has"; hype adjectives/intensifiers -> removed.
const MARKETING_SOFTENERS: [RegExp, string][] = [
  [/\b(?:delivers?|boasts?|exudes?|channels?|radiates?|oozes?|screams?|whispers?|offers up)\b/gi, "has"],
  [/\b(?:effortlessly|effortless|eye-?catching|stunning|gorgeous|breathtaking|jaw-?dropping|dazzling|head-?turning|show-?stopping|luxurious|impeccable|high-?energy|standout|statement-?making|unbeatable|timeless|iconic|coveted|premium|exquisite|legendary|ridiculously|absolutely|literally|instantly|insanely|seriously|downright|buttery-?soft|flawless|flawlessly|flattering|dreamy|cozy|cosy|comfy|snuggle-?worthy|drool-?worthy)\b/gi, ""],
  [/\b(?:pure|total|absolute|ultimate|certified)\s+(?=[a-z])/gi, ""],
];

// Hype noun-phrases removed IN PLACE (with a trailing "you've been searching for"-style
// relative clause when present), so the surrounding fact survives.
const HYPE_SPANS: RegExp[] = [
  /\b(?:the|a|an|your|this|these)?\s*(?:new\s+)?(?:wardrobe staple|statement piece|must[- ]?have|go-?to(?:\s+(?:basic|piece|sneaker|layer|choice))?|holy grail|grail|instant classic|crowd[- ]?pleaser|fan[- ]?favorite|one-of-a-kind|head-?turner|show-?stopper|wardrobe mvp)\b(?:\s+(?:you'?ve been|your\s+\w+\s+(?:have|has)\s+been|everyone'?s|every\s+closet)[\w' ]*?\b(?:for|craves|obsessed|missing|searching|begging|dreaming|waiting))?/gi,
  /\bflatters?\s+every\s+figure(?:\s+(?:beautifully|flawlessly|perfectly))?\b/gi,
  /\b(?:takes?[\w' ]*? )?to the next level\b/gi,
  /\bnext[- ]level\b/gi,
  /\blevels?\s+up(?:\s+(?:any|your|every)\s+\w+)?\b/gi,
  /\bmain[- ]character\b/gi,
  /\bcomfortable and stylish\b/gi,
  /\bversatile enough for any\s+\w+(?:\s+from\s+\w+\s+to\s+\w+)?\b/gi,
  /\b(?:is|are)\s+(?:pure\s+)?(?:fire|heat)\b/gi,
  /\b(?:this|these)\s+(?:fire|heat)\s+(?:piece|pieces)?\b/gi,
  /\bthis beauty\b/gi, /\bthese beauties\b/gi, /\bthis baby\b/gi, /\bthis gem\b/gi,
  /\byour new (?:\w+\s+)?(?:obsession|favorite|favourite)\b/gi,
  /\b(?:cool\s+)?vibes?\b/gi, /\bon point\b/gi, /\badd a pop of (?:color|colour)\b/gi,
  /\b\w+\s+(?:goddess|boss|rebel|main-?character)\s+(?:energy|royalty|cred)\b/gi,
  /\b(?:goddess|boss) energy\b/gi,
  /\b(?:everyone'?s|everybody'?s)?\s*obsessed(?:\s+with)?\b/gi, /\bobsession\b/gi,
  /\bthe heat your\b[^.,;!?]*/gi, /\belevates?\s+(?:any|every|your)\s+\w+/gi,
  /\b(?:holy\s+|investment\s+|loungewear\s+|cold-weather\s+)?grail\b/gi,
];

// Abstract "<has> ... <hype-noun>" claims -> removed (keeps real "has a ... lining/look/fit").
const ABSTRACT_HYPE =
  /\bhas\b(?:\s+\w+){0,3}?\s+(energy|cred|clout|nostalgia|charm|opulence|sophistication|elegance|glamou?r|royalty|aura|appeal|luxury|class|heritage|swagger|attitude|personality|quality|flair)\b/gi;

// Clause-level call-to-action / 2nd-person fluff. A comma-clause matching any of these is
// dropped (these clauses essentially never carry a garment fact).
const CTA_CLAUSE: RegExp[] = [
  /\bperfect for\b/i, /\bideal for\b/i, /\bgreat for (?:any|those|anyone|the)\b/i,
  /\bwhether you'?re\b/i, /\blook no further\b/i, /\bsure to\b/i, /\badds? a touch of\b/i,
  /\bcan'?t go wrong\b/i, /\bmake a statement\b/i, /\bturn heads?\b/i,
  /\bsteal the (?:show|spotlight)\b/i, /\belevate (?:your|every|any)\b/i,
  /\bdon'?t (?:miss|sleep|wait|walk|let)\b/i,
  /\b(?:grab|cop|snag|snatch|get|snap up)\s+(?:it|yours|this|these|a pair|your|them)\b/i,
  /\bcop (?:now|fast|today|quick|these|this)\b/i,
  /\bwon'?t (?:last|regret)\b/i, /\bnever (?:go back|regret)\b/i,
  /\blimited(?:\s+(?:stock|edition|time|quantities))?\b/i,
  /\btreat (?:yourself|your)\b/i, /\byou deserve it\b/i, /\bdm me\b/i, /\bspoil your\b/i,
  /\bbefore (?:it'?s gone|they'?re gone|they sell out|someone)\b/i,
  /\bstep up your\b/i, /\brock (?:this|these|it)\b/i, /\blive your best life\b/i,
  /\btrust me\b/i, /\bupgrade your\b/i,
  /\byou'?ll (?:love|never|want|wear|live|basically|reach|regret)\b/i,
  /\byou'?ve been (?:searching|looking|begging|dreaming|waiting)\b/i,
  /\bdreaming (?:of|about)\b/i, /\bevery closet craves\b/i,
  /\b(?:goes?|pairs?)\s+with\s+(?:literally\s+)?everything\b/i,
  /\breach for (?:daily|again)\b/i, /\byou'?ll reach for\b/i,
  /\bonce-in-a-lifetime\b/i, /\bbest-dressed\b/i, /\bsell out\b/i,
  /\bcalling all\b/i, /\bwhy blend in\b/i, /\bget ready to\b/i, /\bdon'?t walk\b/i,
  /\bis everything\b/i, /\bgame-?changer\b/i, /\byou won'?t regret\b/i,
  /\bgame to legendary\b/i, /\bhello to your\b/i,
  /\bto your (?:closet|wardrobe|collection|rotation)\b/i,
];

// Stop / hype-residue words: a clause made only of these is dropped as empty.
const _STOP = new Set(["it", "this", "that", "these", "those", "the", "a", "an", "is", "are",
  "was", "were", "with", "and", "of", "in", "to", "for", "its", "has", "have", "had", "made",
  "overall", "from", "on", "you", "your", "we", "they", "be", "just", "so", "real", "true"]);
const _HYPE_RESIDUE = new Set(["fire", "heat", "vibe", "vibes", "grail", "beauty", "baby", "gem",
  "flex", "clout", "mvp", "powerhouse", "everything", "obsessed", "obsession", "fab", "lit",
  "quality", "luxury", "heritage", "energy", "nostalgia", "charm", "glamour", "glamor",
  "opulence", "sophistication", "elegance", "royalty", "class", "swagger", "attitude", "flair", "aura"]);
const _norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

// Sentence-start fluff openers to strip (keep whatever garment fact follows).
const MARKETING_LEADINS: RegExp[] = [
  /^\s*elevate your (?:wardrobe|style|look|outfit|game)\s+with\s+/i,
  /^\s*upgrade your\b[^.?!]*?\bwith\s+/i,
  /^\s*introducing\s+(?:the\s+)?/i,
  /^\s*say hello to your new\b[^.?!]*?[!.,]\s*/i,
  /^\s*meet your new\b[^.?!]*?[!.,]\s*/i,
  /^\s*wrap yourself in (?:pure )?(?:luxury|style|comfort)\s+with\s+/i,
  /^\s*bundle up in (?:absolute )?style with\s+/i,
  // Leading calls-to-action that still NAME the item — strip the CTA, keep "<item>".
  /^\s*turn heads?\b[^.?!]*?\b(?:in|with)\s+/i,
  /^\s*steal the (?:show|spotlight)\b[^.?!]*?\b(?:in|with)\s+/i,
  /^\s*add a pop of [^.?!]*?\bwith\s+/i,
  /^\s*obsessed\b[^.?!]*?\bdescribe\s+(?:this\s+)?/i,
  /^\s*ladies,?\s+/i, /^\s*folks,?\s+/i, /^\s*guys,?\s+/i,
];

// Strip emoji / pictographs — pure hype noise in resale copy.
const _stripEmoji = (s: string): string =>
  s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}✂-➰Ⓜ️‍\u{1F1E6}-\u{1F1FF}]/gu, " ");

// Fix a dangling article left after an adjective was removed ("an print" -> "a print",
// "a orange" -> "an orange"). Skips u-/h- words to avoid false flips (unique, hour).
function _fixArticles(s: string): string {
  return s
    .replace(/\ban\s+(?=[bcdfghjklmnpqrstvwxyz])/gi, "a ")
    .replace(/\ba\s+(?=[aeio])/gi, "an ");
}

function _tidy(s: string): string {
  return s
    .replace(/\s+,/g, ",")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/\b(this|that|a|an|the|with|and|of|its|some|is|are|in|to)\s*,\s*/gi, "$1 ")
    .replace(/\s+(?:and|with|a|an|of|the|is|are|that)\s*([.!?])/gi, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/^[\s,;:.!?]+/, "")
    .trim();
}

// Detection set for warnings + the export's "is this heavily salesy?" threshold.
const MARKETING_DETECT: RegExp[] = [
  ...CTA_CLAUSE.map((re) => new RegExp(re.source, "i")),
  ...HYPE_SPANS.map((re) => new RegExp(re.source, "i")),
  /\b(?:delivers?|boasts?|exudes?|channels?|radiates?|oozes?|screams?)\b/i,
  /\b(?:stunning|gorgeous|breathtaking|jaw-?dropping|dazzling|luxurious|timeless|iconic|premium|effortless|eye-?catching|head-?turning|elevate)\b/i,
  /\b(?:fire|heat|vibe|vibes|grail)\b/i,
];

// Report which salesy phrases appear (deduped) — drives the export's copyWarnings and its
// "rebuild from structured fields" decision for heavily-salesy copy.
export function marketingHits(desc: string | null | undefined): string[] {
  const s = _stripEmoji(desc || "");
  const hits = new Set<string>();
  for (const re of MARKETING_DETECT) {
    const m = s.match(new RegExp(re.source, "gi"));
    if (m) for (const x of m) { const t = x.trim().toLowerCase().replace(/\s+/g, " "); if (t) hits.add(t); }
  }
  return [...hits];
}

// Rewrite a description into a clean, factual version: drop CTA/fluff clauses, neutralize
// hype verbs, remove hype phrases/adjectives, tidy punctuation. Decimal- and emoji-safe.
// Idempotent — safe to run twice.
export function desalesify(desc: string | null | undefined): string {
  let input = _stripEmoji(desc || "").trim();
  if (!input) return "";
  input = input.replace(/(\d)\.(\d)/g, "$1##DOT##$2"); // protect decimals from the sentence splitter
  const sentences = input.match(/[^.!?]+[.!?]*/g) ?? [input];
  const keptSentences: string[] = [];
  for (const rawS of sentences) {
    let sent = rawS.replace(/##DOT##/g, ".").trim();
    if (!sent) continue;
    // Drop a leading rhetorical/hype question ("Looking for the perfect...?").
    if (/[?]\s*$/.test(sent) &&
        /\b(looking|why|ready|want|need|who|pov|wardrobe emergency|cozy season|summer just)\b/i.test(sent)) continue;
    for (const re of MARKETING_LEADINS) sent = sent.replace(re, "");
    const body = sent.replace(/[.!?]+$/, "");
    const keptClauses: string[] = [];
    for (const rawClause of body.split(/\s*[;,]\s*/)) {
      let c = rawClause.trim();
      if (!c || /[?]$/.test(c)) continue;
      if (CTA_CLAUSE.some((re) => re.test(c))) continue;
      for (const [re, rep] of MARKETING_SOFTENERS) c = c.replace(re, rep);
      c = c.replace(ABSTRACT_HYPE, "");
      for (const re of HYPE_SPANS) c = c.replace(re, "");
      c = c.replace(/\s{2,}/g, " ").trim();
      const content = c.split(/\s+/).filter((w) =>
        /[a-z0-9]/i.test(w) && !_STOP.has(_norm(w)) && !_HYPE_RESIDUE.has(_norm(w)));
      if (content.length === 0) continue;
      keptClauses.push(c);
    }
    if (!keptClauses.length) continue;
    const s2 = _tidy(keptClauses.join(", "));
    if (s2) keptSentences.push(s2 + "."); // normalize !/? closers to a plain period
  }
  let out = _tidy(_fixArticles(keptSentences.join(" ")));
  out = out.replace(/\.(?=[A-Za-z])/g, ". "); // ensure a space after a period
  // Capitalize the first letter of every sentence (the start + anything after ". ").
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, pre, ch) => pre + ch.toUpperCase());
  return out;
}

// Closure as a natural construction phrase ("a snap-button front", "a full zip front",
// "a back zip closure", "a button fly").
function closurePhrase(c: string): string {
  const cl = c.trim().toLowerCase();
  if (!cl) return "";
  if (/pullover/.test(cl)) return "a pullover design";
  if (/\bfly\b/.test(cl)) return `a ${cl}`;                      // "a button fly" (fly = front)
  if (/\b(back|side)\b/.test(cl)) return `a ${cl} closure`;     // "a back zip closure"
  if (/zip|button|snap/.test(cl)) return `a ${cl} front`;
  return `a ${cl}`; // "a drawstring waist", "a elastic waist" (article fixed downstream)
}

// Neckline as a construction phrase. "Hooded" isn't a noun, so phrase it; collar/neck
// values ("Ribbed Collar", "V-Neck", "Mock Neck") already read fine lowercased.
function necklinePhrase(n: string): string {
  const nl = n.trim().toLowerCase();
  if (!nl) return "";
  if (/\bhood/.test(nl)) return "a hooded design";
  return nl;
}

// Textile patterns that read naturally as "... with a <pattern> pattern".
const TEXTILE_PATTERNS = new Set([
  "striped", "plaid", "floral", "camo", "checkered", "check", "tie-dye",
  "paisley", "houndstooth", "polka dot", "gingham", "argyle", "windowpane",
]);

// Factual, breakdown-style description — the FALLBACK when the vision model didn't write
// one (and the shape the vision prompt now mirrors). Reads like an accurate item breakdown
// for a resale buyer, NOT an ad: brand, type, color(s), pattern, fit, graphics/patches,
// closure, lining, collar, material, measurements, then size. Writes around a missing brand
// (never "Unknown") and makes no condition/authenticity/value claims.
export function buildDescription(it: ListingItem): string {
  const brand = brandPart(it.brand);
  const gender = genderWord(it.department)
    .replace("Mens", "men's").replace("Womens", "women's").replace("Kids", "kids'").replace("Unisex", "unisex");
  const colors = colorList(it).map((c) => c.toLowerCase());
  // Garment nouns come Title-Cased from the vision model ("Bomber","Jacket"); lowercase
  // them so the subject reads "AKOO men's bomber jacket", not "men's Bomber Jacket". The
  // brand (a proper noun) is left as-is and the sentence's first letter is capitalized.
  const style = styleKeyword(it.style, it.itemType).toLowerCase();
  const type = (clean(it.itemType) || "piece").toLowerCase();
  // Aesthetic tags and graphics are kept VERBATIM — they carry proper nouns, acronyms,
  // and quoted patch text ("Y2K", "'No Ruls 1980'") that must not be lowercased.
  const aesthetic = (it.aesthetic ?? []).map((a) => clean(a)).filter(Boolean) as string[];
  const graphics = (it.graphics ?? []).map((g) => clean(g))
    .filter((g): g is string => !!g && !isGenericDetail(g));
  const patRaw = clean(it.pattern);
  const pat = (patRaw || "").toLowerCase();
  const isBlock = pat === "multicolor" || pat === "colorblock";
  const sentences: string[] = [];

  // 1) Subject line: brand + gender + (single color as adjective) + style + type, then a
  //    factual color/pattern clause for multi-color/patterned items. e.g. "AKOO men's bomber
  //    jacket in a red, blue and yellow colorblock design." / "Women's blue dress with a
  //    floral pattern." A single color is ALWAYS used as an adjective so it's never dropped.
  const isPlural = /s$/i.test(type) && !/(ss|us|is)$/i.test(type); // boots/jeans/pants -> "have"
  const singleColorAdj = colors.length === 1 ? colors[0] : "";
  const sleeve = clean(it.sleeve).toLowerCase();
  const base = dedupeWords([brand, gender, singleColorAdj, sleeve, style, type].filter(Boolean).join(" ")).trim();
  let lead = base ? base.charAt(0).toUpperCase() + base.slice(1) : "Item";
  if (colors.length >= 2) {
    lead += isBlock ? ` in a ${listPhrase(colors)} colorblock design` : ` in ${listPhrase(colors)}`;
  }
  if (patRaw && !isBlock && pat !== "solid") {
    if (TEXTILE_PATTERNS.has(pat)) lead += ` with a ${pat} pattern`;
    else if (pat === "graphic" && !graphics.length) lead += ` with a graphic print`;
  }
  sentences.push(lead.replace(/\s+/g, " ").trim() + ".");

  // 2) Construction + graphics: "Features a snap-button front, ribbed collar, <graphics>."
  const features: string[] = [];
  if (it.closure) features.push(closurePhrase(it.closure));
  if (it.neckline) features.push(necklinePhrase(it.neckline));
  for (const g of graphics) features.push(g); // verbatim (proper nouns / quoted patch text)
  const cleanFeatures = features.filter(Boolean);
  if (cleanFeatures.length) sentences.push(`Features ${listPhrase(cleanFeatures)}.`);

  // 3) Material — ONLY when it's a selling point ("100% cotton", cashmere, leather…).
  //    Generic fibers/blends are noise a buyer assumes anyway.
  if (materialWorthMentioning(it.material)) sentences.push(`Made of ${it.material!.toLowerCase()}.`);

  // 4) Lining / interior.
  if (it.lining) {
    const l = it.lining.toLowerCase();
    sentences.push(/lin(ing|ed)/.test(l) ? `Interior is ${l}.` : `Interior has a ${l} lining.`);
  }

  // 5) Aesthetic / style keywords — a factual statement, no hype.
  if (aesthetic.length) {
    sentences.push(type !== "piece"
      ? `The ${type} ${isPlural ? "have" : "has"} a ${listPhrase(aesthetic)} look.`
      : `Has a ${listPhrase(aesthetic)} look.`);
  }

  // 6) Fit (only if it adds info beyond "regular").
  const fit = fitWord(it.fit);
  if (fit) sentences.push(`${fit.charAt(0).toUpperCase() + fit.slice(1)} fit.`);

  // 7) Flat measurements (inches) — strong buyer info; reduces returns.
  const mc = measurementClause(it);
  if (mc) sentences.push(mc);

  // 8) Operator notes / visible flaws (verbatim, but cleaned of "unknown" and capitalized).
  const notes = clean(it.notes);
  if (notes) {
    const n = notes.replace(/[.\s]*$/, "");
    sentences.push(n.charAt(0).toUpperCase() + n.slice(1) + ".");
  }

  // 9) Size last (mirrors the target example "... Size L."). Avoid "Size One Size" when the
  //    value already says "size" (e.g. "One Size").
  if (it.size) sentences.push(/\bsize\b/i.test(it.size) ? `${it.size}.` : `Size ${it.size}.`);

  return desalesify(sanitizeDescription(sentences.join(" ")));
}

export function buildListing(it: ListingItem): ListingCopy {
  const title = buildTitle(it);
  return {
    title,
    description: buildDescription(it),
    category: buildCategory(it),
    publicNotes: title, // short public summary
  };
}
