import type { PrismaClient } from "@prisma/client";
import { capturePhotoFiles, cleanupPhotoFiles, forgetUnusedPhotoHashes, type FileStamps, type PhotoCleanupSettings } from "./photoCleanup.ts";
import { itemDeleteExpectation, parseItemDeleteExpectation, parseItemDeleteSelection, type ItemDeleteExpectation } from './itemDeleteSelection.ts';

type Store = Pick<PrismaClient, "$transaction">;
interface Options { force?: boolean; store?: Store; settings?: PhotoCleanupSettings; expected?: ItemDeleteExpectation }

export interface ItemDeleteResult {
  ok: boolean;
  sku?: string;
  id?: number;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
  code?: "SOLD_HISTORY" | "LIVE_LISTINGS" | "PUBLISH_IN_PROGRESS" | "BAD_ID" | "INVALID_CONFIRMATION" | "ITEM_CHANGED" | "DELETE_UNCONFIRMED";
  cleanupWarnings?: string[];
}

/** Deletes DB ownership atomically, then cleans up only the deleted photos.
 * Moved/split photos can still live in the source item's old directory, so a
 * stored folder path never authorizes recursive deletion of that directory. */
export async function deleteItem(id: number, opts: Options = {}): Promise<ItemDeleteResult> {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, code: "BAD_ID", error: "Invalid item ID." };
  let expected: ItemDeleteExpectation | undefined;
  try { if (opts.expected !== undefined) { expected = parseItemDeleteExpectation(opts.expected); if (expected.id !== id) throw Error(); } }
  catch { return { ok: false, code: 'INVALID_CONFIRMATION', error: 'Reload the selected item and confirm deletion again.' }; }
  const db = opts.store ?? (await import("./db")).prisma;
  const settings = opts.settings ?? await (await import("./settings")).getSettings();
  let stamps: FileStamps = new Map();
  let deleted;
  try {
    deleted = await db.$transaction(async tx => {
      const item = await tx.item.findUnique({ where: { id }, include: {
        photos: true, marketplaceListings: { select: { marketplace: true, status: true } },
        publishJobs: { where: { status: { in: ["queued", "retrying", "publishing"] } }, select: { id: true } },
      } });
      if (!item) return { ok: false as const, error: "not found" };
      const changed = { ok: false as const, sku: item.sku, code: 'ITEM_CHANGED' as const,
        error: 'The selected item changed since it was reviewed. This item was not deleted. Refresh and confirm it again.' };
      if (expected && (item.createdAt.toISOString() !== expected.createdAt || item.sku !== expected.sku)) return changed;
      if ((item.status === "Sold" || item.salePrice != null) && !opts.force)
        return { ok: false as const, sku: item.sku, code: "SOLD_HISTORY" as const, error: "SOLD_HISTORY" };
      if (item.publishJobs.length)
        return { ok: false as const, sku: item.sku, code: "PUBLISH_IN_PROGRESS" as const,
          error: "Cancel this item's pending publishing work before deleting it." };
      const live = item.marketplaceListings.find(row => !["ended", "sold", "not_published"].includes(row.status));
      const legacy = item.status !== "Sold" && (["Uploading", "Draft", "Published"].includes(item.niftyStatus) || ["Listed", "Uploaded to Nifty"].includes(item.status));
      if (live || legacy)
        return { ok: false as const, sku: item.sku, code: "LIVE_LISTINGS" as const,
          error: "This item has a live or unresolved marketplace listing. Resolve or remove that listing before deleting its inventory record." };
      if (expected && item.updatedAt.toISOString() !== expected.updatedAt) return changed;

      const files = [...new Set(item.photos.flatMap(photo => [photo.storedPath, photo.thumbPath]).filter((file): file is string => !!file))];
      stamps = capturePhotoFiles(files, settings);
      const hashes = [...new Set(item.photos.map(photo => photo.sha256).filter(Boolean))];
      await tx.photo.deleteMany({ where: { itemId: id } });
      await forgetUnusedPhotoHashes(tx, hashes);
      await tx.item.delete({ where: { id } });
      return { ok: true as const, ...itemDeleteExpectation(item), files };
    });
  } catch (error) {
    return { ok: false, code: 'DELETE_UNCONFIRMED', error: error instanceof Error ? error.message : String(error) };
  }
  if (!deleted.ok) return deleted;

  let cleanupWarnings: string[];
  try { cleanupWarnings = await cleanupPhotoFiles(db, deleted.files, stamps, settings); }
  catch { cleanupWarnings = ['Inventory deletion completed, but photo cleanup could not be confirmed. Archived originals are retained.']; }
  return { ok: true, id: deleted.id, sku: deleted.sku, createdAt: deleted.createdAt, updatedAt: deleted.updatedAt,
    ...(cleanupWarnings.length ? { cleanupWarnings } : {}) };
}

/** Validate the complete reviewed selection before touching any item. Never force bulk deletion. */
export async function deleteSelectedItems(ids: unknown, expectedItems: unknown, opts: Pick<Options, 'store' | 'settings'> = {}) {
  const expected = parseItemDeleteSelection(ids, expectedItems);
  const deletedIds: number[] = [], soldKeptIds: number[] = [], failed: { id: number; error: string }[] = [];
  const cleanupWarnings: { id: number; warnings: string[] }[] = [];
  let uncertain = false;
  for (const item of expected) {
    if (uncertain) { failed.push({ id: item.id, error: 'Not attempted after an unconfirmed deletion. Refresh before another action.' }); continue; }
    try {
      const result = await deleteItem(item.id, { ...opts, force: false, expected: item });
      if (result.ok) { deletedIds.push(item.id); if (result.cleanupWarnings?.length) cleanupWarnings.push({ id: item.id, warnings: result.cleanupWarnings }); }
      else if (result.code === 'SOLD_HISTORY') soldKeptIds.push(item.id);
      else { failed.push({ id: item.id, error: result.code === 'DELETE_UNCONFIRMED'
        ? 'Deletion could not be confirmed. Refresh before another action.' : result.error || 'This item could not be deleted.' });
        if (result.code === 'DELETE_UNCONFIRMED') uncertain = true; }
    } catch {
      uncertain = true;
      failed.push({ id: item.id, error: 'Deletion could not be confirmed. Refresh before trying again.' });
    }
  }
  return { ok: true, expectedItems: expected, deleted: deletedIds.length, soldKept: soldKeptIds.length, deletedIds, soldKeptIds, failed, cleanupWarnings };
}
