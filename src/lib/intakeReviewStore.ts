import fs from "node:fs";
import path from "node:path";
import { intakeJobDir, readIntakeJob } from "./intakeJobStore.ts";
import type { IntakeCorrections, IntakeManifest, IntakeVerification } from "./intakeReview.ts";

export function readReviewJson<T>(directory: string, name: string): T | null {
  const filename = path.join(directory, name);
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw Error("Invalid batch review file.");
    return JSON.parse(fs.readFileSync(filename, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function readIntakeReview(settings: { dataRoot: string }, id: string) {
  const job = readIntakeJob(settings, id);
  if (!job) throw Error("Batch not found in this workspace.");
  const directory = intakeJobDir(settings, id);
  const realRoot = fs.realpathSync(path.join(settings.dataRoot, "intake-jobs"));
  if (path.dirname(fs.realpathSync(directory)) !== realRoot) throw Error("Batch is outside this workspace.");
  const manifest = readReviewJson<IntakeManifest>(directory, "manifest.json");
  const verification = readReviewJson<IntakeVerification>(directory, "verification.json");
  const corrections = readReviewJson<IntakeCorrections>(directory, "corrections.json");
  const result = readReviewJson<{ problems?: { type?: string; message?: string; filename?: string }[] }>(directory, "result.json");
  return { job, directory, manifest, verification, corrections, problems: result?.problems ?? [] };
}

/** Serve only an image named by this job's immutable source manifest. */
export function intakeReviewPhoto(settings: { dataRoot: string }, id: string, photoId: string): string {
  const { directory, manifest } = readIntakeReview(settings, id);
  const photo = manifest?.photos.find(entry => entry.id === photoId);
  if (!photo) throw Error("Photo not found in this batch.");
  const realSources = fs.realpathSync(path.join(directory, "sources"));
  const filename = fs.realpathSync(photo.storedPath);
  if (path.dirname(filename) !== realSources || !fs.statSync(filename).isFile()) throw Error("Photo is outside this batch.");
  return filename;
}
