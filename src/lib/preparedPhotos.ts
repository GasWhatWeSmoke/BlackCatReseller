import fs from "node:fs";
import path from "node:path";
import type { Photo } from "@prisma/client";

export type PhotoRecipe = { id: number; sourcePath: string; sourceHash: string; rotation: number; name: string };
type FileReceipt = { size: string; mtimeNs: string; sha256: string };
export type PhotoSnapshot = {
  version: 1; itemId: number; sku: string; directory: string;
  recipe: PhotoRecipe[]; sources: FileReceipt[]; files: FileReceipt[];
};

export function photoRecipe(sku: string, photos: Photo[]): PhotoRecipe[] {
  if (!/^[A-Za-z0-9_-]+$/.test(sku)) throw new Error("Invalid photo SKU");
  return photos.filter(p => p.includeInListing && !p.isMarker)
    .sort((a, b) => Number(b.isCover) - Number(a.isCover) || a.sortOrder - b.sortOrder || a.id - b.id)
    .map((p, index) => {
      const extension = path.extname(p.storedPath).toLowerCase();
      if (!Number.isSafeInteger(p.id) || p.id < 1 || !path.isAbsolute(p.storedPath) ||
          ![".jpg", ".jpeg", ".png", ".webp"].includes(extension) || ![0, 90, 180, 270].includes(p.rotation)) {
        throw new Error("Invalid selected photo");
      }
      return { id: p.id, sourcePath: p.storedPath, sourceHash: p.sha256, rotation: p.rotation,
        name: `${sku}_${String(index + 1).padStart(2, "0")}${extension}` };
    });
}

export function samePhotoRecipe(left: PhotoRecipe[], right: PhotoRecipe[]): boolean {
  return Array.isArray(right) && left.length === right.length && left.every((a, index) => {
    const b = right[index];
    return b && a.id === b.id && a.sourcePath === b.sourcePath && a.sourceHash === b.sourceHash &&
      a.rotation === b.rotation && a.name === b.name;
  });
}

function matchesFile(filename: string, receipt: FileReceipt): boolean {
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return false;
  const stat = fs.statSync(filename, { bigint: true });
  return stat.isFile() && String(stat.size) === receipt.size && String(stat.mtimeNs) === receipt.mtimeNs;
}

/** Cheap eligibility check. The posting worker also hashes source/export bytes
 * before opening the form and before Post; polling does not reread every image. */
export function readPhotoSnapshot(item: { id: number; sku: string; readyFolderPath: string | null; photos: Photo[] }): PhotoSnapshot | null {
  try {
    const directory = item.readyFolderPath;
    if (!directory || !path.isAbsolute(directory)) return null;
    if (fs.realpathSync(path.join(directory, "listing_photos")) !== path.join(fs.realpathSync(directory), "listing_photos")) return null;
    const manifest = path.join(directory, "item.json");
    if (fs.statSync(manifest).size > 1_000_000) return null;
    const snapshot: PhotoSnapshot = JSON.parse(fs.readFileSync(manifest, "utf8")).photoSnapshot;
    const recipe = photoRecipe(item.sku, item.photos);
    if (!recipe.length || !snapshot || snapshot.version !== 1 || snapshot.itemId !== item.id || snapshot.sku !== item.sku ||
        snapshot.directory !== directory || !samePhotoRecipe(recipe, snapshot.recipe) ||
        !Array.isArray(snapshot.sources) || snapshot.sources.length !== recipe.length ||
        !Array.isArray(snapshot.files) || snapshot.files.length !== recipe.length) return null;
    for (let i = 0; i < recipe.length; i++) {
      const exported = path.join(directory, "listing_photos", recipe[i].name);
      if (path.dirname(fs.realpathSync(exported)) !== fs.realpathSync(path.join(directory, "listing_photos")) ||
          !matchesFile(recipe[i].sourcePath, snapshot.sources[i]) || !matchesFile(exported, snapshot.files[i])) return null;
    }
    return snapshot;
  } catch { return null; }
}
