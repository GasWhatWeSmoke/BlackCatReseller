import type { CanonicalListing, ValidationIssue } from "../../types.ts";
import { PublishError } from "../../types.ts";
import type { BrowserReport } from "../../browserProtocol.ts";
import { ebayTitle, EBAY_MAX_PHOTOS } from "../ebay/mapping.ts";
import { listingIdentity } from "../../attempts.ts";
export { ebayTitle };

export function ebayBrowserValidate(listing: CanonicalListing): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind = (listing.itemType ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!ebayTitle(listing.title)) issues.push({ field: "title", message: "eBay needs a title" });
  if (!listing.brand?.trim() || listing.brand === "Unknown") issues.push({ field: "brand", message: "eBay needs a reviewed brand" });
  if (!listing.size?.trim()) issues.push({ field: "size", message: "eBay needs a reviewed size" });
  if (!listing.color?.trim()) issues.push({ field: "color", message: "eBay needs a reviewed color" });
  if (kind.endsWith("jeans")) {
    const inseam = (listing.inseam ?? "").trim().match(/^(\d{1,2}(?:\.\d{1,2})?)\s*(?:in(?:ches)?\.?|")?$/i);
    if (!inseam || Number(inseam[1]) <= 0) issues.push({ field: "inseam", message: "eBay jeans need a reviewed inseam measurement; the tag size is not an inseam" });
  }
  if ((kind.endsWith("jacket") || kind.endsWith("coat") || (kind.endsWith("vest") && !kind.endsWith("sweatervest"))) &&
      (!listing.material?.trim() || listing.material.trim().toLowerCase() === "unknown")) {
    issues.push({ field: "material", message: "eBay outerwear needs a reviewed outer shell material" });
  }
  if (listing.quantity !== 1) issues.push({ field: "quantity", message: "This eBay route posts one item per listing" });
  if (!Number.isFinite(listing.price) || listing.price <= 0 || Math.round(listing.price * 100) / 100 !== listing.price) issues.push({ field: "price", message: "eBay needs a positive price in whole cents" });
  if (!listing.photos.length || listing.photos.length > EBAY_MAX_PHOTOS) issues.push({ field: "photos", message: `eBay needs 1 to ${EBAY_MAX_PHOTOS} photos` });
  if (!["New with tags", "New without tags", "Like new", "Good", "Fair", "Pre-owned"].includes(listing.condition)) issues.push({ field: "condition", message: "eBay condition needs review" });
  const department = (listing.department ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const boysJeans = ["boy", "boys"].includes(department) && kind === "jeans";
  if (boysJeans && (!/^\d+$/.test(listing.size ?? "") || Number(listing.size) < 4)) issues.push({ field: "size", message: "This eBay boys jeans category needs a reviewed numeric size 4 or above" });
  if (!boysJeans && !["men","mens","male","menswear","women","womens","female","womenswear","unisex","unisexadult","unisexadults"].includes(department)) issues.push({ field: "department", message: "eBay needs a reviewed adult department or supported boys jeans" });
  return issues;
}

export function ebayBrowserError(done: BrowserReport | null): PublishError {
  const candidate = done?.url && listingIdentity("ebay", done.url);
  const reason = done?.reason ?? done?.message ?? "eBay ended without a verified listing";
  const notSubmitted = done?.submissionStarted === false && done?.outcome !== "posted";
  const retryCategory = notSubmitted && !done?.url && done?.outcome === "failed" &&
    reason === "ValueError: eBay choice is ambiguous: Clothing, Shoes & Accessories";
  return new PublishError(candidate ? `${reason} Check ${candidate.url}` : reason,
    retryCategory ? "retryable" : "requires_review", notSubmitted);
}
