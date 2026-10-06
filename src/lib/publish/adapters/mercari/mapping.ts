import type { AppSettingsData } from "../../../types.ts";
import type { CanonicalListing, ValidationIssue } from "../../types.ts";
import { PublishError } from "../../types.ts";
import type { BrowserReport } from "../../browserProtocol.ts";
import { listingIdentity } from "../../attempts.ts";

export function mercariValidate(listing: CanonicalListing, settings: AppSettingsData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!listing.title?.trim() || listing.title.length > 80) issues.push({ field: "title", message: "Mercari needs a reviewed title of at most 80 characters" });
  if (!listing.description?.trim() || listing.description.length > 1000) issues.push({ field: "description", message: "Mercari needs a description of at most 1,000 characters" });
  if (!Number.isFinite(listing.price) || listing.price < 1 || listing.price > 2000 || Math.round(listing.price * 100) / 100 !== listing.price) issues.push({ field: "price", message: "Mercari's standard route accepts $1–$2,000 in whole cents" });
  if (!listing.brand?.trim() || listing.brand === "Unknown") issues.push({ field: "brand", message: "Review the Mercari brand first" });
  if (!listing.size?.trim()) issues.push({ field: "size", message: "Review the Mercari size first" });
  if (!["men","mens","male","menswear","women","womens","female","womenswear","unisex","unisexadult","unisexadults"].includes((listing.department ?? "").toLowerCase().replace(/[^a-z0-9]/g,""))) issues.push({ field: "department", message: "Mercari needs a reviewed adult department" });
  if (!["New with tags", "New without tags", "Like new", "Good", "Fair", "Pre-owned"].includes(listing.condition)) issues.push({ field: "condition", message: "Review the Mercari condition first" });
  if (listing.quantity !== 1) issues.push({ field: "quantity", message: "Mercari posts one piece per listing" });
  if (!listing.photos.length || listing.photos.length > 12) issues.push({ field: "photos", message: "Mercari accepts 1–12 listing photos" });
  if (!/^\d{5}$/.test(settings.mercariShipFrom?.zip ?? "")) issues.push({ field: "shipping", message: "Set your Mercari ship-from ZIP in Settings > Shipping" });
  if (!Number.isFinite(listing.weightOz) || listing.weightOz <= 0 ||
      [listing.packageDims?.length, listing.packageDims?.width, listing.packageDims?.height].some(value => !Number.isFinite(value) || value <= 0)) issues.push({ field: "shipping", message: "Mercari needs positive package weight and dimensions" });
  return issues;
}
export function mercariPublicationError(done: BrowserReport | null) {
  const candidate = done?.url && listingIdentity("mercari", done.url);
  const reason = done?.reason ?? done?.message ?? "Mercari ended without a verified listing";
  return new PublishError(candidate ? `${reason} Check ${candidate.url}` : reason, "requires_review", done?.outcome !== "posted" && done?.submissionStarted === false);
}
