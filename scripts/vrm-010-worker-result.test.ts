import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  validateWorkerEnrichment,
  validateWorkerResult,
} from "../src/lib/workerResultValidation.ts";
import type { ItemEnrichment, WorkerResult } from "../src/lib/types.ts";

const tempPrefix = path.join(os.tmpdir(), "bca-vrm010-worker-result-");
const root = fs.mkdtempSync(tempPrefix);
const incomingPath = path.join(root, "incoming");
const processingPath = path.join(root, "processing");
const needsReviewPath = path.join(root, "needs-review");
for (const directory of [incomingPath, processingPath, needsReviewPath]) {
  fs.mkdirSync(directory, { recursive: true });
}

after(() => {
  // The only recursive removal is the exact directory returned by mkdtempSync.
  assert.ok(root.startsWith(tempPrefix));
  fs.rmSync(root, { recursive: true, force: true });
});

const settings = { incomingPath, processingPath, needsReviewPath };
const batchId = "20260810-195500";
const fixtureSha256 = crypto.createHash("sha256").update("fixture").digest("hex");

function writeFixtureFile(filename: string, contents = "fixture"): string {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
  return filename;
}

function validResult(): WorkerResult {
  const sku = "BCA-0001";
  const originalPath = writeFixtureFile(path.join(incomingPath, `${sku}.jpg`));
  const itemFolder = path.join(processingPath, sku);
  const storedPath = writeFixtureFile(path.join(itemFolder, `${sku}_01.jpg`));
  const thumbPath = writeFixtureFile(path.join(itemFolder, "thumbs", `${sku}_01.jpg`));
  return {
    batchId,
    items: [{
      sku,
      originalQrValue: sku,
      processingFolderPath: itemFolder,
      photos: [{
        originalFilename: path.basename(originalPath),
        storedPath,
        thumbPath,
        sha256: fixtureSha256,
        sortOrder: 0,
        isCover: true,
        isMarker: false,
        includeInListing: true,
        rotation: 0,
        decodedValue: null,
        decodeMethod: null,
        width: 1_200,
        height: 1_600,
        exifDateTimeOriginal: "2026:08:10 19:55:00",
        exifSubSec: "01",
      }],
      enrichment: {
        fields: { itemType: "Jacket", color: "Black" },
        aiFields: ["itemType", "color"],
        raw: { itemType: "Jacket", confidence: 0.95, details: ["zip"] },
      },
      grouping: {
        confidence: "high",
        reasons: [],
        closedBy: "qr-marker",
        orderSource: "exif",
        log: [{
          file: path.basename(originalPath),
          role: "photo",
          time: "2026:08:10 19:55:00",
          gapBeforeSec: null,
          decode: null,
          raw: null,
        }],
      },
      placeholder: false,
      originalPaths: [originalPath],
    }],
    collisions: [],
    duplicates: [],
    needsReview: [],
    problems: [],
    counts: {
      itemsCreated: 1,
      photosProcessed: 1,
      duplicatesSkipped: 0,
      problems: 0,
      collisions: 0,
    },
    durationMs: 250,
  };
}

function expectInvalid(result: unknown): void {
  assert.throws(
    () => validateWorkerResult(result, settings),
    (error: unknown) => error instanceof Error && error.message === "Invalid worker result",
  );
}

function relocateItem(item: WorkerResult["items"][number], folderName: string): void {
  const folder = path.join(processingPath, folderName);
  item.processingFolderPath = folder;
  item.photos[0].storedPath = writeFixtureFile(path.join(folder, "photo.jpg"));
  item.photos[0].thumbPath = writeFixtureFile(path.join(folder, "thumbs", "photo.jpg"));
}

test("accepts freshly reserved item and collision folders bound to the current SKU and batch", () => {
  const input = validResult();
  const item = input.items[0];
  relocateItem(item, `${item.sku}__intake-${batchId}-${"a".repeat(32)}`);
  assert.deepEqual(validateWorkerResult(input, settings), input);
  input.items = [];
  input.collisions = [item];
  input.counts.itemsCreated = 0;
  input.counts.collisions = 1;
  relocateItem(item, `${item.sku}__incoming-${batchId}-${"b".repeat(32)}`);
  assert.deepEqual(validateWorkerResult(input, settings), input);
});

test("reserved folder names cannot substitute a different SKU, batch, role or malformed token", () => {
  for (const name of [
    `OTHER__intake-${batchId}-${"a".repeat(32)}`,
    `BCA-0001__intake-20260919-000000-${"a".repeat(32)}`,
    `BCA-0001__incoming-${batchId}-${"a".repeat(32)}`,
    `BCA-0001__intake-${batchId}-short`,
    `BCA-0001__intake-${batchId}-${"z".repeat(32)}`,
    path.join("nested", `BCA-0001__intake-${batchId}-${"a".repeat(32)}`),
  ]) {
    const input = validResult();
    relocateItem(input.items[0], name);
    expectInvalid(input);
  }
});

test("fresh collision directories retain the exact collision ordinal", () => {
  const input = validResult();
  const item = input.items.pop()!;
  input.collisions = [item];
  input.counts.itemsCreated = 0;
  input.counts.collisions = 1;
  relocateItem(item, `${item.sku}__incoming-${batchId}__2-${"a".repeat(32)}`);
  expectInvalid(input);
});

test("accepts and reconstructs a complete result without runtime dependencies", () => {
  const input = validResult();
  const validated = validateWorkerResult(input, settings);
  assert.deepEqual(validated, input);
  assert.notStrictEqual(validated, input);
  assert.notStrictEqual(validated.items[0], input.items[0]);
});

test("accepts the explicit bounded force-no-AI audit fields", () => {
  const input = validResult();
  input.items[0].enrichment = {
    error: "AI intentionally skipped by force mode",
    skipped: true,
    intentional: true,
  } as ItemEnrichment;
  const validated = validateWorkerResult(input, settings) as typeof input;
  assert.equal((validated.items[0].enrichment as { skipped?: boolean }).skipped, true);
});

test("exports the same strict enrichment boundary for retry workers", () => {
  assert.deepEqual(
    validateWorkerEnrichment({ fields: { brand: "Black Cat" }, aiFields: ["brand"] }),
    { fields: { brand: "Black Cat" }, aiFields: ["brand"] },
  );
  assert.throws(
    () => validateWorkerEnrichment({ fields: { brand: "Black Cat" }, command: "write" }),
    { message: "Invalid worker result" },
  );
});

test("rejects extra fields, accessors, and non-plain records", () => {
  const extra = validResult() as ReturnType<typeof validResult> & { command?: string };
  extra.command = "persist-anyway";
  expectInvalid(extra);

  const accessor = validResult();
  Object.defineProperty(accessor, "durationMs", { enumerable: true, get: () => 250 });
  expectInvalid(accessor);

  const nonPlain = validResult();
  nonPlain.counts = new (class Counts {
    itemsCreated = 1;
    photosProcessed = 1;
    duplicatesSkipped = 0;
    problems = 0;
    collisions = 0;
  })();
  expectInvalid(nonPlain);
});

test("rejects unsafe batch IDs and bounded scalar violations", () => {
  const traversal = validResult();
  traversal.batchId = "../escape";
  expectInvalid(traversal);

  const metadata = validResult();
  metadata.items[0].photos[0].width = Number.MAX_SAFE_INTEGER;
  expectInvalid(metadata);

  const raw = validResult();
  raw.items[0].enrichment.raw = { description: "x".repeat(65_537) };
  expectInvalid(raw);

  const attackerQr = validResult();
  attackerQr.items[0].photos[0].decodedValue = "00\t0001\n";
  attackerQr.items[0].grouping!.log[0].raw = "00\t0001\n";
  expectInvalid(attackerQr);

  const attackerExif = validResult();
  attackerExif.items[0].photos[0].exifDateTimeOriginal = "x".repeat(129);
  expectInvalid(attackerExif);

  const oversizedProblem = validResult();
  oversizedProblem.problems.push({
    type: "OCR_SKU_OUTLIER",
    message: "9".repeat(4_097),
  } as never);
  oversizedProblem.counts.problems = 1;
  expectInvalid(oversizedProblem);
});

test("rejects aggregate enrichment data above the bounded IPC budget", () => {
  const input = validResult();
  const template = structuredClone(input.items[0]);
  input.items = [];
  for (let index = 1; index <= 129; index += 1) {
    const item = structuredClone(template);
    const sku = `BCA-${String(index).padStart(4, "0")}`;
    const originalFilename = `${sku}.jpg`;
    const originalPath = writeFixtureFile(path.join(incomingPath, originalFilename));
    const itemFolder = path.join(processingPath, sku);
    item.sku = sku;
    item.originalQrValue = sku;
    item.processingFolderPath = itemFolder;
    item.photos[0].originalFilename = originalFilename;
    item.photos[0].storedPath = writeFixtureFile(path.join(itemFolder, `${sku}_01.jpg`));
    item.photos[0].thumbPath = writeFixtureFile(
      path.join(itemFolder, "thumbs", `${sku}_01.jpg`),
    );
    item.originalPaths = [originalPath];
    item.grouping!.log[0].file = originalFilename;
    item.enrichment = { raw: { payload: "x".repeat(65_520) } };
    input.items.push(item);
  }
  input.counts.itemsCreated = input.items.length;
  input.counts.photosProcessed = input.items.length;
  expectInvalid(input);
});

test("rejects lexical escapes, missing files, and duplicate paths", () => {
  const outside = writeFixtureFile(path.join(root, "outside.jpg"));
  const escaped = validResult();
  escaped.items[0].originalPaths[0] = outside;
  expectInvalid(escaped);

  const missing = validResult();
  missing.items[0].photos[0].storedPath = path.join(
    missing.items[0].processingFolderPath,
    "missing.jpg",
  );
  expectInvalid(missing);

  const duplicatePath = validResult();
  duplicatePath.items[0].photos[0].thumbPath = duplicatePath.items[0].photos[0].storedPath;
  expectInvalid(duplicatePath);
});

test("binds the reported digest to both the incoming original and stored copy", () => {
  const forgedDigest = validResult();
  forgedDigest.items[0].photos[0].sha256 = "f".repeat(64);
  expectInvalid(forgedDigest);

  const staleStoredCopy = validResult();
  fs.writeFileSync(staleStoredCopy.items[0].photos[0].storedPath, "different bytes");
  expectInvalid(staleStoredCopy);

  const staleOriginal = validResult();
  fs.writeFileSync(staleOriginal.items[0].originalPaths[0], "different original");
  expectInvalid(staleOriginal);
});

test("rejects a symlink or junction that resolves outside the authorized root", (context) => {
  const input = validResult();
  const outsideDirectory = path.join(root, "outside-directory");
  fs.mkdirSync(outsideDirectory, { recursive: true });
  writeFixtureFile(path.join(outsideDirectory, "escaped.jpg"));
  const link = path.join(input.items[0].processingFolderPath, "escape-link");
  try {
    fs.symlinkSync(outsideDirectory, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.skip(`symlink creation unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
    return;
  }
  input.items[0].photos[0].storedPath = path.join(link, "escaped.jpg");
  expectInvalid(input);
});

test("rejects duplicate normal items and processing folders", () => {
  const input = validResult();
  input.items.push(structuredClone(input.items[0]));
  input.counts.itemsCreated = 2;
  input.counts.photosProcessed = 2;
  expectInvalid(input);
});

test("accepts repeated-SKU collisions only in canonical ordinal folders", () => {
  const input = validResult();
  const makeCollision = (ordinal: number) => {
    const collision = structuredClone(input.items[0]);
    const suffix = ordinal === 1 ? "" : `__${ordinal}`;
    const originalFilename = `collision-${ordinal}.jpg`;
    const originalPath = writeFixtureFile(path.join(incomingPath, originalFilename));
    const folder = path.join(
      processingPath,
      `${collision.sku}__incoming-${batchId}${suffix}`,
    );
    collision.processingFolderPath = folder;
    collision.photos[0].originalFilename = originalFilename;
    collision.photos[0].storedPath = writeFixtureFile(path.join(folder, `${ordinal}.jpg`));
    collision.photos[0].thumbPath = writeFixtureFile(path.join(folder, "thumbs", `${ordinal}.jpg`));
    collision.originalPaths = [originalPath];
    collision.grouping!.log[0].file = originalFilename;
    return collision;
  };
  input.collisions = [makeCollision(1), makeCollision(2)];
  input.counts.collisions = 2;
  input.counts.photosProcessed = 3;
  const validated = validateWorkerResult(input, settings);
  assert.equal(validated.collisions.length, 2);

  const forgedOrdinal = structuredClone(input);
  forgedOrdinal.collisions[1].processingFolderPath = path.join(
    processingPath,
    `${forgedOrdinal.collisions[1].sku}__incoming-${batchId}__3`,
  );
  fs.mkdirSync(forgedOrdinal.collisions[1].processingFolderPath, { recursive: true });
  expectInvalid(forgedOrdinal);
});

test("reconciles a skipped in-batch duplicate retained in the grouping audit log", () => {
  const input = validResult();
  input.items[0].grouping!.closedBy = "recovered-sticker" as never;
  input.items[0].grouping!.log.push({
    file: "duplicate.jpg",
    role: "photo",
    time: null,
    gapBeforeSec: 0.1,
    decode: null,
    raw: null,
  });
  input.duplicates.push({ originalFilename: "duplicate.jpg", sha256: fixtureSha256 });
  input.counts.duplicatesSkipped = 1;
  input.counts.photosProcessed = 2;
  const validated = validateWorkerResult(input, settings);
  assert.equal(validated.duplicates.length, 1);
  assert.equal(validated.items[0].grouping!.log.length, 2);
});

test("rejects count drift before persistence", () => {
  const input = validResult();
  input.counts.photosProcessed = 2;
  expectInvalid(input);

  const problemDrift = validResult();
  problemDrift.problems.push({ type: "UNREADABLE_FILE", message: "failed" } as never);
  expectInvalid(problemDrift);
});

test("accepts an existing needs-review file and a missing authorized problem path", () => {
  const input = validResult();
  const reviewPath = writeFixtureFile(path.join(needsReviewPath, "unreadable.jpg"));
  input.needsReview.push({
    originalFilename: "unreadable.jpg",
    storedPath: reviewPath,
    reason: "unterminated_group",
  } as never);
  input.problems.push({
    type: "UNSUPPORTED_FORMAT",
    photoPath: path.join(incomingPath, "already-moved.txt"),
    message: "routed to needs review",
  } as never);
  input.counts.problems = 1;
  const validated = validateWorkerResult(input, settings);
  assert.equal(validated.needsReview.length, 1);
  assert.equal(validated.problems.length, 1);
});

test("accepts the complete empty/no-ready result", () => {
  const empty = {
    batchId,
    items: [],
    collisions: [],
    duplicates: [],
    needsReview: [],
    problems: [],
    counts: {
      itemsCreated: 0,
      photosProcessed: 0,
      duplicatesSkipped: 0,
      problems: 0,
      collisions: 0,
    },
    durationMs: 1,
  };
  assert.deepEqual(validateWorkerResult(empty, settings), empty);
});

test("canonicalizes legacy mixed Windows separators after containment checks", (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows path compatibility regression");
    return;
  }
  const input = validResult();
  const mixed = (value: string) => value.replaceAll("\\", "/");
  input.items[0].processingFolderPath = mixed(input.items[0].processingFolderPath);
  input.items[0].photos[0].storedPath = mixed(input.items[0].photos[0].storedPath);
  input.items[0].photos[0].thumbPath = mixed(input.items[0].photos[0].thumbPath!);
  input.items[0].originalPaths[0] = mixed(input.items[0].originalPaths[0]);
  const validated = validateWorkerResult(input, {
    incomingPath: mixed(incomingPath),
    processingPath: mixed(processingPath),
    needsReviewPath: mixed(needsReviewPath),
  });
  assert.equal(validated.items[0].photos[0].storedPath, path.normalize(
    input.items[0].photos[0].storedPath,
  ));
});
