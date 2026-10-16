import fs from "node:fs";
import path from "node:path";

export interface ImportedPhotoMetadata {
  storedPath: string;
  originalFilename: string;
  sourcePath?: string;
  sourceRelativePath?: string;
  importedAt: string;
}

/** Import metadata is audit evidence, never a claim that upload arrival order
 * equals capture order. The worker resolves chronology from original EXIF and
 * camera filenames, then freezes its own manifest. No source bytes are removed. */
export function recordImportedPhoto(dataRoot: string, photo: Omit<ImportedPhotoMetadata, "importedAt">): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  const fd = fs.openSync(path.join(dataRoot, "intake-imports.jsonl"), "a", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ ...photo, importedAt: new Date().toISOString() }) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
