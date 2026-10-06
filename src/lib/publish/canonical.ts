// The canonical listing builder (§45.11) + shared pre-publish validation (§45.10).
//
// One item record, one copy source: buildExportCopy is the SAME function the
// Nifty export ships through, so a direct-published title/description can never
// disagree with a Nifty-published one. Photos come from the item's READY folder
// (rotation already applied, ordered, SKU-prefixed) — never from raw storage.

import fs from "node:fs";
import path from "node:path";
import type { Item, Photo } from "@prisma/client";
import type { AppSettingsData } from "../types.ts";
import { buildExportCopy } from "../listingCopy.ts";
import { sizelessOk } from "../listing.ts";
import { describePackage } from '../packageDetails.ts';
import type { CanonicalListing, ValidationIssue } from "./types.ts";
import { readPhotoSnapshot } from "../preparedPhotos.ts";

export interface CanonicalResult {
  listing: CanonicalListing | null;
  issues: ValidationIssue[];
}

/**
 * Photo integrity (§45.12): only files named `<SKU>_NN.<ext>` in the item's own
 * ready folder count. A file that doesn't carry this item's SKU is IGNORED and
 * reported, never uploaded — publishing must not be able to cross photos
 * between SKUs even if a folder is polluted.
 */
export function listReadyPhotos(readyDir: string, sku: string): { photos: { path: string; name: string }[]; strays: string[] } {
  const photosDir = path.join(readyDir, "listing_photos");
  let names: string[] = [];
  try {
    names = fs.readdirSync(photosDir);
  } catch {
    return { photos: [], strays: [] };
  }
  const own = new RegExp(`^${sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)\\.(jpe?g|png|webp)$`, "i");
  const photos: { path: string; name: string }[] = [];
  const strays: string[] = [];
  for (const name of names.sort()) {
    if (own.test(name)) photos.push({ path: path.join(photosDir, name), name });
    else if (!/_sku_marker\./i.test(name)) strays.push(name);
  }
  return { photos, strays };
}

/**
 * Build the canonical listing, collecting every validation problem instead of
 * stopping at the first (§45.10: the operator fixes a list, not a whack-a-mole).
 * A listing is only returned when there are NO blocking issues.
 */
export function buildCanonicalListing(
  item: Item & { photos: Photo[] },
  settings: AppSettingsData,
): CanonicalResult {
  const issues: ValidationIssue[] = [];

  // Approval gate (§45.24): the operator's explicit "Ready" click is the approval
  // act in this app — it already enforces requiredFieldsForReady + photo minimum.
  if (!["Ready", "Ready for Nifty"].includes(item.status)) {
    issues.push({
      field: "status",
      message: `not approved for publishing (status "${item.status}" — approve items via Review → Ready)`,
    });
  }

  // Nifty-overlap guard (§45.19): an item live through Nifty is already crosslisted
  // on the marketplaces — a direct publish would DUPLICATE it there.
  if (["Draft", "Published", "Uploading"].includes(item.niftyStatus ?? "") && !settings.publish?.allowNiftyOverlap) {
    issues.push({
      field: "niftyStatus",
      message: "This imported listing still needs reconciliation. Verify its marketplace links before creating another copy.",
    });
  }

  const price = item.listedPrice;
  if (price == null || !(price > 0)) issues.push({ field: "price", message: "no price set" });
  if (!item.condition) issues.push({ field: "condition", message: "condition not set" });
  if (!item.brand || item.brand === "Unknown") issues.push({ field: "brand", message: "brand missing" });
  if (!item.itemType) issues.push({ field: "itemType", message: "item type missing" });

  const sizeExempt = sizelessOk(item.itemType, item.category);
  if (!item.size && !sizeExempt) issues.push({ field: "size", message: "size missing (required for garments)" });

  if (!item.readyFolderPath) {
    issues.push({ field: "photos", message: "not exported yet — press Ready on the item first" });
  }

  let photos: { path: string; name: string }[] = [];
  if (item.readyFolderPath) {
    const scan = listReadyPhotos(item.readyFolderPath, item.sku);
    photos = scan.photos;
    if (scan.strays.length) {
      issues.push({
        field: "photos",
        message: `ready folder contains ${scan.strays.length} file(s) not named for SKU ${item.sku} (${scan.strays.slice(0, 3).join(", ")}) — refusing to publish until re-exported`,
      });
    }
    if (photos.length < settings.minListingPhotos) {
      issues.push({
        field: "photos",
        message: `only ${photos.length}/${settings.minListingPhotos} listing photos in the ready folder`,
      });
    }
    // Cross-check the export against the database's expectation: the count of
    // photos marked include-in-listing is what the export wrote.
    const expected = item.photos.filter((p) => p.includeInListing && !p.isMarker).length;
    if (photos.length !== expected) {
      issues.push({
        field: "photos",
        message: `ready folder holds ${photos.length} photo(s) but the item expects ${expected} — re-export before publishing`,
      });
    }
  }

  const photoSnapshot = readPhotoSnapshot(item);
  if (photoSnapshot) photos = photoSnapshot.recipe.map(p => ({ name: p.name, path: path.join(photoSnapshot.directory, "listing_photos", p.name) }));
  if (item.readyFolderPath && !photoSnapshot) {
    issues.push({ field: "photos", message: "Prepared photos do not match the current selection or are unverified. Review and approve this item again." });
  }

  if (issues.length) return { listing: null, issues };

  const copy = buildExportCopy(item);
  const { weightOz, dimensions: dims } = describePackage(item);

  return {
    issues: [],
    listing: {
      itemId: item.id,
      sku: item.sku,
      title: copy.title,
      description: copy.description,
      price: price as number,
      condition: item.condition as string,
      brand: item.brand,
      size: copy.exportSize,
      itemType: item.itemType,
      category: copy.category,
      categoryGroup: copy.categoryGroup,
      department: copy.department,
      material: copy.material,
      style: copy.style,
      color: item.color,
      secondaryColor: copy.secondaryColor,
      pattern: item.pattern,
      fit: copy.fit,
      model: item.model,
      styleNumber: item.styleNumber,
      countryOfOrigin: item.countryOfOrigin,
      inseam: item.inseam,
      trueVintage: copy.trueVintage,
      whenMade: copy.whenMade,
      weightOz,
      packageDims: dims,
      photos,
      photoSnapshot: photoSnapshot!,
      quantity: 1,
    },
  };
}
