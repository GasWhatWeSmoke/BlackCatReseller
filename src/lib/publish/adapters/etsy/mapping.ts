import type { CanonicalListing, ValidationIssue } from "../../types.ts";
import { PublishError } from "../../types.ts";
import type { BrowserReport } from "../../browserProtocol.ts";
import { listingIdentity } from "../../attempts.ts";

const kinds = new Set(["tshirt", "longsleevetshirt", "tee", "tank", "tanktop", "shorts", "jeans", "pants", "trousers",
  "sweater", "cardigan", "hoodie", "sweatshirt", "dress", "skirt", "shirt", "longsleeveshirt",
  "longsleevebuttondown", "buttondown", "buttonup", "blouse", "top"]);
const norm = (value: string | null) => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function etsyValidate(listing: CanonicalListing): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (listing.trueVintage !== true || !listing.whenMade?.trim()) issues.push({ field: "trueVintage", message: "Etsy resale needs reviewed True Vintage and a manufacturing era" });
  if (!Number.isFinite(listing.price) || listing.price <= 0 || Math.round(listing.price * 100) / 100 !== listing.price) issues.push({ field: "price", message: "Etsy needs a positive price in whole cents" });
  if (listing.quantity !== 1) issues.push({ field: "quantity", message: "This Etsy workflow posts one item at a time" });
  if (!listing.photos.length || listing.photos.length > 20) issues.push({ field: "photos", message: "Choose 1 to 20 listing photos for Etsy" });
  if (!listing.size?.trim()) issues.push({ field: "size", message: "Etsy needs a reviewed size" });
  if (!["men", "mens", "women", "womens", "unisex", "unisexadult", "unisexadults"].includes(norm(listing.department))) issues.push({ field: "department", message: "Etsy needs a reviewed adult department" });
  if (!kinds.has(norm(listing.itemType))) issues.push({ field: "itemType", message: "This item type still needs an Etsy category mapping" });
  if (!Number.isFinite(listing.weightOz) || listing.weightOz <= 0 ||
      [listing.packageDims?.length, listing.packageDims?.width, listing.packageDims?.height].some(value => !Number.isFinite(value) || value <= 0)) issues.push({ field: "shipping", message: "Etsy needs positive package weight and dimensions" });
  return issues;
}

export function etsyPublicationError(done: BrowserReport | null): PublishError {
  const candidate = done?.url && listingIdentity("etsy", done.url);
  const reason = done?.reason ?? done?.message ?? "Etsy ended without a verified publication result";
  return new PublishError(candidate ? `${reason} Check ${candidate.url}` : reason,
    "requires_review", done?.submissionStarted === false && done?.outcome !== "posted");
}
