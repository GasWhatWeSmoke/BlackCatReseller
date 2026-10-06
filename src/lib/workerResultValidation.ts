import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import type {
  AppSettingsData,
  ItemEnrichment,
  ItemGrouping,
  WorkerItem,
  WorkerPhoto,
  WorkerProblem,
  WorkerResult,
} from "./types";

/**
 * The worker is a separate process, so its final JSON line is an untrusted IPC
 * payload even though it normally comes from our own Python code.  Keep this
 * validator dependency-free and synchronous so callers can run it immediately
 * before the first database or archive mutation.
 */

export type WorkerResultValidationSettings = Pick<
  AppSettingsData,
  "incomingPath" | "processingPath" | "needsReviewPath"
>;

const INVALID_RESULT_MESSAGE = "Invalid worker result";

const MAX_BATCH_ID = 64;
const MAX_PATH = 32_768;
const MAX_FILENAME = 255;
const MAX_SKU = 128;
const MAX_ITEMS = 1_000;
const MAX_PHOTOS_PER_ITEM = 32;
const MAX_GROUP_LOG_ENTRIES = 32;
const MAX_TOTAL_PHOTOS = 1_000;
const MAX_DUPLICATES = 1_000;
const MAX_NEEDS_REVIEW = 1_000;
const MAX_PROBLEMS = 50_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RAW_DEPTH = 8;
const MAX_RAW_NODES = 4_096;
const MAX_RAW_CHARS = 65_536;
export const MAX_ENRICHMENT_BATCH_JSON_BYTES = 8 * 1_024 * 1_024;
const MAX_PHOTO_BYTES = 256 * 1_024 * 1_024;
// Each source is hashed once in incoming and once in its processing copy.
const MAX_TOTAL_HASHED_BYTES = 32 * 1_024 * 1_024 * 1_024;

const ITEM_FIELD_NAMES = [
  "size",
  "color",
  "pattern",
  "itemType",
  "category",
  "brand",
] as const;
const ITEM_FIELD_SET = new Set<string>(ITEM_FIELD_NAMES);

function invalid(): never {
  throw new Error(INVALID_RESULT_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject accessors, symbols, non-enumerable data, inherited data, and extra keys. */
function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainObject(value)) invalid();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) invalid();
  const stringKeys = keys as string[];
  if (stringKeys.length < required.length) invalid();
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  }
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value;
}

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  if (!Number.isSafeInteger(value.length) || value.length > maximum) invalid();
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid();
  }
  return value;
}

function boundedString(
  value: unknown,
  maximum: number,
  { nonEmpty = false, controls = false }: { nonEmpty?: boolean; controls?: boolean } = {},
): string {
  if (typeof value !== "string" || value.length > maximum) invalid();
  if (nonEmpty && value.length === 0) invalid();
  if (!controls && /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function nullableString(value: unknown, maximum: number): string | null {
  return value === null ? null : boundedString(value, maximum);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid();
  }
  return value as number;
}

function boundedFiniteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid();
  }
  return value;
}

function safeFilename(value: unknown): string {
  const filename = boundedString(value, MAX_FILENAME, { nonEmpty: true });
  if (filename === "." || filename === ".." || /[\\/]/.test(filename)) invalid();
  return filename;
}

function safeSku(value: unknown): string {
  const sku = boundedString(value, MAX_SKU, { nonEmpty: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sku) || sku.includes("..")) invalid();
  return sku;
}

function safeBatchId(value: unknown): string {
  const batchId = boundedString(value, MAX_BATCH_ID, { nonEmpty: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batchId) || batchId.includes("..")) invalid();
  return batchId;
}

type ValidatedRoot = { lexical: string; real: string };
type ValidatedPath = { value: string; lexical: string; real: string };

function comparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validatedRoot(value: unknown): ValidatedRoot {
  const configured = boundedString(value, MAX_PATH, { nonEmpty: true });
  if (!path.isAbsolute(configured)) invalid();
  const lexical = path.resolve(configured);
  const stat = fs.statSync(configured);
  if (!stat.isDirectory()) invalid();
  const real = path.resolve(fs.realpathSync.native(configured));
  return { lexical, real };
}

function rootsAreDisjoint(roots: readonly ValidatedRoot[]): boolean {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      for (const field of ["lexical", "real"] as const) {
        const a = roots[left][field];
        const b = roots[right][field];
        if (comparisonKey(a) === comparisonKey(b) ||
            isStrictDescendant(a, b) || isStrictDescendant(b, a)) return false;
      }
    }
  }
  return true;
}

function existingPathUnder(
  value: unknown,
  root: ValidatedRoot,
  expected: "file" | "directory",
): ValidatedPath {
  const input = boundedString(value, MAX_PATH, { nonEmpty: true });
  if (!path.isAbsolute(input)) invalid();
  const lexical = path.resolve(input);
  if (!isStrictDescendant(root.lexical, lexical)) invalid();
  const real = path.resolve(fs.realpathSync.native(input));
  if (!isStrictDescendant(root.real, real)) invalid();
  const stat = fs.statSync(input);
  if ((expected === "file" && !stat.isFile()) ||
      (expected === "directory" && !stat.isDirectory())) invalid();
  // Reconstruct with the platform-canonical lexical spelling.  Python may emit
  // mixed separators when an older Windows setting used `/`; containment and
  // realpath checks provide the security boundary, not separator style.
  return { value: lexical, lexical, real };
}

function lexicalProblemPath(value: unknown, roots: readonly ValidatedRoot[]): string {
  const input = boundedString(value, MAX_PATH, { nonEmpty: true });
  if (!path.isAbsolute(input)) invalid();
  const lexical = path.resolve(input);
  if (!roots.some((root) => isStrictDescendant(root.lexical, lexical))) invalid();
  if (fs.existsSync(lexical)) {
    const real = path.resolve(fs.realpathSync.native(lexical));
    if (!roots.some((root) => isStrictDescendant(root.real, real))) invalid();
  }
  return lexical;
}

function addUnique(set: Set<string>, value: string): void {
  const key = comparisonKey(value);
  if (set.has(key)) invalid();
  set.add(key);
}

function stableSha256(
  file: ValidatedPath,
  state: { totalHashedBytes: number },
): string {
  // Hash through an open descriptor and compare identity/timestamps around the
  // read.  This detects ordinary replacement/truncation races during validation;
  // callers must still persist immediately because no synchronous validator can
  // reserve pathnames after it returns.
  const descriptor = fs.openSync(file.value, "r");
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_PHOTO_BYTES)) invalid();
    state.totalHashedBytes += Number(before.size);
    if (state.totalHashedBytes > MAX_TOTAL_HASHED_BYTES) invalid();

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1_024 * 1_024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);

    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) invalid();
    const currentReal = path.resolve(fs.realpathSync.native(file.value));
    if (comparisonKey(currentReal) !== comparisonKey(file.real)) invalid();
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateJsonValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;

  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_RAW_NODES || depth > MAX_RAW_DEPTH) invalid();
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      // Raw model JSON may legitimately contain escaped tabs/newlines (for
      // example a multi-line description). Keep those while rejecting NUL and
      // the remaining control range.
      const stringValue = boundedString(candidate, MAX_RAW_CHARS, { controls: true });
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(stringValue)) invalid();
      chars += stringValue.length;
      if (chars > MAX_RAW_CHARS) invalid();
      return stringValue;
    }
    if (typeof candidate === "number") {
      return boundedFiniteNumber(candidate, -1_000_000_000_000, 1_000_000_000_000);
    }
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) invalid();
      seen.add(candidate);
      const values = boundedArray(candidate, 512);
      return values.map((entry) => visit(entry, depth + 1));
    }
    if (!isPlainObject(candidate)) invalid();
    if (seen.has(candidate)) invalid();
    seen.add(candidate);
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > 128) invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" ||
          key === "__proto__" || key === "prototype" || key === "constructor") invalid();
      const safeKey = boundedString(key, 128, { nonEmpty: true });
      chars += safeKey.length;
      if (chars > MAX_RAW_CHARS) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      result[safeKey] = visit(descriptor.value, depth + 1);
    }
    return result;
  };

  return visit(value, 0);
}

function validateEnrichmentInner(value: unknown): ItemEnrichment {
  // `skipped`/`intentional` are bounded force-mode audit flags.  Persistence
  // ignores them, but accepting only booleans keeps the full IPC object exact.
  const object = exactObject(
    value,
    [],
    ["fields", "aiFields", "raw", "error", "skipped", "intentional"],
  );
  const result: ItemEnrichment & { skipped?: boolean; intentional?: boolean } = {};

  if ("fields" in object) {
    const fieldsObject = exactObject(object.fields, [], ITEM_FIELD_NAMES);
    const fields: NonNullable<ItemEnrichment["fields"]> = {};
    for (const [key, fieldValue] of Object.entries(fieldsObject)) {
      if (!ITEM_FIELD_SET.has(key)) invalid();
      fields[key as keyof typeof fields] = boundedString(fieldValue, 512, { nonEmpty: true });
    }
    result.fields = fields;
  }
  if ("aiFields" in object) {
    const fields = boundedArray(object.aiFields, ITEM_FIELD_NAMES.length)
      .map((entry) => boundedString(entry, 32, { nonEmpty: true }));
    if (new Set(fields).size !== fields.length) invalid();
    for (const field of fields) {
      if (!ITEM_FIELD_SET.has(field) || !result.fields || !(field in result.fields)) invalid();
    }
    result.aiFields = fields;
  }
  if ("raw" in object) result.raw = validateJsonValue(object.raw);
  if ("error" in object) result.error = boundedString(object.error, 2_048, { nonEmpty: true });
  if ("skipped" in object) result.skipped = booleanValue(object.skipped);
  if ("intentional" in object) result.intentional = booleanValue(object.intentional);
  if ((result.skipped !== undefined && result.skipped !== true) ||
      (result.intentional !== undefined && result.intentional !== true) ||
      (result.intentional === true && result.skipped !== true) ||
      (result.skipped === true &&
       (!result.error || result.fields !== undefined || result.raw !== undefined))) {
    invalid();
  }
  return result;
}

/** Validate a single re-enrichment payload with the same fail-closed contract. */
export function validateWorkerEnrichment(value: unknown): ItemEnrichment {
  try {
    return validateEnrichmentInner(value);
  } catch {
    invalid();
  }
}

function validateGrouping(
  value: unknown,
  photoFilenames: readonly string[],
  state: ValidationState,
): ItemGrouping {
  const object = exactObject(value, ["confidence", "reasons", "closedBy", "orderSource", "log"]);
  const confidence = boundedString(object.confidence, 16, { nonEmpty: true });
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") invalid();
  const reasons = boundedArray(object.reasons, 32)
    .map((entry) => boundedString(entry, 1_024, { nonEmpty: true }));
  if (new Set(reasons).size !== reasons.length) invalid();
  const closedBy = boundedString(object.closedBy, 32, { nonEmpty: true });
  if (![
    "qr-marker", "ocr-marker", "unreadable-sticker", "recovered-sticker", "end-of-batch",
  ].includes(closedBy)) invalid();
  const orderSource = boundedString(object.orderSource, 32, { nonEmpty: true });
  if (!["exif", "filename", "filename-mixed"].includes(orderSource)) invalid();
  const logValues = boundedArray(object.log, MAX_GROUP_LOG_ENTRIES);
  const log = logValues.map((entry) => {
    const row = exactObject(entry, ["file", "role", "time", "gapBeforeSec", "decode", "raw"]);
    return {
      file: safeFilename(row.file),
      role: boundedString(row.role, 128, { nonEmpty: true }),
      time: nullableString(row.time, 128),
      gapBeforeSec: row.gapBeforeSec === null
        ? null : boundedFiniteNumber(row.gapBeforeSec, -1_000_000_000, 1_000_000_000),
      decode: nullableString(row.decode, 128),
      raw: nullableString(row.raw, 4_096),
    };
  });
  const remainingPhotos = new Map<string, number>();
  for (const filename of photoFilenames) {
    const key = comparisonKey(filename);
    remainingPhotos.set(key, (remainingPhotos.get(key) ?? 0) + 1);
  }
  for (const row of log) {
    const key = comparisonKey(row.file);
    const photoCount = remainingPhotos.get(key) ?? 0;
    if (photoCount > 0) {
      remainingPhotos.set(key, photoCount - 1);
      continue;
    }
    const duplicateCount = state.duplicateNames.get(key) ?? 0;
    if (duplicateCount <= 0) invalid();
    state.duplicateNames.set(key, duplicateCount - 1);
  }
  if ([...remainingPhotos.values()].some((count) => count !== 0)) invalid();
  return {
    confidence: confidence as ItemGrouping["confidence"],
    reasons,
    closedBy: closedBy as ItemGrouping["closedBy"],
    orderSource: orderSource as ItemGrouping["orderSource"],
    log,
  };
}

function validatePhoto(
  value: unknown,
  processingRoot: ValidatedRoot,
  itemFolder: ValidatedPath,
  filesystemPaths: Set<string>,
): { photo: WorkerPhoto; stored: ValidatedPath } {
  const object = exactObject(value, [
    "originalFilename", "storedPath", "thumbPath", "sha256", "sortOrder",
    "isCover", "isMarker", "includeInListing", "rotation", "decodedValue",
    "decodeMethod", "width", "height", "exifDateTimeOriginal", "exifSubSec",
  ]);
  const stored = existingPathUnder(object.storedPath, processingRoot, "file");
  if (!isStrictDescendant(itemFolder.lexical, stored.lexical) ||
      !isStrictDescendant(itemFolder.real, stored.real)) invalid();
  addUnique(filesystemPaths, stored.real);

  let thumbPath: string | null = null;
  if (object.thumbPath !== null) {
    const thumb = existingPathUnder(object.thumbPath, processingRoot, "file");
    if (!isStrictDescendant(itemFolder.lexical, thumb.lexical) ||
        !isStrictDescendant(itemFolder.real, thumb.real)) invalid();
    addUnique(filesystemPaths, thumb.real);
    thumbPath = thumb.value;
  }
  const sha256 = boundedString(object.sha256, 64, { nonEmpty: true });
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) invalid();
  const width = object.width === null ? null : boundedInteger(object.width, 1, 100_000);
  const height = object.height === null ? null : boundedInteger(object.height, 1, 100_000);
  const photo: WorkerPhoto = {
    originalFilename: safeFilename(object.originalFilename),
    storedPath: stored.value,
    thumbPath,
    sha256,
    sortOrder: boundedInteger(object.sortOrder, 0, MAX_PHOTOS_PER_ITEM - 1),
    isCover: booleanValue(object.isCover),
    isMarker: booleanValue(object.isMarker),
    includeInListing: booleanValue(object.includeInListing),
    rotation: boundedInteger(object.rotation, -360, 360),
    decodedValue: nullableString(object.decodedValue, 4_096),
    decodeMethod: nullableString(object.decodeMethod, 128),
    width,
    height,
    exifDateTimeOriginal: nullableString(object.exifDateTimeOriginal, 128),
    exifSubSec: nullableString(object.exifSubSec, 128),
  };
  if ((photo.isMarker && photo.includeInListing) || (photo.isCover && !photo.includeInListing)) {
    invalid();
  }
  return { photo, stored };
}

type ValidationState = {
  incomingRoot: ValidatedRoot;
  processingRoot: ValidatedRoot;
  batchId: string;
  itemSkus: Set<string>;
  collisionOrdinals: Map<string, number>;
  processingFolders: Set<string>;
  filesystemPaths: Set<string>;
  originalFilenames: Set<string>;
  duplicateNames: Map<string, number>;
  totalPhotos: number;
  totalHashedBytes: number;
  enrichmentBytes: number;
};

function validateItem(value: unknown, collision: boolean, state: ValidationState): WorkerItem {
  const object = exactObject(
    value,
    [
      "sku", "originalQrValue", "processingFolderPath", "photos", "enrichment",
      "grouping", "placeholder", "originalPaths",
    ],
  );
  const sku = safeSku(object.sku);
  const skuKey = comparisonKey(sku);
  let collisionOrdinal = 0;
  if (collision) {
    collisionOrdinal = (state.collisionOrdinals.get(skuKey) ?? 0) + 1;
    state.collisionOrdinals.set(skuKey, collisionOrdinal);
  } else {
    addUnique(state.itemSkus, sku);
  }
  const folder = existingPathUnder(object.processingFolderPath, state.processingRoot, "directory");
  const collisionSuffix = collisionOrdinal <= 1 ? "" : `__${collisionOrdinal}`;
  const expectedFolderName = collision
    ? `${sku}__incoming-${state.batchId}${collisionSuffix}`
    : sku;
  const folderName = path.basename(folder.lexical);
  const reservedPrefix = collision
    ? `${expectedFolderName}-`
    : `${sku}__intake-${state.batchId}-`;
  const reserved = folderName.startsWith(reservedPrefix) &&
    /^[a-f0-9]{32}$/.test(folderName.slice(reservedPrefix.length));
  if (path.relative(state.processingRoot.lexical, path.dirname(folder.lexical)) !== "" ||
      (folderName !== expectedFolderName && !reserved)) invalid();
  addUnique(state.processingFolders, folder.real);

  const validatedPhotos = boundedArray(object.photos, MAX_PHOTOS_PER_ITEM)
    .map((photo) => validatePhoto(photo, state.processingRoot, folder, state.filesystemPaths));
  const photos = validatedPhotos.map((entry) => entry.photo);
  state.totalPhotos += photos.length;
  if (state.totalPhotos > MAX_TOTAL_PHOTOS) invalid();
  const sortOrders = new Set(photos.map((photo) => photo.sortOrder));
  if (sortOrders.size !== photos.length ||
      photos.some((photo) => photo.sortOrder >= photos.length)) invalid();
  const listingPhotos = photos.filter((photo) => photo.includeInListing);
  const covers = photos.filter((photo) => photo.isCover);
  if (covers.length > 1 || (listingPhotos.length > 0 && covers.length !== 1)) invalid();

  const validatedOriginals = boundedArray(object.originalPaths, MAX_PHOTOS_PER_ITEM).map((entry) => {
    const original = existingPathUnder(entry, state.incomingRoot, "file");
    addUnique(state.filesystemPaths, original.real);
    const filenameKey = comparisonKey(path.basename(original.lexical));
    addUnique(state.originalFilenames, filenameKey);
    return original;
  });
  const originalPaths = validatedOriginals.map((entry) => entry.value);
  if (originalPaths.length !== photos.length) invalid();
  const originalNames = originalPaths.map((entry) => path.basename(entry)).sort();
  const photoNames = photos.map((photo) => photo.originalFilename).sort();
  if (originalNames.some((entry, index) => entry !== photoNames[index])) invalid();

  const originalsByName = new Map(
    validatedOriginals.map((entry) => [comparisonKey(path.basename(entry.lexical)), entry]),
  );
  for (const entry of validatedPhotos) {
    const original = originalsByName.get(comparisonKey(entry.photo.originalFilename));
    if (!original) invalid();
    const reportedHash = entry.photo.sha256?.toLowerCase();
    if (!reportedHash || stableSha256(original, state) !== reportedHash ||
        stableSha256(entry.stored, state) !== reportedHash) invalid();
  }

  const enrichment = validateEnrichmentInner(object.enrichment);
  state.enrichmentBytes += Buffer.byteLength(JSON.stringify(enrichment), "utf-8");
  if (state.enrichmentBytes > MAX_ENRICHMENT_BATCH_JSON_BYTES) invalid();

  const item: WorkerItem = {
    sku,
    originalQrValue: nullableString(object.originalQrValue, 4_096),
    processingFolderPath: folder.value,
    photos,
    enrichment,
    grouping: validateGrouping(object.grouping, photoNames, state),
    placeholder: booleanValue(object.placeholder),
    originalPaths,
  };
  return item;
}

function validateProblem(
  value: unknown,
  authorizedRoots: readonly ValidatedRoot[],
): WorkerProblem {
  const object = exactObject(value, ["type"], ["sku", "photoPath", "message"]);
  const result: WorkerProblem = {
    type: boundedString(object.type, 128, { nonEmpty: true }),
  };
  if ("sku" in object) {
    result.sku = object.sku === null ? null : safeSku(object.sku);
  }
  if ("photoPath" in object) {
    result.photoPath = object.photoPath === null
      ? null : lexicalProblemPath(object.photoPath, authorizedRoots);
  }
  if ("message" in object) result.message = boundedString(object.message, 4_096);
  return result;
}

function validateWorkerResultInner(
  value: unknown,
  settings: WorkerResultValidationSettings,
): WorkerResult {
  const incomingRoot = validatedRoot(settings.incomingPath);
  const processingRoot = validatedRoot(settings.processingPath);
  const needsReviewRoot = validatedRoot(settings.needsReviewPath);
  const authorizedRoots = [incomingRoot, processingRoot, needsReviewRoot];
  if (!rootsAreDisjoint(authorizedRoots)) invalid();

  const object = exactObject(value, [
    "batchId", "items", "collisions", "duplicates", "needsReview", "problems",
    "counts", "durationMs",
  ]);
  const batchId = safeBatchId(object.batchId);
  const duplicateNames = new Map<string, number>();
  const duplicates = boundedArray(object.duplicates, MAX_DUPLICATES).map((entry) => {
    const duplicate = exactObject(entry, ["originalFilename", "sha256"]);
    const originalFilename = safeFilename(duplicate.originalFilename);
    const filenameKey = comparisonKey(originalFilename);
    if (duplicateNames.has(filenameKey)) invalid();
    duplicateNames.set(filenameKey, 1);
    const sha256 = boundedString(duplicate.sha256, 64, { nonEmpty: true });
    if (!/^[0-9a-fA-F]{64}$/.test(sha256)) invalid();
    return { originalFilename, sha256 };
  });
  const state: ValidationState = {
    incomingRoot,
    processingRoot,
    batchId,
    itemSkus: new Set<string>(),
    collisionOrdinals: new Map<string, number>(),
    processingFolders: new Set<string>(),
    filesystemPaths: new Set<string>(),
    originalFilenames: new Set<string>(),
    duplicateNames,
    totalPhotos: 0,
    totalHashedBytes: 0,
    enrichmentBytes: 0,
  };
  const itemValues = boundedArray(object.items, MAX_ITEMS);
  const collisionValues = boundedArray(object.collisions, MAX_ITEMS);
  if (itemValues.length + collisionValues.length > MAX_ITEMS) invalid();
  const items = itemValues.map((entry) => validateItem(entry, false, state));
  const collisions = collisionValues.map((entry) => validateItem(entry, true, state));
  if ([...state.duplicateNames.values()].some((count) => count !== 0)) invalid();
  const needsReview = boundedArray(object.needsReview, MAX_NEEDS_REVIEW).map((entry) => {
    const review = exactObject(entry, ["originalFilename", "storedPath", "reason"]);
    const stored = existingPathUnder(review.storedPath, needsReviewRoot, "file");
    addUnique(state.filesystemPaths, stored.real);
    return {
      originalFilename: safeFilename(review.originalFilename),
      storedPath: stored.value,
      reason: boundedString(review.reason, 2_048, { nonEmpty: true }),
    };
  });
  const problems = boundedArray(object.problems, MAX_PROBLEMS)
    .map((entry) => validateProblem(entry, authorizedRoots));

  const countsObject = exactObject(object.counts, [
    "itemsCreated", "photosProcessed", "duplicatesSkipped", "problems", "collisions",
  ]);
  const counts = {
    itemsCreated: boundedInteger(countsObject.itemsCreated, 0, MAX_ITEMS),
    photosProcessed: boundedInteger(countsObject.photosProcessed, 0, MAX_TOTAL_PHOTOS),
    duplicatesSkipped: boundedInteger(countsObject.duplicatesSkipped, 0, MAX_DUPLICATES),
    problems: boundedInteger(countsObject.problems, 0, MAX_PROBLEMS),
    collisions: boundedInteger(countsObject.collisions, 0, MAX_ITEMS),
  };
  if (counts.itemsCreated !== items.length ||
      counts.photosProcessed !== state.totalPhotos + duplicates.length ||
      counts.duplicatesSkipped !== duplicates.length ||
      counts.problems !== problems.length ||
      counts.collisions !== collisions.length) invalid();

  return {
    batchId,
    items,
    collisions,
    duplicates,
    needsReview,
    problems,
    counts,
    durationMs: boundedInteger(object.durationMs, 0, MAX_DURATION_MS),
  };
}

/**
 * Validate and reconstruct a worker result.  Every failure deliberately has the
 * same short error so forged paths or model text never leak into logs/UI.
 */
export function validateWorkerResult(
  value: unknown,
  settings: WorkerResultValidationSettings,
): WorkerResult {
  try {
    return validateWorkerResultInner(value, settings);
  } catch {
    invalid();
  }
}
