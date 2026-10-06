// Export one item to its prepared listing folder (item.json + notes.txt + photos).
// Extracted from the /api/items/[id]/ready route so the assist route can RE-EXPORT
// immediately before every draft/publish: item.json is a snapshot, and any edit made
// after the original export (price set in the Pricing tab is the big one — price is
// not a gate field, so items auto-export unpriced) would otherwise be filled into
// Nifty stale. The uploader must always work from the DB as it is NOW.
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { getRequiredSettings } from "@/lib/settings";
import { runExport } from "@/lib/worker";
import { buildExportCopy } from "@/lib/listingCopy";
import { estimateWeightOz, ozToLb, ozToLbOz, estimateDims, needsInseam, sizelessOk } from "@/lib/listing";
import type { Item } from "@prisma/client";
import { photoRecipe, readPhotoSnapshot, samePhotoRecipe } from "./preparedPhotos";

const ext = (p: string) => path.extname(p).toLowerCase() || ".jpg";

export type ExportItemResult =
  | { ok: true; item: Item; readyDir: string; copyWarnings: string[] }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "NOT_APPROVABLE"; message: string }
  | { ok: false; error: "UNSAFE_SKU" }
  | { ok: false; error: "GATE_FAILED"; missing: string[]; listingCount: number; minListingPhotos: number }
  | { ok: false; error: "EXPORT_FAILED"; message: string };

export async function exportItemById(id: number, options: { requirePrice?: boolean; expectedUpdatedAt?: string } = {}): Promise<ExportItemResult> {
  const item = await prisma.item.findUnique({
    where: { id },
    include: { photos: { orderBy: { sortOrder: "asc" } }, marketplaceListings: {select:{status:true}} },
  });
  if (!item) return { ok: false, error: "not_found" };
  if (options.expectedUpdatedAt && item.updatedAt.toISOString() !== options.expectedUpdatedAt) return { ok: false, error: "NOT_APPROVABLE", message: "Item changed after saving. Refresh its details before approving." };
  if (options.requirePrice && (!Number.isFinite(item.listedPrice) || Number(item.listedPrice) <= 0)) return { ok: false, error: "NOT_APPROVABLE", message: "Set a price greater than zero before approving for crosslisting." };
  if(["Sold","Archived","Removed"].includes(item.status)) return {ok:false,error:"NOT_APPROVABLE",message:"This item cannot be approved for another upload from its current state."};
  // Defensive: the SKU is interpolated into export folder + file paths, so never let a
  // path-unsafe value escape the ready root (SKUs are normalized at intake, but guard anyway).
  if (!/^[A-Za-z0-9_-]+$/.test(item.sku)) {
    return { ok: false, error: "UNSAFE_SKU" };
  }

  let settings;
  try { settings = await getRequiredSettings(); }
  catch { return { ok: false, error: "EXPORT_FAILED", message: "Saved approval settings are unavailable. Retry after settings can be read." }; }
  // Accessories (bags/jewelry/hats/scarves...) legitimately have no size — the
  // "size" gate field is exempted for them so they can reach Ready (2026-08-05
  // accessories expansion). Everything else in requiredFieldsForReady still applies.
  const sizeExempt = sizelessOk(item.itemType, item.category);
  const missing = settings.requiredFieldsForReady.filter(
    (f) => !(item as unknown as Record<string, unknown>)[f] && !(f === "size" && sizeExempt),
  );
  const listing = item.photos.filter((p) => p.includeInListing && !p.isMarker);
  if (missing.length || listing.length < settings.minListingPhotos) {
    return {
      ok: false, error: "GATE_FAILED", missing,
      listingCount: listing.length, minListingPhotos: settings.minListingPhotos,
    };
  }

  // The listing copy itself — title, description, category and the attribute
  // resolution behind them — lives in listingCopy.ts so the Listings tab can show
  // exactly what a push would send without writing anything. Same function, same
  // answer, so the screen and the file can never disagree.
  const copy = buildExportCopy(item);
  const {
    title, description, category, publicNotes, whenMade, sleeve, exportSize,
    categoryGroup, collarCut, department, material, style, secondaryColor, fit,
    trueVintage, etsyEligible, etsyAllowed, copyWarnings,
  } = copy;
  if (copyWarnings.length) {
    console.warn(`[ready] ${item.sku} copy quality: ${copyWarnings.join("; ")} — "${title}"`);
  }

  const weightOz = item.weightOz ?? estimateWeightOz(item.itemType);
  const weightLb = ozToLb(weightOz);
  const lbOz = ozToLbOz(weightOz);
  const price = item.listedPrice ?? null;
  // Per-item package dimensions (smaller for light tops, bigger for jackets/coats).
  const dims = estimateDims(item.itemType);
  // Which committed values are ESTIMATES (guessed from item type, not your data) — the
  // assist surfaces these so you verify them before publishing (B22).
  const estimatedFields: string[] = [];
  if (item.weightOz == null) estimatedFields.push("weight");
  estimatedFields.push("dimensions"); // always from item type (no per-item dims field yet)
  if (needsInseam(item.itemType) && !item.inseam) estimatedFields.push("inseam");
  if (!item.size && exportSize) estimatedFields.push("size"); // auto "One Size" for a size-less accessory
  // Etsy eligibility (etsyEligible / etsyAllowed) comes from buildExportCopy above —
  // only handmade / 20+yr vintage / craft / party supplies go to Etsy, and True Vintage
  // takes the "vintage" path. The exported value drives the assist's Etsy questions.
  let recipe;
  try { recipe = photoRecipe(item.sku, item.photos); }
  catch { return { ok: false, error: "EXPORT_FAILED", message: "A selected photo has an invalid path or rotation. Correct it before approving." }; }
  // A new approval never rewrites files already handed to a publisher. Retain
  // older snapshots; deleting them needs a separate ownership-aware cleanup.
  const readyDir = path.join(settings.readyPath, item.sku, "versions", randomUUID());
  const listingPhotos = recipe.map(p => ({ src: p.sourcePath, destName: p.name, rotation: p.rotation }));
  const marker = item.photos.find((p) => p.isMarker);

  const spec = {
    sku: item.sku,
    readyDir,
    listingPhotos,
    photoRecipe: recipe,
    itemId: item.id,
    marker: marker
      ? { src: marker.storedPath, destName: `${item.sku}_sku_marker${ext(marker.storedPath)}` }
      : null,
    notes: {
      Title: title,
      SKU: item.sku, Brand: item.brand, Size: exportSize ?? "",
      "Item Type": item.itemType ?? "", "Category Group": categoryGroup,
      Color: item.color ?? "", Pattern: item.pattern ?? "",
      Condition: item.condition ?? "",
      ...(sleeve ? { Sleeve: sleeve } : {}),
      ...(collarCut ? { Collar: "cut off (not a crewneck)" } : {}),
      Category: category,
      Price: price != null ? `$${price.toFixed(2)}` : "(not set)",
      "When Made": whenMade,
      "Weight": `${weightLb} lb (${lbOz.lb} lb ${lbOz.oz} oz / ${weightOz} oz)`,
      "Dimensions": `${dims.length} x ${dims.width} x ${dims.height} in`,
      "Etsy": etsyAllowed ? `eligible (${etsyEligible})` : "skip (not eligible)",
      Description: description,
      Notes: item.notes ?? "",
    },
    itemJson: {
      sku: item.sku, brand: item.brand, size: exportSize, itemType: item.itemType,
      // Top-level category group — the assist uses it to drill Nifty's category tree
      // toward the right branch (Bags/Jewelry/Hats/Accessories) for non-clothing items,
      // and to skip garment-only checks (size warnings) for size-less accessories.
      categoryGroup, sizeless: !item.size && sizelessOk(item.itemType, item.category),
      color: item.color, pattern: item.pattern, condition: item.condition,
      department, material, style, secondaryColor, fit, sleeve, inseam: item.inseam ?? null,
      measurements: {
        chestIn: item.chestIn ?? null, lengthIn: item.lengthIn ?? null, sleeveIn: item.sleeveIn ?? null,
        shoulderIn: item.shoulderIn ?? null, waistIn: item.waistIn ?? null, hipIn: item.hipIn ?? null,
        riseIn: item.riseIn ?? null, inseam: item.inseam ?? null,
      },
      title, description, category,
      price, whenMade,
      weightOz, weightLb, weightLbWhole: lbOz.lb, weightOzRemainder: lbOz.oz,
      // Per-item package dimensions (inches) the assist fills instead of a fixed size.
      packageDims: { length: dims.length, width: dims.width, height: dims.height },
      // Etsy gate for the assist: only list to Etsy when allowed.
      etsyEligible, etsyAllowed, trueVintage,
      // Guessed-from-type values the assist tells the operator to verify (B22).
      estimatedFields,
      notes: item.notes ?? "", publicNotes,
      listingPhotos: listingPhotos.map((p) => `listing_photos/${p.destName}`),
    },
  };

  try {
    fs.mkdirSync(path.dirname(readyDir), { recursive: true });
    fs.mkdirSync(readyDir); // exclusive: even an unexpected collision must not overwrite an export
    await runExport(settings, spec);
    if (!readPhotoSnapshot({ ...item, readyFolderPath: readyDir })) throw new Error("Prepared photos could not be verified. Review and approve again.");
  } catch (e) {
    // A genuine export-worker failure (not a gate fail) — log it durably so it doesn't
    // vanish with the toast, then surface a clean error (§27).
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await prisma.problemLog.create({ data: { type: "EXPORT_FAILED", sku: item.sku, message: `export failed: ${msg}` } });
    } catch { /* logging must not mask the real error */ }
    return { ok: false, error: "EXPORT_FAILED", message: msg };
  }
  // Refreshing a live/imported listing must not reset its history or queue it again.
  const alreadyListed = item.marketplaceListings.some(row=>!["ended","not_published"].includes(row.status)) || ["Uploading","Draft","Published"].includes(item.niftyStatus ?? "");
  const saved = await prisma.$transaction(async tx => {
    const currentPhotos = await tx.photo.findMany({ where: { itemId: item.id } });
    if (!samePhotoRecipe(recipe, photoRecipe(item.sku, currentPhotos))) return { count: 0 };
    return tx.item.updateMany({
      where: { id: item.id, updatedAt: item.updatedAt, status: { notIn: ["Sold", "Archived", "Removed"] } },
      data: {
        readyFolderPath: readyDir, publicNotes,
        ...(!alreadyListed ? {status:"Ready"} : {}),
      },
    });
  });
  if (saved.count !== 1) return { ok: false, error: "NOT_APPROVABLE", message: "Item changed while preparing its listing. Review the current item before approving." };
  const updated = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
  return { ok: true, item: updated, readyDir, copyWarnings };
}
