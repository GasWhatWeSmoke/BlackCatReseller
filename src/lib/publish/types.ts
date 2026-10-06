// Direct marketplace publishing (§45) — the shared contracts.
//
// The design rule that everything else hangs off: Black Cat holds ONE canonical
// item record, and each marketplace adapter transforms it into that platform's
// payload. Marketplace differences live inside adapters; nothing eBay- or
// Depop-specific may leak into the queue, the routes, or the UI.

import type { AppSettingsData } from "../types.ts";
import type { PhotoSnapshot } from "../preparedPhotos.ts";

/** Etsy is back in scope for the new-batch rollout (2026-09-09). */
export type MarketplaceId = "depop" | "ebay" | "etsy" | "mercari" | "poshmark";

/** One listing photo, already export-processed (rotation applied, ordered,
 *  SKU-prefixed filename) — taken from the item's ready folder, never raw. */
export interface CanonicalPhoto {
  /** Absolute path on disk. */
  path: string;
  /** Export filename, e.g. "000084_01.jpg" — carries the SKU (§45.12). */
  name: string;
}

/**
 * The canonical listing: what Black Cat asserts about one item, marketplace-free.
 * Built from the Item row + buildExportCopy (the SAME copy the Nifty flow ships,
 * so a title can never differ between publishing paths).
 */
export interface CanonicalListing {
  itemId: number;
  sku: string;
  title: string;
  description: string;
  price: number;
  condition: string;           // Black Cat vocabulary ("New with tags", "Good", ...)
  brand: string | null;
  size: string | null;         // export size (auto "One Size" for sizeless accessories)
  itemType: string | null;
  category: string | null;     // Black Cat's category path string
  categoryGroup: string;       // Clothing | Bag | Jewelry | Hat | Shoes | Accessory
  department: string | null;
  material: string | null;
  style: string | null;
  color: string | null;
  secondaryColor: string | null;
  pattern: string | null;
  fit: string | null;
  model: string | null;
  styleNumber: string | null;
  countryOfOrigin: string | null;
  inseam: string | null;
  /** Reviewed production facts resolved by the same copy builder as Nifty. */
  trueVintage?: boolean;
  whenMade?: string | null;
  weightOz: number;
  packageDims: { length: number; width: number; height: number };
  photos: CanonicalPhoto[];
  /** Required for automatic native posting; old/manual fill payloads may omit it. */
  photoSnapshot?: PhotoSnapshot;
  quantity: number;            // each adapter validates its native quantity support
}

/** Why an item cannot be published as it stands (§45.10). */
export interface ValidationIssue {
  field: string;
  message: string;
}

/** How a publish failure should be treated (§45.21). */
export type PublishErrorClass = "retryable" | "requires_review" | "fatal";

export class PublishError extends Error {
  readonly errorClass: PublishErrorClass;
  readonly notSubmitted: boolean;
  constructor(message: string, errorClass: PublishErrorClass, notSubmitted = false) {
    super(message);
    this.name = "PublishError";
    this.errorClass = errorClass;
    this.notSubmitted = notSubmitted;
  }
}

export interface PublishSuccess {
  ok: true;
  externalListingId: string;
  externalUrl: string | null;
  publishedPrice?: number;
  publishedTitle?: string;
}

export interface AdapterAvailability {
  /** Can this adapter publish right now, with the current settings? */
  configured: boolean;
  /** Operator-facing reason when not configured ("no refresh token", "no public
   *  API — assisted publishing planned", ...). */
  reason: string | null;
}

/**
 * One marketplace adapter (§45.4). Everything platform-specific — auth, category
 * mapping, field limits, condition mapping, image upload, validation quirks,
 * publishing, returned ids — lives behind this interface.
 */
export interface MarketplaceAdapter {
  readonly id: MarketplaceId;
  readonly name: string;
  /** Whether real publishing is implemented at all (false = declared future). */
  readonly implemented: boolean;
  availability(settings: AppSettingsData): AdapterAvailability;
  /** Marketplace-specific validation ON TOP of the shared canonical validation. */
  validate(listing: CanonicalListing, settings: AppSettingsData): ValidationIssue[];
  /**
   * Publish one listing. Throws PublishError with a classification on failure;
   * never throws bare errors for expected marketplace conditions.
   */
  publish(listing: CanonicalListing, settings: AppSettingsData): Promise<PublishSuccess>;
}
