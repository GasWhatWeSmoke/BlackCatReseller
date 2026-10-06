import fs from "node:fs";
import path from "node:path";

// Move a file into destDir, never overwriting (numeric suffix on name collision). Mirrors
// the worker's fileops.move_into so Node can own the per-item archive step (§25.2). Uses a
// rename, with a copy+unlink fallback for the rare cross-volume case.
function moveInto(src: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(src);
  let dst = path.join(destDir, base);
  if (fs.existsSync(dst)) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let n = 1;
    while (fs.existsSync(dst)) {
      dst = path.join(destDir, `${stem}__${n}${ext}`);
      n += 1;
    }
  }
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
  return dst;
}

export interface ArchiveResult {
  archived: number;
  rerouted: number; // moved to needs-review because the archive move failed
  failed: string[]; // couldn't move anywhere — the operator must clear these by hand
}

// Archive a list of original /incoming paths to destDir AFTER the item committed. On a move
// failure, route the file to needsReviewDir so it can't silently re-ingest; never throws.
// Missing paths (already moved/resumed) are skipped quietly.
export function archiveOriginals(
  paths: string[],
  destDir: string,
  needsReviewDir: string,
): ArchiveResult {
  let archived = 0;
  let rerouted = 0;
  const failed: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      if (!fs.existsSync(p)) continue;
    } catch {
      continue;
    }
    try {
      moveInto(p, destDir);
      archived += 1;
    } catch {
      try {
        moveInto(p, needsReviewDir);
        rerouted += 1;
      } catch {
        failed.push(p);
      }
    }
  }
  return { archived, rerouted, failed };
}
