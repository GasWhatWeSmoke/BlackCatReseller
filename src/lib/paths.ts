import path from "node:path";
import fs from "node:fs";
import type { AppSettingsData } from "./types";

/**
 * Return true if `target` resolves to a location inside one of the managed
 * media roots. Guards the photo/thumb serving routes against path traversal.
 */
export function isUnderManagedRoots(target: string, settings: AppSettingsData): boolean {
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  const roots = [
    settings.processingPath,
    settings.readyPath,
    settings.archivePath,
    settings.needsReviewPath,
    settings.incomingPath,
    settings.exportsPath,
  ].filter((root): root is string => typeof root === "string" && path.isAbsolute(root)).map((root) => path.resolve(root));

  const resolved = path.resolve(target);
  // Reject unrelated paths before any filesystem lookup (including remote paths).
  if (!roots.some(root => within(root, resolved))) return false;
  const realTarget = realLocation(resolved);
  if (!realTarget) return false;
  return roots.some((root) => {
    const realRoot = realLocation(root);
    return !!realRoot && within(root, resolved) && within(realRoot, realTarget);
  });
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolve existing ancestors too: a missing thumbnail is allowed to fall back
 * to its full image, but a linked ancestor must not escape the managed root. */
function realLocation(target: string): string | null {
  let ancestor = target;
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      return path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // A dangling symlink is not a missing ordinary path component.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) return null; } catch { /* Try the parent. */ }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }
}

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}
