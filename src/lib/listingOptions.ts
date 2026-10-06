// Single source of truth for the dropdown option values that map to Nifty AI's own
// dropdowns. CAPTURED LIVE from app.nifty.ai/inventory/add (logs/nifty-options-*.json)
// so the Black Cat Agent UI stores the EXACT strings Nifty accepts — no fuzzy/custom
// values that would mismatch when the assist fills the form.
//
// STRICT lists -> rendered as <select> (the value must be one of these).
// SUGGEST lists -> rendered as a free-text input + datalist (Nifty allows custom-add).

// Etsy "When was it made?" — EXACT Nifty strings (the parenthetical matters).
export const WHEN_MADE_OPTIONS = [
  "Made to order (Not Yet Made)",
  "2020 - 2026 (Recently)",
  "2010 - 2019 (Recently)",
  "2007 - 2009 (Recently)",
  "Before 2007 (Vintage)",
  "2000 - 2006 (Vintage)",
  "1990s (Vintage)",
  "1980s (Vintage)",
  "1970s (Vintage)",
  "1960s (Vintage)",
  "1950s (Vintage)",
  "1940s (Vintage)",
  "1930s (Vintage)",
  "1920s (Vintage)",
  "1910s (Vintage)",
  "1900 - 1909 (Vintage)",
  "1800s (Vintage)",
  "1700s (Vintage)",
  "Before 1700 (Vintage)",
] as const;
export const WHEN_MADE_DEFAULT = "2020 - 2026 (Recently)";
// Safe "definitely 20+ years old" era used when the operator checks True Vintage but
// hasn't picked a specific decade. "Before 2007 (Vintage)" is Etsy-valid and reads as
// vintage regardless of the exact year. The operator can still refine the decade.
export const VINTAGE_WHEN_MADE_DEFAULT = "Before 2007 (Vintage)";

// Item condition. A practical resale ladder that maps (via synonyms in the assist) to
// each marketplace's own Condition wording (eBay "Pre-owned", Mercari "Good", etc.).
export const CONDITION_OPTIONS = [
  "New with tags",
  "New without tags",
  "Like new",
  "Good",
  "Fair",
  "Pre-owned",
] as const;
export const CONDITION_DEFAULT = "Good";

// Etsy eligibility — Etsy only permits these categories (else the item is NOT listed
// to Etsy). "Not eligible" = regular modern resale clothing (the default). VINTAGE is
// NOT in this list: it's driven by the dedicated `trueVintage` checkbox (a one-click
// flag that also forces a vintage era), so this dropdown only covers the rarer
// handmade/craft/party cases.
export const ETSY_ELIGIBLE_OPTIONS = [
  { value: "none", label: "Not eligible (skip Etsy)" },
  { value: "handmade", label: "Handmade" },
  { value: "craft", label: "Craft supply" },
  { value: "party", label: "Party supply" },
] as const;
export const ETSY_ELIGIBLE_DEFAULT = "none";

// Legacy values that pre-date the exact-string capture -> current Nifty equivalent.
// Used to migrate/normalize older saved items so they exact-match.
export const WHEN_MADE_ALIASES: Record<string, string> = {
  "2020 - 2026": "2020 - 2026 (Recently)",
  "2010 - 2019": "2010 - 2019 (Recently)",
  "2007 - 2009": "2007 - 2009 (Recently)",
  "Before 2007": "Before 2007 (Vintage)",
  "2000 - 2006": "2000 - 2006 (Vintage)",
  "1990s": "1990s (Vintage)",
  "1980s": "1980s (Vintage)",
  "1970s": "1970s (Vintage)",
  "1960s": "1960s (Vintage)",
  "1950s": "1950s (Vintage)",
  "Made To Order": "Made to order (Not Yet Made)",
};

// Normalize a stored era to the exact current Nifty option (idempotent).
export function normalizeWhenMade(v: string | null | undefined): string {
  const s = (v || "").trim();
  if (!s) return WHEN_MADE_DEFAULT;
  if ((WHEN_MADE_OPTIONS as readonly string[]).includes(s)) return s;
  return WHEN_MADE_ALIASES[s] || WHEN_MADE_DEFAULT;
}

// Top-level item CATEGORY (ours, not a Nifty dropdown): routes size requirements,
// weight/dims estimates, and the assist's category drilling for non-clothing items.
// Mirrors itemCategory() in src/lib/listing.ts and the vision prompt's category key.
export const CATEGORY_OPTIONS = [
  "Clothing", "Bag", "Jewelry", "Hat", "Shoes", "Accessory",
] as const;

// Nifty Color palette — EXACT (strict <select>).
export const COLOR_OPTIONS = [
  "Red", "Pink", "Orange", "Yellow", "Green", "Blue", "Purple",
  "Gold", "Silver", "Black", "Gray", "White", "Cream", "Brown", "Tan",
] as const;

// Pattern — the AI-detected pattern vocab (also a Nifty specific; custom-add allowed
// but these cover the cases we detect).
export const PATTERN_OPTIONS = [
  "Solid", "Graphic", "Multicolor", "Tie-Dye", "Striped", "Camo", "Plaid", "Floral",
] as const;

// Fit / cut — a strong title keyword and a Nifty specific. AI-detected, editable.
// "Regular" is intentionally a neutral value (it adds nothing to a title).
export const FIT_OPTIONS = [
  "Slim", "Regular", "Relaxed", "Oversized", "Cropped", "Boxy", "Tapered", "Loose",
] as const;

// Department, Size, Pattern, Material, Style are CATEGORY-DEPENDENT and/or long in
// Nifty (the per-category dropdown varies and supports custom-add), so the UI renders
// them as free-text + datalist (suggestions) rather than a strict <select>. The values
// below are Nifty's own option strings, used as suggestions; the assist matches the
// saved value to the live per-category list (and custom-adds when allowed).

// Department — common Nifty departments (a men's jacket shows Men/Teens/Unisex Adults).
export const DEPARTMENT_OPTIONS = [
  "Men", "Women", "Unisex Adults", "Teens", "Kids", "Boys", "Girls", "Baby",
] as const;

// Size — real Nifty size strings (letters + US numerics + One Size). Nifty's full
// per-category list also has IT/EU/FR/Tall variants; an out-of-list saved value is kept.
export const SIZE_OPTIONS = [
  "3XS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "2XL", "3XL", "4XL", "5XL", "6XL",
  "One Size", "0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "22",
  "24", "26", "28", "30", "32", "34", "36", "38", "40", "42", "44", "46", "48", "50", "Other",
] as const;

// Material — VERBATIM from Nifty's captured list (103). Free-text + datalist suggestions.
export const MATERIAL_OPTIONS = [
  "100% Acrylic", "100% Cashmere", "100% Cotton", "100% Linen", "100% Lyocell",
  "100% Merino Wool", "100% Modal", "100% Nylon", "100% Polyamide", "100% Polyester",
  "100% Silk", "100% Viscose", "100% Wool", "Acetate", "Acrylic", "Acrylic Blend",
  "Alfa", "Alginate", "Alpaca", "Angora", "Animal Hair", "Aramid", "Bamboo", "Beaver",
  "Brocade", "Camel", "Canvas", "Cashgora", "Cashmere", "Cashmere Blend", "Cotton",
  "Cotton Blend", "Cupro", "Elastodiene", "Elastolefin", "Elastomultiester", "Faux Fur",
  "Faux Leather", "Faux Silk", "Faux Suede", "Flax", "Fluorofiber", "Fur", "Glass",
  "Guanaco", "Hemp", "Henequen", "Kapok", "Lambskin Leather", "Leather", "Linen",
  "Linen Blend", "Llama", "Lyocell", "Maguey", "Manila Hemp", "Metallic Fiber",
  "Microfiber", "Modacrylic", "Modal", "Modal Blend", "Mohair", "Neoprene", "Nylon",
  "Organdy", "Organza", "Otter", "Patent Leather", "PLA Fiber", "Polyacrylate Fiber",
  "Polyamide", "Polyamide Blend", "Polyamide Fiber", "Polycotton", "Polyester",
  "Polyester Blend", "Polyethylene", "Polylactide", "Polypropylene", "Polypropylene Fiber",
  "Polyurethane", "PVC", "Ramie", "Silk", "Silk Blend", "Spandex", "Suede", "Sunn",
  "Triacetate", "Triacetate Blend", "Trivinyl", "Tweed", "Twill", "Velour", "Velvet",
  "Vicuna", "Vinyl", "Viscose", "Viscose Blend", "Voile", "Wool", "Wool Blend", "Yak",
] as const;

// Style — VERBATIM from Nifty's captured list (130). Free-text + datalist suggestions.
// (Garment-type values like "Bomber"/"Cargo" aren't Nifty presets — the AI may still set
// them and the assist custom-adds them via the in-menu "Add".)
export const STYLE_OPTIONS = [
  "70s", "80s", "90s", "Activewear", "Animal Print", "Athleisure", "Avant Garde", "Baggy",
  "Balletcore", "Beach", "Beaded", "Bikercore", "Blokecore", "Bodycon", "Bohemian", "Bow",
  "Bridal", "Bridesmaid", "Business Casual", "Cable Knit", "Cashmere", "Casual", "Chunky",
  "Collegiate", "Colorblock", "Colorful", "Contemporary", "Coord Sets", "Coquette Girl",
  "Corduroy", "Cottagecore", "Cozy", "Crochet", "Cropped", "Cruelty-Free", "Cut Out",
  "Denim", "Distressed", "DIY", "Drop Waist", "Eclectic Grandpa", "Embroidered", "Fall",
  "Faux Fur", "Feminine", "Festival", "Festive", "Flannel", "Flare", "Floral", "Formal",
  "Fringe", "Gingham", "Girlhoodcore", "Gorpcore", "Goth", "Grunge", "Hand Knit",
  "Handmade", "Herringbone", "Houndstooth", "Indie Sleeze", "Knit", "Lace", "Leather",
  "Leopard Print", "Lightweight", "Linen", "Luxury", "Maximalism", "Mesh", "Metallic",
  "Minimalist", "Monochrome", "Monogram", "Moto", "Neon", "Neutral", "Nylon", "Office",
  "Oversized", "Paisley", "Party", "Pastel", "Patchwork", "Peplum", "Plaid", "Platform",
  "Pleated", "Polka Dot", "Preppy", "Punk", "Quiet Luxury", "Quilted", "Relaxed Fit",
  "Resortwear", "Retro", "Rosette", "Ruffle", "Satin", "Sequins", "Sheer", "Sherpa",
  "Silk", "Sporty", "Strapless", "Streetwear", "Stripes", "Suede", "Tailored",
  "Tennis Prep", "Travel", "Tropical", "Tweed", "Two-Tone", "Unisex", "Upcycled",
  "Utility", "Vacation", "Vegan", "Velour", "Vintage", "Waterproof", "Wedding", "Western",
  "Whimsigoth", "Winter", "Wool", "Woven", "Y2K",
] as const;
