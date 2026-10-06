import type { CanonicalListing, ValidationIssue } from "../../types.ts";
import { PublishError } from "../../types.ts";
import type { BrowserReport } from "../../browserProtocol.ts";

/** User-approved Poshmark rounding. The canonical price is never changed. */
export function poshmarkPrice(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const rounded = Math.round(price);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null;
}

export function poshmarkValidate(listing: CanonicalListing): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (listing.title.length > 80) issues.push({ field: "title", message: "Poshmark titles are limited to 80 characters" });
  if (poshmarkPrice(listing.price) === null) issues.push({ field: "price", message: "Poshmark needs a valid price that rounds to at least $1" });
  if (!Number.isInteger(listing.quantity) || listing.quantity < 1 || listing.quantity > 999) issues.push({ field: "quantity", message: "Poshmark quantity must be a whole number from 1 to 999" });
  if (!listing.photos.length || listing.photos.length > 16) issues.push({ field: "photos", message: "Choose 1 to 16 listing photos for Poshmark" });
  if (!["New with tags", "New without tags", "Like new", "Good", "Fair", "Pre-owned"].includes(listing.condition)) issues.push({ field: "condition", message: "Poshmark condition needs review" });
  if (!listing.size?.trim()) issues.push({ field: "size", message: "Poshmark needs a reviewed size" });
  const department = (listing.department ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const boysJeans = ["boy", "boys"].includes(department) && (listing.itemType ?? "").toLowerCase() === "jeans";
  if (boysJeans && listing.quantity !== 1) issues.push({ field: "quantity", message: "Poshmark boys jeans currently use one item per listing" });
  if (!boysJeans && !["men", "mens", "male", "menswear", "women", "womens", "female", "womenswear", "unisex", "unisexadult", "unisexadults"].includes(department)) issues.push({ field: "department", message: "Poshmark needs a reviewed adult department or supported boys jeans; unisex items use Women" });
  return issues;
}

export function poshmarkPublicationError(done: BrowserReport | null): PublishError {
  return new PublishError(done?.reason ?? done?.message ?? "Poshmark ended without a verified publishing result",
    "requires_review", done?.submissionStarted === false && done?.outcome !== "posted");
}
