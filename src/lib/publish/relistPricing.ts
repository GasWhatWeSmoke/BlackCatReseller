import type { CanonicalListing } from "./types.ts";
import { PublishError } from "./types.ts";

export type RelistPricing = "reviewed" | "preserve_marketplace";

/** Use the ended listing's recorded price without changing the shared item copy. */
export function applyRelistPrice(
  listing: CanonicalListing,
  previous: { status: string; price: number | null } | null,
  policy: RelistPricing = "reviewed",
): CanonicalListing {
  if (policy !== "preserve_marketplace" || !previous || !["ended", "not_published"].includes(previous.status)) return listing;
  // A new listing's proven-unsubmitted attempt has no earlier platform price.
  if (previous.status === "not_published" && previous.price === null) return listing;
  const price = previous.price;
  if (price === null || !Number.isFinite(price) || price <= 0 || Math.round(price * 100) / 100 !== price) {
    throw new PublishError("Verify this marketplace's previous price before relisting.", "requires_review", true);
  }
  return { ...listing, price };
}
