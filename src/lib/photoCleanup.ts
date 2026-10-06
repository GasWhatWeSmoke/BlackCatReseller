import fs from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "./types.ts";

export type PhotoCleanupSettings = Pick<AppSettingsData, "processingPath" | "readyPath" | "needsReviewPath" | "archivePath" | "incomingPath">;
export type FileStamps = Map<string, { size: number; mtimeMs: number; birthtimeMs: number; ino: number }>;
const comparable = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
function identity(file: string): string {
  try { return comparable(fs.realpathSync.native(file)); }
  catch { return comparable(file); }
}
function within(root: string, file: string): boolean {
  const relative = path.relative(comparable(root), comparable(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function cleanupAllowed(file: string, settings: PhotoCleanupSettings): boolean {
  if (!path.isAbsolute(file)) return false;
  const real = identity(file);
  const workingRoots = [settings.processingPath, settings.readyPath, settings.needsReviewPath];
  if (workingRoots.some(root => root && (comparable(root) === comparable(file) || identity(root) === real))) return false;
  for (const root of [settings.archivePath, settings.incomingPath]) {
    if (!root || !path.isAbsolute(root)) return false;
    if (comparable(root) === comparable(file) || within(root, file) || identity(root) === real || within(identity(root), real)) return false;
  }
  return workingRoots.some(root => root && path.isAbsolute(root) && within(root, file) && within(identity(root), real));
}

export function capturePhotoFiles(files: string[], settings: PhotoCleanupSettings): FileStamps {
  const stamps: FileStamps = new Map();
  for (const file of files) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && cleanupAllowed(file, settings))
        stamps.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, ino: stat.ino });
    } catch { /* Missing or unsafe paths do not authorize deletion. */ }
  }
  return stamps;
}

async function pendingPhotos(tx: Prisma.TransactionClient): Promise<Record<string, unknown>[]> {
  const groups = await tx.collision.findMany({ where: { status: "pending" }, select: { incomingPhotosJson: true } });
  return groups.flatMap(group => {
    const photos: unknown = JSON.parse(group.incomingPhotosJson);
    if (!Array.isArray(photos) || photos.some(p => !p || typeof p !== "object" || Array.isArray(p))) {
      throw new Error("Unresolved photo groups could not be checked safely.");
    }
    return photos;
  });
}

/** Run after photo rows have been removed, inside the same transaction. */
export async function forgetUnusedPhotoHashes(tx: Prisma.TransactionClient, hashes: string[]): Promise<void> {
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return;
  const remaining = await tx.photo.findMany({ where: { sha256: { in: unique } }, select: { sha256: true } });
  const retained = new Set<unknown>(remaining.map(photo => photo.sha256));
  for (const photo of await pendingPhotos(tx)) retained.add(photo.sha256);
  await tx.fileHash.deleteMany({ where: { sha256: { in: unique.filter(hash => !retained.has(hash)) } } });
}

/** DB deletion must already be committed. Never recursively remove folders or
 * delete an archive/import original, shared path, pending group or dedup source. */
export async function cleanupPhotoFiles(db: Pick<PrismaClient, "$transaction">, files: string[], stamps: FileStamps, settings: PhotoCleanupSettings): Promise<string[]> {
  const warnings = new Set<string>();
  try {
    const references = await db.$transaction(async tx => {
      const photos = await tx.photo.findMany({ select: { storedPath: true, thumbPath: true } });
      const hashes = await tx.fileHash.findMany({ select: { processedPath: true } });
      const pending = await pendingPhotos(tx);
      return [...photos.flatMap(photo => [photo.storedPath, photo.thumbPath]), ...hashes.map(hash => hash.processedPath),
        ...pending.flatMap(photo => [photo.storedPath, photo.thumbPath])]
        .filter((file): file is string => typeof file === "string" && !!file);
    });
    const referenced = new Set(references.map(identity));
    for (const file of files) {
      if (referenced.has(identity(file))) continue;
      try {
        if (!fs.existsSync(file)) continue;
        const before = stamps.get(file), now = fs.lstatSync(file);
        if (!before || !cleanupAllowed(file, settings) || !now.isFile() || now.isSymbolicLink() ||
            before.size !== now.size || before.mtimeMs !== now.mtimeMs || before.birthtimeMs !== now.birthtimeMs || before.ino !== now.ino) {
          warnings.add("Some files were retained because their ownership or current contents could not be verified.");
          continue;
        }
        fs.unlinkSync(file);
        let folder = path.dirname(file);
        while (cleanupAllowed(folder, settings)) {
          try { fs.rmdirSync(folder); } catch { break; }
          folder = path.dirname(folder);
        }
      } catch { warnings.add("The record was removed, but some working files could not be cleaned up."); }
    }
  } catch { warnings.add("The record was removed. Working files were retained because remaining ownership could not be checked."); }
  return [...warnings];
}
