// eBay payload mapping (§45.13) — PURE functions, no HTTP, fully unit-tested.
//
// Everything eBay-shaped is built here from the canonical listing; the client
// only moves these payloads over the wire. Field references: Sell Inventory API
// (inventory_item + offer) and the Taxonomy API for category suggestions.

import type { CanonicalListing, ValidationIssue } from "../../types.ts";
import type { EbayPublishConfig } from "../../../types.ts";

/** eBay hard limit. Truncated at a word boundary, never mid-word. */
export const EBAY_TITLE_MAX = 80;
/** Inventory API allows at most 24 pictures per listing. */
export const EBAY_MAX_PHOTOS = 24;

/**
 * Black Cat condition vocabulary -> Inventory API ConditionEnum.
 * In apparel categories eBay displays NEW as "New with tags" and NEW_OTHER as
 * "New without tags", which is exactly our split. The used ladder maps by how
 * eBay's own condition names describe wear.
 */
export const EBAY_CONDITION: Record<string, string> = {
  "New with tags": "NEW",
  "New without tags": "NEW_OTHER",
  "Like new": "USED_EXCELLENT",
  "Good": "USED_GOOD",
  "Fair": "USED_ACCEPTABLE",
  "Pre-owned": "USED_GOOD",
};

export function ebayTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  if (t.length <= EBAY_TITLE_MAX) return t;
  const cut = t.slice(0, EBAY_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Newlines -> <br> so the plain-text canonical description renders on eBay. */
export function ebayDescriptionHtml(description: string): string {
  const esc = description
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>${esc.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

const ASPECT_VALUE_MAX = 65;

/**
 * Item specifics. Only real values are sent — eBay rejects empty aspect arrays,
 * and a guessed aspect is worse than an absent one. Brand is the one aspect
 * clothing categories require everywhere.
 */
export function buildAspects(l: CanonicalListing): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const put = (name: string, value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (v) aspects[name] = [v.slice(0, ASPECT_VALUE_MAX)];
  };
  put("Brand", l.brand);
  put("Size", l.size);
  put("Color", l.color);
  put("Department", l.department);
  put("Material", l.material);
  put("Style", l.style);
  put("Fit", l.fit);
  put("Pattern", l.pattern);
  put("Type", l.itemType);
  put("Model", l.model);
  put("Country/Region of Manufacture", l.countryOfOrigin);
  if (l.inseam) put("Inseam", `${l.inseam} in`);
  return aspects;
}

/** PUT /sell/inventory/v1/inventory_item/{sku} — SKU-keyed, idempotent (§45.19). */
export function buildInventoryItemPayload(l: CanonicalListing, imageUrls: string[]): unknown {
  return {
    product: {
      title: ebayTitle(l.title),
      description: ebayDescriptionHtml(l.description),
      aspects: buildAspects(l),
      imageUrls,
    },
    condition: EBAY_CONDITION[l.condition] ?? "USED_GOOD",
    availability: { shipToLocationAvailability: { quantity: l.quantity } },
    packageWeightAndSize: {
      weight: { value: l.weightOz, unit: "OUNCE" },
      dimensions: {
        length: l.packageDims.length,
        width: l.packageDims.width,
        height: l.packageDims.height,
        unit: "INCH",
      },
    },
  };
}

/** POST /sell/inventory/v1/offer (or PUT to update an existing one). */
export function buildOfferPayload(
  l: CanonicalListing,
  cfg: EbayPublishConfig,
  categoryId: string,
): unknown {
  return {
    sku: l.sku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: l.quantity,
    categoryId,
    listingDescription: ebayDescriptionHtml(l.description),
    pricingSummary: { price: { value: l.price.toFixed(2), currency: "USD" } },
    listingPolicies: {
      fulfillmentPolicyId: cfg.fulfillmentPolicyId,
      paymentPolicyId: cfg.paymentPolicyId,
      returnPolicyId: cfg.returnPolicyId,
    },
    merchantLocationKey: cfg.merchantLocationKey,
  };
}

/** The category-suggestion query: what a buyer would search, not our full title. */
export function categoryQuery(l: CanonicalListing): string {
  return [l.department, l.brand !== "Unknown" ? l.brand : null, l.itemType]
    .filter(Boolean)
    .join(" ")
    .trim() || ebayTitle(l.title);
}

/** eBay-side validation (§45.4) — checks the ADAPTER owns, not the shared gate. */
export function ebayValidate(l: CanonicalListing, cfg: EbayPublishConfig | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!cfg?.fulfillmentPolicyId) issues.push({ field: "ebay", message: "eBay shipping (fulfillment) policy ID not configured" });
  if (!cfg?.paymentPolicyId) issues.push({ field: "ebay", message: "eBay payment policy ID not configured" });
  if (!cfg?.returnPolicyId) issues.push({ field: "ebay", message: "eBay return policy ID not configured" });
  if (!cfg?.merchantLocationKey) issues.push({ field: "ebay", message: "eBay inventory location (merchantLocationKey) not configured" });
  if (!(l.condition in EBAY_CONDITION)) {
    issues.push({ field: "condition", message: `condition "${l.condition}" has no eBay mapping` });
  }
  if (l.photos.length > EBAY_MAX_PHOTOS) {
    issues.push({ field: "photos", message: `${l.photos.length} photos exceeds eBay's limit of ${EBAY_MAX_PHOTOS}` });
  }
  if (l.price < 0.99) issues.push({ field: "price", message: "eBay requires a price of at least $0.99" });
  return issues;
}
