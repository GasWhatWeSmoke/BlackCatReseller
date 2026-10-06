import fs from "node:fs";
import path from "node:path";

export const MANAGED_WORK_ROOT_KEYS = [
  "incomingPath",
  "processingPath",
  "needsReviewPath",
  "archivePath",
] as const;

export type ManagedWorkRootKey = typeof MANAGED_WORK_ROOT_KEYS[number];
export type ManagedWorkRoots = Record<ManagedWorkRootKey, string>;

export class InvalidManagedWorkRootsError extends Error {
  readonly code = "INVALID_WORK_ROOTS";

  constructor(message: string) {
    super(message);
    this.name = "InvalidManagedWorkRootsError";
  }
}

function comparable(candidate: string): string {
  const normalized = path.normalize(candidate);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(comparable(left), comparable(right));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * Validate the four mutable workset roots before settings persistence or intake.
 * Both spellings and resolved targets must be pairwise disjoint: a junction or
 * symlink may not disguise equality/nesting between source and destination roots.
 */
export function validateManagedWorkRoots(settings: ManagedWorkRoots): void {
  const roots = MANAGED_WORK_ROOT_KEYS.map((key) => {
    const value = settings[key];
    if (typeof value !== "string" || !value || value.length > 4096
        || value !== value.trim() || !path.isAbsolute(value)) {
      throw new InvalidManagedWorkRootsError(`${key} must be an absolute path without surrounding whitespace`);
    }
    const lexical = path.resolve(value);
    let nearestExisting = lexical;
    while (!fs.existsSync(nearestExisting)) {
      const parent = path.dirname(nearestExisting);
      if (parent === nearestExisting) {
        throw new InvalidManagedWorkRootsError(`${key} has no usable existing ancestor`);
      }
      nearestExisting = parent;
    }
    let existingInfo: fs.Stats;
    let existingReal: string;
    try {
      existingInfo = fs.lstatSync(nearestExisting);
      existingReal = path.resolve(fs.realpathSync.native(nearestExisting));
    } catch {
      throw new InvalidManagedWorkRootsError(`${key} has no usable existing ancestor`);
    }
    if (!existingInfo.isDirectory()) {
      throw new InvalidManagedWorkRootsError(`${key} must be a directory or safely creatable path`);
    }
    const missingLeaf = nearestExisting !== lexical;
    if (missingLeaf && comparable(existingReal) !== comparable(path.resolve(nearestExisting))) {
      throw new InvalidManagedWorkRootsError(`${key} has a linked or reparse-point ancestor`);
    }
    const suffix = path.relative(nearestExisting, lexical);
    const real = missingLeaf ? path.resolve(existingReal, suffix) : existingReal;
    return { key, lexical, real };
  });

  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex];
      const right = roots[rightIndex];
      if (overlaps(left.lexical, right.lexical) || overlaps(right.lexical, left.lexical)
          || overlaps(left.real, right.real) || overlaps(right.real, left.real)) {
        throw new InvalidManagedWorkRootsError(
          `${left.key} and ${right.key} must be separate, non-nested directories`,
        );
      }
    }
  }
}
