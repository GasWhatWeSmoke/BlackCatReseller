import type { Photo, Prisma, PrismaClient } from "@prisma/client";
import { capturePhotoFiles, cleanupPhotoFiles, forgetUnusedPhotoHashes, type FileStamps, type PhotoCleanupSettings } from "./photoCleanup.ts";

type Store = Pick<PrismaClient, "$transaction">;
export class PhotoChangeError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) { super(message); this.status = status; }
}
const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PhotoChangeError("Invalid photo change.", 400);
  return value as Record<string, unknown>;
}
function checkOwner(photo: Photo, input: Record<string, unknown>) {
  if ("expectedItemId" in input) {
    if (input.expectedItemId !== null && !validId(input.expectedItemId)) throw new PhotoChangeError("Invalid expected item.", 400);
    if (photo.itemId !== input.expectedItemId) throw new PhotoChangeError("This photo moved to another item. Reload its photos before changing it.", 409);
  }
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || !value.every(validId) || new Set(value).size !== value.length)
    throw new PhotoChangeError("Photo order must contain unique photo IDs.", 400);
  return value;
}

/** Keep counts and cover recovery in the same transaction as photo ownership. */
export async function recountPhotoItem(tx: Prisma.TransactionClient, id: number, fillCover: boolean) {
  const photos = await tx.photo.findMany({ where: { itemId: id }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  let cover = false;
  for (const photo of photos) {
    if (!photo.isCover) continue;
    if (!photo.isMarker && photo.includeInListing && !cover) { cover = true; continue; }
    await tx.photo.update({ where: { id: photo.id }, data: { isCover: false } }); photo.isCover = false;
  }
  if (fillCover && !cover) {
    const first = photos.find(photo => !photo.isMarker && photo.includeInListing);
    if (first) { await tx.photo.update({ where: { id: first.id }, data: { isCover: true } }); first.isCover = true; }
  }
  const photoCount = photos.filter(photo => !photo.isMarker && photo.includeInListing).length;
  await tx.item.update({ where: { id }, data: { photoCount } });
  return { id, photoCount, photos };
}

export async function editPhoto(db: Store, id: number, value: unknown) {
  if (!validId(id)) throw new PhotoChangeError("Invalid photo ID.", 400);
  const input = object(value);
  const allowed = new Set(["rotation", "includeInListing", "sortOrder", "itemId", "isCover", "expectedItemId", "photoOrder", "expectedOrder"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new PhotoChangeError("Unsupported photo change.", 400);
  const reordering = "photoOrder" in input;
  const data: Prisma.PhotoUncheckedUpdateInput = {};
  let order: number[] = [], expected: number[] = [];
  if (reordering) {
    if (Object.keys(input).some(key => !["photoOrder", "expectedOrder", "expectedItemId"].includes(key)))
      throw new PhotoChangeError("Save photo order separately from other changes.", 400);
    order = ids(input.photoOrder); expected = ids(input.expectedOrder);
  } else {
    if ("expectedOrder" in input) throw new PhotoChangeError("A new photo order is required.", 400);
    if ("rotation" in input) {
      if (typeof input.rotation !== "number" || !Number.isSafeInteger(input.rotation) || input.rotation % 90 !== 0)
        throw new PhotoChangeError("Rotation must be a multiple of 90 degrees.", 400);
      data.rotation = ((input.rotation % 360) + 360) % 360;
    }
    for (const key of ["includeInListing", "isCover"] as const) if (key in input) {
      if (typeof input[key] !== "boolean") throw new PhotoChangeError("Photo choices must be true or false.", 400);
      data[key] = input[key];
    }
    if ("sortOrder" in input) {
      if (typeof input.sortOrder !== "number" || !Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)
        throw new PhotoChangeError("Invalid photo position.", 400);
      data.sortOrder = input.sortOrder;
    }
    if ("itemId" in input) {
      if (input.itemId !== null && !validId(input.itemId)) throw new PhotoChangeError("Invalid destination item.", 400);
      data.itemId = input.itemId;
    }
    if (!Object.keys(data).length) throw new PhotoChangeError("Choose a photo change.", 400);
    if (data.isCover === true && data.includeInListing === false)
      throw new PhotoChangeError("A cover photo must be included in the listing.", 400);
  }
  return db.$transaction(async tx => {
    const photo = await tx.photo.findUnique({ where: { id } });
    if (!photo) throw new PhotoChangeError("Photo not found.", 404);
    checkOwner(photo, input);
    if (reordering) {
      if (photo.itemId === null || photo.isMarker) throw new PhotoChangeError("Choose an item's listing photo to reorder.", 400);
      const current = await tx.photo.findMany({ where: { itemId: photo.itemId, isMarker: false },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true } });
      if (current.length !== expected.length || current.some((p, index) => p.id !== expected[index]))
        throw new PhotoChangeError("Photos or their order changed. Reload before reordering.", 409);
      if (order.length !== current.length || order.some(id => !expected.includes(id)))
        throw new PhotoChangeError("Photo order must include every listing photo exactly once.", 400);
      for (let index = 0; index < order.length; index++) await tx.photo.update({ where: { id: order[index] }, data: { sortOrder: index } });
      const item = await recountPhotoItem(tx, photo.itemId, false);
      return { ok: true, photo: item.photos.find(p => p.id === id)!, items: [item] };
    }
    const targetId = "itemId" in input ? input.itemId as number | null : photo.itemId;
    if (targetId !== null && !await tx.item.findUnique({ where: { id: targetId }, select: { id: true } }))
      throw new PhotoChangeError("Destination item not found.", 404);
    if (data.isCover === true && (photo.isMarker || targetId === null))
      throw new PhotoChangeError("Choose a listing photo attached to an item as its cover.", 400);
    if (photo.isMarker && data.includeInListing === true) throw new PhotoChangeError("A SKU marker cannot be a listing photo.", 400);
    const moved = targetId !== photo.itemId;
    if (moved && data.isCover !== true) data.isCover = false;
    if (data.includeInListing === false) data.isCover = false;
    if (data.isCover === true) {
      data.includeInListing = true;
      await tx.photo.updateMany({ where: { itemId: targetId }, data: { isCover: false } });
    }
    const updated = await tx.photo.update({ where: { id }, data });
    const affected = [...new Set([photo.itemId, targetId].filter((id): id is number => id !== null))];
    const items = [];
    for (const itemId of affected) items.push(await recountPhotoItem(tx, itemId, moved || (photo.isCover && !updated.includeInListing)));
    return { ok: true, photo: items.flatMap(item => item.photos).find(p => p.id === id) ?? updated, items };
  });
}

export async function removePhoto(db: Store, id: number, value: unknown, settings: PhotoCleanupSettings) {
  if (!validId(id)) throw new PhotoChangeError("Invalid photo ID.", 400);
  const input = object(value);
  if (Object.keys(input).some(key => key !== "expectedItemId")) throw new PhotoChangeError("Unsupported photo removal option.", 400);
  let stamps: FileStamps = new Map();
  const removed = await db.$transaction(async tx => {
    const photo = await tx.photo.findUnique({ where: { id } });
    if (!photo) throw new PhotoChangeError("Photo not found.", 404);
    checkOwner(photo, input);
    const files = [...new Set([photo.storedPath, photo.thumbPath].filter((file): file is string => !!file))];
    stamps = capturePhotoFiles(files, settings);
    await tx.photo.delete({ where: { id } });
    await forgetUnusedPhotoHashes(tx, [photo.sha256]);
    const items = photo.itemId === null ? [] : [await recountPhotoItem(tx, photo.itemId, true)];
    return { files, items };
  });
  const cleanupWarnings = await cleanupPhotoFiles(db, removed.files, stamps, settings);
  return { ok: true, items: removed.items, cleanupWarnings };
}
