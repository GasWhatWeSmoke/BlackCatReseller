import { DRAFT_FIELDS, draftKey, type DraftItem } from "./itemDrafts.ts";
import { sizelessOk } from "./listing.ts";
import { buildExportCopy, type CopySource } from "./listingCopy.ts";
import { readAutoRun } from "./publish/autoRun.ts";

export interface ReviewItem extends DraftItem {
  sku: string; updatedAt: string; brand: string; listedPrice: number | null;
  photos: { id: number; storedPath: string; sha256?: string | null; sortOrder: number; rotation: number;
    isMarker: boolean; isCover: boolean; includeInListing: boolean }[];
  marketplaceListings?: { marketplace: string; status: string; externalListingId?: string | null; price?: number | null }[];
}
export interface ReviewRules {
  required: string[]; minPhotos: number; autoRun: boolean; marketplaces: string[]; preserveMarketplacePrices: boolean;
}
export interface ReviewCheckpoint {
  version: 1; key: string; revision: string; id: number; createdAt: string; sku: string;
  itemVersion: string; signature: string; reviewedAt: string;
  title: string; price: number; photos: number;
  phase: "reviewed" | "approving" | "approved" | "blocked" | "unknown";
  attempt?: string; note?: string;
}

export function reviewHotkey(event: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean; defaultPrevented?: boolean; repeat?: boolean }, blockedTarget: boolean): "approve" | "batch" | null {
  if (blockedTarget || event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented || event.repeat) return null;
  return event.ctrlKey ? "batch" : "approve";
}

export function reviewKey(item: Pick<DraftItem, "id" | "createdAt">) {
  return draftKey("review", item).replace(/^review:/, "reviewed:");
}

export function reviewRules(value: unknown): ReviewRules {
  const settings = value as Record<string, unknown> | null;
  if (!settings || !Array.isArray(settings.requiredFieldsForReady)
    || settings.requiredFieldsForReady.some(field => typeof field !== "string")
    || !Number.isSafeInteger(settings.minListingPhotos) || Number(settings.minListingPhotos) < 0)
    throw new Error("Approval settings could not be verified. Reload before reviewing this batch.");
  const publish = settings.publish as { autoRun?: Parameters<typeof readAutoRun>[0]; relistPricing?: string } | undefined;
  if (publish != null && (typeof publish !== "object" || Array.isArray(publish))) throw new Error("Publishing settings could not be verified.");
  const auto = readAutoRun(publish?.autoRun);
  return { required: [...new Set([...settings.requiredFieldsForReady, "brand", "department"])].sort(),
    minPhotos: Number(settings.minListingPhotos), autoRun: auto.enabled, marketplaces: [...auto.marketplaces].sort(),
    preserveMarketplacePrices: publish?.relistPricing === "preserve_marketplace" };
}

export function reviewProblems(item: ReviewItem, rules: ReviewRules): string[] {
  if (!["Photographed", "Needs Info"].includes(item.status)) return [`Item is ${item.status}; check Inventory or Crosslisting.`];
  if (typeof item.republicationBlockReason === "string" && item.republicationBlockReason) return [item.republicationBlockReason];
  if (item.marketplaceListings?.some(row => !["ended", "not_published"].includes(row.status))
    || ["Uploading", "Draft", "Published"].includes(String(item.niftyStatus ?? "")))
    return ["Existing marketplace activity needs attention in Crosslisting before this item can be approved again."];
  if (!Array.isArray(item.photos)) return ["The item's photos could not be verified."];
  if (!/^[A-Za-z0-9_-]+$/.test(item.sku)) return ["Correct this item's SKU before preparing its listing photos."];
  const sizeExempt = sizelessOk(item.itemType as string | null, item.category as string | null);
  const missing = rules.required.filter(field => (!item[field] || !String(item[field]).trim() || field === "brand" && item.brand === "Unknown")
    && !(field === "size" && sizeExempt));
  if (!Number.isFinite(item.listedPrice) || Number(item.listedPrice) <= 0) missing.push("price");
  if (item.photos.filter(photo => photo.includeInListing && !photo.isMarker).length < rules.minPhotos)
    missing.push(`${rules.minPhotos} listing photos`);
  return missing.length ? [`Add or confirm: ${missing.join(", ")}.`] : [];
}

/** Match what the operator saw, retaining explicit clears and ordered photo selection. */
export function reviewContent(item: ReviewItem): string {
  const fields: Record<string, unknown> = {};
  for (const field of [...DRAFT_FIELDS, "sku", "publicNotes", "subBrand", "countryOfOrigin", "aiRaw"]) {
    if (field === "itemCost") continue;
    let value = item[field] ?? null;
    if (["size", "itemType", "category", "color", "condition"].includes(field) && typeof value === "string" && !value.trim()) value = null;
    if (field === "weightOz" && value !== null && value !== "") value = Math.round(Number(value));
    if (field === "weightOz" && value === "") value = null;
    fields[field] = value;
  }
  const photos = [...item.photos].sort((a, b) => a.id - b.id).map(photo => ({ id: photo.id,
    storedPath: photo.storedPath, sha256: photo.sha256 ?? null, sortOrder: photo.sortOrder, rotation: photo.rotation,
    isMarker: photo.isMarker, isCover: photo.isCover, includeInListing: photo.includeInListing }));
  const marketplaces = [...(item.marketplaceListings ?? [])].sort((a, b) => a.marketplace.localeCompare(b.marketplace))
    .map(row => ({ marketplace: row.marketplace, status: row.status }));
  return JSON.stringify({ fields, photos, marketplaces });
}

export async function reviewSignature(item: ReviewItem): Promise<string> {
  const bytes = new TextEncoder().encode(reviewContent(item));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function createReviewCheckpoint(seen: ReviewItem, fresh: ReviewItem, savedVersion: string, rules: ReviewRules): Promise<ReviewCheckpoint> {
  if (seen.id !== fresh.id || seen.createdAt !== fresh.createdAt || fresh.updatedAt !== savedVersion
    || reviewContent(seen) !== reviewContent(fresh)) throw new Error("Details saved, but the item or photos changed during review. Reload and review the current item.");
  const problems = reviewProblems(fresh, rules);
  if (problems.length) throw new Error(problems.join(" "));
  if (!Number.isFinite(Date.parse(savedVersion))) throw new Error("The saved item version could not be verified.");
  const copy = buildExportCopy(fresh as unknown as CopySource);
  return { version: 1, key: reviewKey(fresh), revision: crypto.randomUUID(), id: fresh.id, createdAt: fresh.createdAt,
    sku: fresh.sku, itemVersion: savedVersion, signature: await reviewSignature(fresh), reviewedAt: new Date().toISOString(),
    title: copy.title, price: fresh.listedPrice!, photos: fresh.photos.filter(photo => photo.includeInListing && !photo.isMarker).length,
    phase: "reviewed" };
}

export function parseReviewCheckpoint(value: unknown): ReviewCheckpoint {
  const row = value as ReviewCheckpoint;
  if (!row || row.version !== 1 || row.key !== reviewKey(row) || typeof row.revision !== "string"
    || !/^[a-f0-9]{64}$/.test(row.signature) || !Number.isFinite(Date.parse(row.itemVersion))
    || !Number.isFinite(Date.parse(row.reviewedAt)) || typeof row.sku !== "string" || typeof row.title !== "string"
    || !Number.isFinite(row.price) || row.price <= 0 || !Number.isSafeInteger(row.photos) || row.photos < 0
    || !["reviewed", "approving", "approved", "blocked", "unknown"].includes(row.phase)
    || row.phase !== "reviewed" && (typeof row.attempt !== "string" || !row.attempt))
    throw new Error("A local review checkpoint could not be read. It has been kept for recovery.");
  return row;
}

export async function checkpointProblem(checkpoint: ReviewCheckpoint, item: ReviewItem | null, rules: ReviewRules): Promise<string | null> {
  if (checkpoint.phase !== "reviewed") return checkpoint.note || (checkpoint.phase === "approved" ? "Already approved." : "This earlier approval needs checking; do not repeat it automatically.");
  if (!item || item.id !== checkpoint.id || item.createdAt !== checkpoint.createdAt) return "The original item is no longer available.";
  if (item.updatedAt !== checkpoint.itemVersion || await reviewSignature(item) !== checkpoint.signature)
    return "Details or photos changed after individual review. Review this item again.";
  return reviewProblems(item, rules).join(" ") || null;
}
