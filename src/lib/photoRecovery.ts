import fs from "node:fs";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "./types.ts";
import { isUnderManagedRoots } from "./paths.ts";
import { PhotoChangeError, recountPhotoItem } from "./photoMutations.ts";
import { capturePhotoFiles, cleanupPhotoFiles, forgetUnusedPhotoHashes, type FileStamps } from "./photoCleanup.ts";

type Store = Pick<PrismaClient, "$transaction">;
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PhotoChangeError("Invalid photo repair.", 400);
  return value as Record<string, unknown>;
}
function safeSku(value: unknown, maximum = 32): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.trim()) || value.trim().length > maximum)
    throw new PhotoChangeError("Enter a SKU using letters, numbers, hyphens or underscores.", 400);
  return value.trim();
}

/** Read ownership inside the transaction; a prior screen's photo list is not authority. */
export async function transferPhotos(db: Store, sourceId: number, value: unknown, split: boolean) {
  if (!validId(sourceId)) throw new PhotoChangeError("Invalid source item.", 400);
  const input = inputObject(value), photoIds = input.photoIds;
  if (!Array.isArray(photoIds) || !photoIds.length || photoIds.length > 1000 || !photoIds.every(validId) || new Set(photoIds).size !== photoIds.length)
    throw new PhotoChangeError("Select unique photos to move.", 400);
  const newSku = split ? safeSku(input.newSku) : null;
  const targetId = input.targetItemId;
  const targetSku = typeof input.targetSku === "string" ? input.targetSku.trim() : "";
  if (!split && targetId !== undefined && !validId(targetId)) throw new PhotoChangeError("Invalid destination item.", 400);
  if (!split && targetId === undefined && !targetSku) throw new PhotoChangeError("Pick a destination item.", 400);
  try {
    return await db.$transaction(async tx => {
      const source = await tx.item.findUnique({ where: { id: sourceId } });
      if (!source) throw new PhotoChangeError("Source item not found.", 404);
      const moving = await tx.photo.findMany({ where: { itemId: sourceId, id: { in: photoIds } },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
      if (moving.length !== photoIds.length) throw new PhotoChangeError("Some photos no longer belong to this item. Reload before moving them.", 409);
      const target = split
        ? await tx.item.create({ data: { sku: newSku!, status: "Photographed", isShell: false,
          batchId: source.batchId, notes: `Split from ${source.sku}` } })
        : await tx.item.findUnique({ where: validId(targetId) ? { id: targetId } : { sku: targetSku } });
      if (!target) throw new PhotoChangeError("Destination item not found. Create it first or use Split.", 404);
      if (target.id === sourceId) throw new PhotoChangeError("Source and destination are the same item.", 400);
      const max = await tx.photo.aggregate({ where: { itemId: target.id, isMarker: false }, _max: { sortOrder: true } });
      let order = (max._max.sortOrder ?? -1) + 1;
      for (const photo of moving) {
        const changed = await tx.photo.updateMany({ where: { id: photo.id, itemId: sourceId },
          data: { itemId: target.id, sortOrder: photo.isMarker ? 999 : order++, isCover: false } });
        if (changed.count !== 1) throw new PhotoChangeError("Photo ownership changed. Reload before moving it.", 409);
      }
      const items = [await recountPhotoItem(tx, sourceId, true), await recountPhotoItem(tx, target.id, true)];
      const item = split ? await tx.item.findUniqueOrThrow({ where: { id: target.id } }) : undefined;
      return { ok: true, moved: moving.length, target: { id: target.id, sku: target.sku }, item, items };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002")
      throw new PhotoChangeError("That SKU already exists. Pick another or use Move to item.", 409);
    throw error;
  }
}

function digest(filename: string) {
  const before = fs.statSync(filename, { bigint: true });
  if (!before.isFile()) throw new PhotoChangeError("A staged photo is no longer a file.", 409);
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(filename, "r");
  try { for (;;) { const size = fs.readSync(fd, buffer); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { fs.closeSync(fd); }
  const after = fs.statSync(filename, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino)
    throw new PhotoChangeError("A staged photo changed while being checked. Re-import the group.", 409);
  return { sha256: hash.digest("hex"), size: after.size, mtimeNs: after.mtimeNs, ino: after.ino };
}

function readIncoming(raw: string, settings: AppSettingsData) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new PhotoChangeError("This staged group is unreadable. Re-import its photos.", 409); }
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new PhotoChangeError("This staged group has no valid photo selection.", 409);
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PhotoChangeError("The staged photo metadata is unreadable. Re-import its group.", 409);
    const p = entry as Record<string, unknown>;
    if (typeof p.originalFilename !== "string" || !p.originalFilename || typeof p.storedPath !== "string" ||
        !/\.(jpe?g|png|webp)$/i.test(p.storedPath) || !isUnderManagedRoots(p.storedPath, settings))
      throw new PhotoChangeError("A staged photo is outside the workspace or invalid. Re-import its group.", 409);
    let receipt;
    try { receipt = digest(p.storedPath); }
    catch (error) { if (error instanceof PhotoChangeError) throw error; throw new PhotoChangeError("A staged photo is missing or unreadable. Re-import its group.", 409); }
    if (p.sha256 != null && p.sha256 !== "" && (typeof p.sha256 !== "string" || p.sha256.toLowerCase() !== receipt.sha256))
      throw new PhotoChangeError("A staged photo changed since import. Re-import its group before replacing photos.", 409);
    const rotation = p.rotation === undefined ? 0 : p.rotation;
    if (typeof rotation !== "number" || !Number.isSafeInteger(rotation) || rotation % 90 !== 0 ||
        (p.isMarker !== undefined && typeof p.isMarker !== "boolean") ||
        (p.includeInListing !== undefined && typeof p.includeInListing !== "boolean"))
      throw new PhotoChangeError("The staged photo settings are invalid. Re-import its group.", 409);
    const thumbPath = typeof p.thumbPath === "string" && isUnderManagedRoots(p.thumbPath, settings) &&
      fs.existsSync(p.thumbPath) && fs.statSync(p.thumbPath).isFile() ? p.thumbPath : null;
    const data = { originalFilename: p.originalFilename, storedPath: p.storedPath, thumbPath, sha256: receipt.sha256,
      isMarker: p.isMarker === true, includeInListing: p.isMarker !== true && p.includeInListing !== false,
      rotation: ((rotation % 360) + 360) % 360, decodedValue: typeof p.decodedValue === "string" ? p.decodedValue : null,
      width: typeof p.width === "number" && Number.isSafeInteger(p.width) && p.width > 0 ? p.width : null,
      height: typeof p.height === "number" && Number.isSafeInteger(p.height) && p.height > 0 ? p.height : null,
      exifDateTimeOriginal: typeof p.exifDateTimeOriginal === "string" ? p.exifDateTimeOriginal : null,
      exifSubSec: typeof p.exifSubSec === "string" ? p.exifSubSec : null };
    return { data, receipt };
  });
}

/** Caller reserves the existing incoming-operation slot. No source file is removed
 * until the complete resolution, including its claim, has committed. */
export async function resolvePhotoCollision(db: Store, id: number, resolution: unknown, settings: AppSettingsData) {
  if (!validId(id) || typeof resolution !== "string" || !["append", "replace", "new"].includes(resolution)) throw new PhotoChangeError("Invalid photo resolution.", 400);
  let stamps: FileStamps = new Map();
  const resolved = await db.$transaction(async tx => {
    const group = await tx.collision.findUnique({ where: { id } });
    if (!group) throw new PhotoChangeError("Photo group not found.", 404);
    if (group.status !== "pending") throw new PhotoChangeError("This photo group was already resolved. Reload the current groups.", 409);
    const incoming = readIncoming(group.incomingPhotosJson, settings);
    const claim = await tx.collision.updateMany({ where: { id, status: "pending" }, data: { status: "resolved", resolution: String(resolution) } });
    if (claim.count !== 1) throw new PhotoChangeError("This photo group was already resolved.", 409);
    let target;
    if (resolution === "new") {
      const base = safeSku(group.sku, 128); let sku = base, n = 2;
      while (await tx.item.findUnique({ where: { sku }, select: { id: true } })) {
        sku = `${base}-${n++}`;
        if (sku.length > 128) throw new PhotoChangeError("The generated SKU is too long. Correct the group SKU first.", 409);
      }
      target = await tx.item.create({ data: { sku, status: "Photographed", originalQrValue: group.sku } });
    } else {
      target = await tx.item.findUnique({ where: group.existingItemId !== null ? { id: group.existingItemId } : { sku: group.sku } });
      if (!target || target.sku !== group.sku) throw new PhotoChangeError("The original item is gone or its SKU changed. Reload before resolving this group.", 409);
    }
    const old = resolution === "replace" ? await tx.photo.findMany({ where: { itemId: target.id } }) : [];
    const files = [...new Set(old.flatMap(photo => [photo.storedPath, photo.thumbPath]).filter((file): file is string => !!file))];
    stamps = capturePhotoFiles(files, settings);
    if (old.length) await tx.photo.deleteMany({ where: { itemId: target.id } });
    const existing = await tx.photo.findMany({ where: { itemId: target.id }, select: { sha256: true } });
    const seen = new Set(existing.map(photo => photo.sha256.toLowerCase()));
    const max = await tx.photo.aggregate({ where: { itemId: target.id, isMarker: false }, _max: { sortOrder: true } });
    let order = (max._max.sortOrder ?? -1) + 1, added = 0, duplicatesSkipped = 0;
    for (const { data } of incoming) {
      if (seen.has(data.sha256)) { duplicatesSkipped++; continue; }
      seen.add(data.sha256);
      await tx.photo.create({ data: { ...data, itemId: target.id, isCover: false, sortOrder: data.isMarker ? 999 : order++ } });
      await tx.fileHash.upsert({ where: { sha256: data.sha256 }, update: {},
        create: { sha256: data.sha256, originalFilename: data.originalFilename, processedPath: data.storedPath, sku: target.sku } });
      added++;
    }
    await forgetUnusedPhotoHashes(tx, old.map(photo => photo.sha256));
    const state = await recountPhotoItem(tx, target.id, true);
    // Detect ordinary file changes that occurred while the other rows were written.
    for (const { data, receipt } of incoming) {
      const now = fs.statSync(data.storedPath, { bigint: true });
      if (now.size !== receipt.size || now.mtimeNs !== receipt.mtimeNs || now.ino !== receipt.ino)
        throw new PhotoChangeError("Staged photos changed during resolution. Re-import the group.", 409);
    }
    return { files, target: { id: target.id, sku: target.sku }, added, duplicatesSkipped, items: [state] };
  }, { timeout: 30_000 });
  const cleanupWarnings = await cleanupPhotoFiles(db, resolved.files, stamps, settings);
  const { files: _files, ...result } = resolved;
  return { ok: true, ...result, cleanupWarnings };
}
