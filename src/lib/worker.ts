import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AppSettingsData, ItemEnrichment, WorkerResult } from "./types";
import {
  MAX_ENRICHMENT_BATCH_JSON_BYTES,
  validateWorkerEnrichment,
  validateWorkerResult,
} from "./workerResultValidation.ts";
import { validateManagedWorkRoots } from "./workRoots.ts";

export function dbAbsPath(): string {
  // Use the SAME DB file the Next writer uses. Electron sets DATABASE_URL to an absolute
  // path (in a packaged build it points OUTSIDE cwd, e.g. ~/BlackCatAgent), so prefer it;
  // fall back to the conventional cwd/data path in dev or when it isn't set (B8).
  const url = process.env.DATABASE_URL;
  if (url) {
    const f = url.replace(/^file:/, "").trim();
    if (path.isAbsolute(f)) return f;
  }
  return path.join(process.cwd(), "data", "black-cat.db");
}

function workerEnv(
  settings: AppSettingsData,
  extra: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Honor the PYTHONPATH-contamination gotcha: never let another venv shadow ours.
    PYTHONPATH: "",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.cwd(), ".local", "playwright"),
    // Piped stdout defaults to cp1252 on Windows — the workers print em-dashes etc.,
    // which otherwise land in the logs as mojibake.
    PYTHONIOENCODING: "utf-8",
    BLACKCAT_DB_PATH: dbAbsPath(),
    BLACKCAT_DATA_ROOT: settings.dataRoot,
    // Run-scoped capabilities never inherit from the launcher environment.
    BLACKCAT_CANCEL_FILE: "",
    BLACKCAT_FORCE_NO_AI: "",
    BLACKCAT_PARENT_PID: "",
    BLACKCAT_PARENT_CREATION_TOKEN: "",
    ...extra,
  };
}

function workerCwd(): string {
  return path.join(process.cwd(), "worker");
}

interface SpawnLineResult {
  code: number;
  lines: string[];
  stderr: string;
  protocolIssue?: string;
}

const MAX_WORKER_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 512 * 1024;
const MAX_WORKER_LINE_BYTES = 32 * 1024 * 1024;
const MAX_WORKER_EVENTS = 50_000;

/** UTF-8 stream decoder shared by production pipes and the split-byte test. */
export function createWorkerUtf8Decoder(): StringDecoder {
  return new StringDecoder("utf8");
}

function spawnWorker(
  settings: AppSettingsData,
  args: string[],
  onLine?: (obj: Record<string, unknown>) => void,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
  extraEnv?: Partial<NodeJS.ProcessEnv>,
): Promise<SpawnLineResult> {
  return new Promise((resolve, reject) => {
    const py = settings.pythonWorkerPath || "python";
    const child = spawn(py, args, { cwd: workerCwd(), env: workerEnv(settings, extraEnv) });
    onSpawn?.(child);
    const lines: string[] = [];
    let buf = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let eventCount = 0;
    let protocolIssue = "";
    const stdoutDecoder = createWorkerUtf8Decoder();
    const stderrDecoder = createWorkerUtf8Decoder();

    const markIssue = (message: string) => {
      if (!protocolIssue) protocolIssue = message;
    };

    const consumeStdout = (text: string) => {
      if (!text) return;
      buf += text;
      if (Buffer.byteLength(buf, "utf-8") > MAX_WORKER_LINE_BYTES) {
        markIssue("worker emitted an oversized protocol line");
        buf = "";
        return; // keep draining the pipe; never kill a possible session owner
      }
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        eventCount += 1;
        if (eventCount > MAX_WORKER_EVENTS) {
          markIssue("worker emitted too many protocol events");
          continue;
        }
        if (Buffer.byteLength(line, "utf-8") > MAX_WORKER_LINE_BYTES) {
          markIssue("worker emitted an oversized protocol line");
          continue;
        }
        lines.push(line);
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            markIssue("worker emitted a non-object protocol event");
          } else if (onLine) {
            onLine(parsed as Record<string, unknown>);
          }
        } catch {
          markIssue("worker emitted invalid protocol JSON");
        }
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      const decoded = stdoutDecoder.write(d);
      if (stdoutBytes > MAX_WORKER_STDOUT_BYTES) {
        markIssue("worker stdout exceeded the protocol limit");
        buf = "";
        return; // keep draining the pipe; never kill a possible session owner
      }
      consumeStdout(decoded);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrBytes += d.length;
      const decoded = stderrDecoder.write(d);
      if (stderrBytes > MAX_WORKER_STDERR_BYTES) {
        markIssue("worker stderr exceeded the protocol limit");
        return;
      }
      stderr += decoded;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutBytes <= MAX_WORKER_STDOUT_BYTES) consumeStdout(stdoutTail);
      const stderrTail = stderrDecoder.end();
      if (stderrBytes <= MAX_WORKER_STDERR_BYTES) stderr += stderrTail;
      if (buf.trim()) markIssue("worker ended with an unterminated protocol line");
      resolve({ code: code ?? -1, lines, stderr, ...(protocolIssue ? { protocolIssue } : {}) });
    });
  });
}

// The one live intake run, kept on globalThis so the /api/process and
// /api/process/cancel route bundles always see the SAME registry (per-route module
// instances are not guaranteed to be shared). Cancellation is a file token that
// the worker observes at safe checkpoints; Node never kills a session owner.
export interface ManagedVisionDeferral {
  status: "busy" | "ambiguous";
  message: string;
  detail?: string;
  attempts?: number;
  elapsedSeconds?: number;
}

export class ManagedVisionDeferredError extends Error {
  readonly code = "VISION_DEFERRED";
  readonly deferral: ManagedVisionDeferral;

  constructor(deferral: ManagedVisionDeferral) {
    super(deferral.message);
    this.name = "ManagedVisionDeferredError";
    this.deferral = deferral;
  }
}

export class ManagedVisionCancelledError extends Error {
  readonly code = "VISION_CANCELLED";

  constructor(message = "managed vision cancelled") {
    super(message);
    this.name = "ManagedVisionCancelledError";
  }
}

export class ManagedVisionCancelRequestError extends Error {
  readonly code = "VISION_CANCEL_REQUEST_FAILED";

  constructor() {
    super("VISION_CANCEL_REQUEST_FAILED");
    this.name = "ManagedVisionCancelRequestError";
  }
}

const MANAGED_URL_RE = /\b(?:https?:\/\/|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)[^\s,;]*/gi;

function boundedManagedText(value: unknown, limit: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(MANAGED_URL_RE, "[managed endpoint]")
    .trim()
    .slice(0, limit);
}

export function managedVisionDeferralFromEvent(event: Record<string, unknown>): ManagedVisionDeferral {
  const verdict = event.verdict && typeof event.verdict === "object" && !Array.isArray(event.verdict)
    ? event.verdict as Record<string, unknown>
    : {};
  const status: ManagedVisionDeferral["status"] =
    String(event.status ?? verdict.status ?? "").toLowerCase() === "ambiguous" ? "ambiguous" : "busy";
  const result: ManagedVisionDeferral = {
    status,
    message: boundedManagedText(event.message, 240) || "managed vision is busy",
  };
  const detail = boundedManagedText(event.detail ?? verdict.detail, 240);
  if (detail) result.detail = detail;
  const attempts = event.attempts ?? verdict.attempts;
  if (typeof attempts === "number" && Number.isInteger(attempts)
      && attempts >= 0 && attempts <= 1000) result.attempts = attempts;
  const elapsedSeconds = event.elapsedSeconds ?? verdict.elapsedSeconds
    ?? verdict.elapsed_seconds ?? verdict.elapsed_s;
  if (typeof elapsedSeconds === "number" && Number.isFinite(elapsedSeconds)
      && elapsedSeconds >= 0 && elapsedSeconds <= 3600) {
    result.elapsedSeconds = elapsedSeconds;
  }
  return result;
}

interface PromiseCell<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function promiseCell<T>(): PromiseCell<T> {
  let resolve!: PromiseCell<T>["resolve"];
  let reject!: PromiseCell<T>["reject"];
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

type IntakeReg = {
  child: ReturnType<typeof spawn>;
  cancelFile: string;
  cancelRequested: boolean;
  closed: Promise<void>;
};
const globalReg = globalThis as unknown as {
  __bcaIntake?: IntakeReg | null;
  __bcaIntakePrep?: boolean;
  __bcaIncomingMutation?: boolean;
  __bcaIntakeProgress?: { seq: number; event: Record<string, unknown> } | null;
};

export const INTAKE_CANCELLED = "INTAKE_CANCELLED";

/** Whether an intake run is live OR being prepared — POST /api/process rejects a
 * second one: two workers over the same /incoming was always hazardous, and the
 * single-slot registry above can only cancel the newest run. The prep flag closes
 * the 2026-08-06 review finding: the vision preflight can take minutes BEFORE the
 * worker spawns, and that whole window used to read as "not running". */
export function intakeRunning(): boolean {
  return !!globalReg.__bcaIntake || !!globalReg.__bcaIntakePrep;
}

/** Reserve the single intake slot for the pre-worker phase (vision preflight).
 * Returns false when an intake is already preparing or running. The caller MUST
 * call releaseIntakePrep() when its run ends (any outcome) — runIntake's own
 * registry covers the spawned window in between. */
export function tryReserveIntake(): boolean {
  if (globalReg.__bcaIntake || globalReg.__bcaIntakePrep || globalReg.__bcaIncomingMutation) return false;
  globalReg.__bcaIntakePrep = true;
  return true;
}

export function releaseIntakePrep(): void {
  globalReg.__bcaIntakePrep = false;
}

/** Imports and pending-file disposal must not change an intake's workset.
 * This shares globalThis with the intake slot across separate route bundles. */
export function tryReserveIncomingMutation(): boolean {
  if (intakeRunning() || globalReg.__bcaIncomingMutation) return false;
  globalReg.__bcaIncomingMutation = true;
  return true;
}

export function releaseIncomingMutation(): void {
  globalReg.__bcaIncomingMutation = false;
}

export interface IntakeProgressSnapshot {
  running: boolean;
  seq: number;
  event: Record<string, unknown> | null;
}

/** The newest worker progress event, recorded even BEFORE admission opens the
 * response stream. POST /api/process deliberately cannot send a byte until
 * admission settles (a managed-vision deferral has to stay a real HTTP 503), and
 * the worker only admits once grouping is done - so hashing, EXIF and decoding a
 * large batch are minutes of work the stream structurally cannot report.
 * GET /api/process/progress reads this snapshot to cover exactly that window. */
export function intakeProgressSnapshot(): IntakeProgressSnapshot {
  const running = intakeRunning();
  const snapshot = globalReg.__bcaIntakeProgress;
  if (!running || !snapshot) return { running, seq: 0, event: null };
  return { running, seq: snapshot.seq, event: snapshot.event };
}

/** Request cooperative cancellation and await the worker's natural cleanup.
 * Returns false only when no intake is running. */
function requestIntakeCancellation(reg: IntakeReg): boolean {
  if (reg.cancelRequested) return true;
  try {
    fs.writeFileSync(reg.cancelFile, `${new Date().toISOString()}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    reg.cancelRequested = true;
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      reg.cancelRequested = true;
      return true;
    }
    throw new Error("CANCEL_REQUEST_FAILED");
  }
}

export async function cancelIntake(): Promise<boolean> {
  const reg = globalReg.__bcaIntake;
  if (!reg || !reg.child.pid) return false;
  requestIntakeCancellation(reg);
  await reg.closed;
  return true;
}

/** Run the intake worker and return its structured result. */
export type IntakeAdmission =
  | { ok: true; mode: "managed" | "no-ai" }
  | { ok: false; kind: "deferred"; deferral: ManagedVisionDeferral }
  | { ok: false; kind: "error"; error: string }
  | { ok: false; kind: "cancelled" };

export interface IntakeHandle {
  admission: Promise<IntakeAdmission>;
  result: Promise<WorkerResult>;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  cancel(): boolean;
}

export interface IntakeOptions { forceNoAi?: boolean }

export interface IntakeProtocolCounts {
  admitted: number;
  result: number;
  deferred: number;
  cancelled: number;
  error: number;
}

/** Pure transition guard used by the streaming bridge and offline regressions. */
export function validateIntakeProtocolTransition(
  counts: IntakeProtocolCounts,
  event: "admitted" | "result" | "deferred" | "cancelled" | "error",
): string | null {
  const terminal = counts.result + counts.deferred + counts.cancelled + counts.error;
  if (event === "admitted") {
    if (counts.admitted) return "worker emitted multiple admission events";
    if (terminal) return "worker emitted admission after a terminal event";
    return null;
  }
  if (event === "result") {
    if (counts.result) return "worker emitted multiple results";
    if (counts.admitted !== 1) return "worker emitted a result before admission";
    if (counts.deferred || counts.cancelled || counts.error) {
      return "worker mixed result with another terminal event";
    }
    return null;
  }
  if (event === "deferred") {
    return counts.deferred || counts.admitted || counts.result || counts.cancelled || counts.error
      ? "worker emitted an invalid or out-of-order deferral"
      : null;
  }
  if (event === "cancelled") {
    return counts.cancelled || counts.result || counts.deferred || counts.error
      ? "worker mixed or duplicated cancellation terminals"
      : null;
  }
  return counts.error || counts.result || counts.deferred || counts.cancelled
    ? "worker mixed or duplicated error terminals"
    : null;
}

const MAX_INTAKE_PROGRESS_EVENTS = 20_000;

export function normalizeIntakeProgressEvent(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof raw.stage !== "string" || !raw.stage.trim() || raw.stage.length > 64) return null;
  const event: Record<string, unknown> = { event: "progress", stage: raw.stage.trim() };
  const stringLimits: Record<string, number> = {
    message: 500,
    file: 512,
    sku: 128,
    error: 500,
    orderSource: 64,
    confidence: 32,
  };
  for (const [key, limit] of Object.entries(stringLimits)) {
    if (raw[key] != null) event[key] = boundedManagedText(raw[key], limit);
  }
  for (const key of [
    "i", "n", "done", "total", "items", "shells", "needsReview", "problems",
    "secs", "listingPhotos", "inBatchDupes", "reattached",
  ]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
      event[key] = value;
    }
  }
  for (const key of ["collision", "ok", "placeholder"]) {
    if (typeof raw[key] === "boolean") event[key] = raw[key];
  }
  if (Array.isArray(raw.fields)) {
    event.fields = raw.fields.slice(0, 64)
      .filter((value): value is string => typeof value === "string")
      .map((value) => boundedManagedText(value, 64));
  }
  return event;
}

/** Spawn immediately, buffering progress until a managed/no-AI admission. */
export function startIntake(settings: AppSettingsData, options: IntakeOptions = {}): IntakeHandle {
  // Keep direct callers (scripts/tests and runIntake) on the same safe workset
  // boundary as the HTTP route. This is validation only and creates nothing.
  validateManagedWorkRoots(settings);
  // A previous run's tail must never be read as this one's first progress.
  globalReg.__bcaIntakeProgress = null;
  const admissionCell = promiseCell<IntakeAdmission>();
  const resultCell = promiseCell<WorkerResult>();
  const closedCell = promiseCell<void>();
  const progressHistory: Record<string, unknown>[] = [];
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let progressOpen = false;
  let admissionSettled = false;
  let rawResult: unknown;
  let deferredEvent: Record<string, unknown> | null = null;
  let cancelledEvent: Record<string, unknown> | null = null;
  let errorMessage = "";
  let protocolError = "";
  let admissionCount = 0;
  let resultCount = 0;
  let deferredCount = 0;
  let cancelledCount = 0;
  let errorCount = 0;
  let reg: IntakeReg | null = null;
  const cancelFile = path.resolve(os.tmpdir(), `blackcat-intake-cancel-${randomUUID()}.token`);

  const settleAdmission = (value: IntakeAdmission) => {
    if (admissionSettled) return;
    admissionSettled = true;
    if (value.ok) {
      progressOpen = true;
      for (const event of progressHistory) {
        for (const listener of listeners) {
          try { listener(event); } catch { /* observer failures never affect the worker */ }
        }
      }
    }
    admissionCell.resolve(value);
  };

  const recordProgress = (event: Record<string, unknown>) => {
    if (protocolError) return;
    const bounded = normalizeIntakeProgressEvent(event);
    if (!bounded) {
      protocolError = "worker emitted an invalid progress event";
      return;
    }
    if (progressHistory.length >= MAX_INTAKE_PROGRESS_EVENTS) {
      protocolError = "worker emitted too many progress events";
      return;
    }
    progressHistory.push(bounded);
    // Updated regardless of progressOpen: this is the only view of the
    // pre-admission phases (see intakeProgressSnapshot).
    globalReg.__bcaIntakeProgress = {
      seq: (globalReg.__bcaIntakeProgress?.seq ?? 0) + 1,
      event: bounded,
    };
    if (!progressOpen) return;
    for (const listener of listeners) {
      try { listener(bounded); } catch { /* observer failures never affect the worker */ }
    }
  };

  const completion = spawnWorker(
    settings,
    ["-m", "black_cat_worker.process"],
    (obj) => {
      const event = String(obj.event ?? "");
      if (event === "admitted") {
        const violation = validateIntakeProtocolTransition({
          admitted: admissionCount, result: resultCount, deferred: deferredCount,
          cancelled: cancelledCount, error: errorCount,
        }, event);
        admissionCount += 1;
        if (violation) {
          protocolError = violation;
          return;
        }
        const mode = obj.mode;
        if (mode !== "managed" && mode !== "no-ai") {
          protocolError = "worker emitted an invalid admission mode";
          return;
        }
        settleAdmission({ ok: true, mode });
      } else if (event === "result") {
        const violation = validateIntakeProtocolTransition({
          admitted: admissionCount, result: resultCount, deferred: deferredCount,
          cancelled: cancelledCount, error: errorCount,
        }, event);
        resultCount += 1;
        if (violation) {
          protocolError = violation;
        } else rawResult = obj.payload;
      } else if (event === "deferred") {
        const violation = validateIntakeProtocolTransition({
          admitted: admissionCount, result: resultCount, deferred: deferredCount,
          cancelled: cancelledCount, error: errorCount,
        }, event);
        deferredCount += 1;
        if (violation) protocolError = violation;
        deferredEvent = obj;
      } else if (event === "cancelled") {
        const violation = validateIntakeProtocolTransition({
          admitted: admissionCount, result: resultCount, deferred: deferredCount,
          cancelled: cancelledCount, error: errorCount,
        }, event);
        cancelledCount += 1;
        if (violation) protocolError = violation;
        cancelledEvent = obj;
      } else if (event === "error") {
        const violation = validateIntakeProtocolTransition({
          admitted: admissionCount, result: resultCount, deferred: deferredCount,
          cancelled: cancelledCount, error: errorCount,
        }, event);
        errorCount += 1;
        if (violation) protocolError = violation;
        errorMessage = boundedManagedText(obj.message, 500);
      } else if (event === "progress") {
        if (resultCount || deferredCount || cancelledCount || errorCount) {
          protocolError = "worker emitted progress after a terminal event";
        } else {
          recordProgress(obj);
        }
      } else {
        protocolError = `worker emitted unknown event ${boundedManagedText(event, 64) || "(missing)"}`;
      }
    },
    (child) => {
      reg = { child, cancelFile, cancelRequested: false, closed: closedCell.promise };
      globalReg.__bcaIntake = reg;
    },
    {
      BLACKCAT_CANCEL_FILE: cancelFile,
      BLACKCAT_FORCE_NO_AI: options.forceNoAi ? "1" : "0",
      BLACKCAT_PARENT_PID: String(process.pid),
      BLACKCAT_PARENT_CREATION_TOKEN: "",
    },
  ).then(({ code, stderr, protocolIssue }) => {
    let terminalError: Error | null = null;
    if (protocolIssue || protocolError) {
      terminalError = new Error(protocolIssue || protocolError);
      if (!admissionSettled) {
        settleAdmission({ ok: false, kind: "error", error: terminalError.message });
      }
    } else if (code === 0 && admissionCount === 1 && resultCount === 1
        && !deferredCount && !cancelledCount && !errorCount) {
      try {
        // Validate only after close. A worker must not be able to emit a valid
        // path/hash receipt, mutate those files, and then exit successfully.
        resultCell.resolve(validateWorkerResult(rawResult, settings));
        return;
      } catch {
        terminalError = new Error("Invalid worker result");
      }
    } else if (code === 75 && deferredCount === 1 && deferredEvent && !resultCount
        && !cancelledCount && !errorCount) {
      const deferredError = new ManagedVisionDeferredError(managedVisionDeferralFromEvent(deferredEvent));
      terminalError = deferredError;
      if (!admissionSettled) {
        settleAdmission({ ok: false, kind: "deferred", deferral: deferredError.deferral });
      }
    } else if (code === 130 && cancelledCount === 1 && cancelledEvent && !resultCount
        && !deferredCount && !errorCount) {
      terminalError = new ManagedVisionCancelledError(INTAKE_CANCELLED);
      if (!admissionSettled) settleAdmission({ ok: false, kind: "cancelled" });
    } else {
      const detail = errorMessage || boundedManagedText(stderr, 500)
        || `worker exited ${code} without a valid terminal event`;
      terminalError = new Error(`Worker error: ${detail}`);
      if (!admissionSettled) {
        settleAdmission({ ok: false, kind: "error", error: terminalError.message });
      }
    }
    resultCell.reject(terminalError);
  }).catch((error: unknown) => {
    const terminalError = error instanceof Error ? error : new Error(String(error));
    if (!admissionSettled) {
      settleAdmission({
        ok: false,
        kind: "error",
        error: boundedManagedText(terminalError.message, 500),
      });
    }
    resultCell.reject(terminalError);
  }).finally(() => {
    const completedReg = reg;
    if (globalReg.__bcaIntake === completedReg) globalReg.__bcaIntake = null;
    // Prevent a request abort during later persistence from recreating a token
    // after the worker's one and only cleanup pass has already unlinked it.
    reg = null;
    try { fs.unlinkSync(cancelFile); } catch { /* token is normally absent */ }
    closedCell.resolve();
  });
  void completion.catch(() => {});
  void resultCell.promise.catch(() => {});

  return {
    admission: admissionCell.promise,
    result: resultCell.promise,
    subscribe(listener) {
      listeners.add(listener);
      if (progressOpen) {
        for (const event of progressHistory) {
          try { listener(event); } catch { /* observer failures never affect the worker */ }
        }
      }
      return () => { listeners.delete(listener); };
    },
    cancel() { return reg ? requestIntakeCancellation(reg) : false; },
  };
}

/** Compatibility wrapper for scripts and non-streaming callers. */
export async function runIntake(
  settings: AppSettingsData,
  onProgress?: (obj: Record<string, unknown>) => void,
  options: IntakeOptions = {},
): Promise<WorkerResult> {
  const handle = startIntake(settings, options);
  const unsubscribe = onProgress ? handle.subscribe(onProgress) : () => {};
  try {
    const admission = await handle.admission;
    if (!admission.ok) {
      if (admission.kind === "deferred") throw new ManagedVisionDeferredError(admission.deferral);
      if (admission.kind === "cancelled") throw new ManagedVisionCancelledError(INTAKE_CANCELLED);
      throw new Error(admission.error);
    }
    return await handle.result;
  } finally {
    unsubscribe();
  }
}

/** Re-run AI vision identification for one item from its stored photos.
 * Returns the same enrichment shape intake produces ({fields, aiFields, raw} or
 * {error}). Throws only on worker-level failure (venv broken, no output). */
export interface ReenrichBatchRequest {
  requestId: string;
  sku: string;
  photos: ReenrichPhotoRequest[];
}

export interface ReenrichPhotoRequest {
  photoId: number;
  storedPath: string;
  isMarker: boolean;
  sha256: string;
  rotation?: number;
}

export interface ReenrichBatchResult {
  requestId: string;
  enrichment: ItemEnrichment;
}

const MAX_REENRICH_ITEMS = 500;
const MAX_REENRICH_PHOTOS_PER_ITEM = 32;
const MAX_REENRICH_SPEC_BYTES = 8 * 1024 * 1024;
const MAX_REENRICH_IMAGE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REENRICH_BATCH_IMAGE_BYTES = 16 * 1024 * 1024 * 1024;

function assertReenrichBatchInput(
  settings: AppSettingsData,
  items: ReenrichBatchRequest[],
): void {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_REENRICH_ITEMS) {
    throw new Error(`re-identification batch must contain between 1 and ${MAX_REENRICH_ITEMS} items`);
  }
  if (!path.isAbsolute(settings.processingPath)) {
    throw new Error("managed processing root must be absolute");
  }
  const processingRoot = path.resolve(settings.processingPath);
  let processingRootReal: string;
  try {
    if (!fs.statSync(processingRoot).isDirectory()) throw new Error("not a directory");
    processingRootReal = path.resolve(fs.realpathSync.native(processingRoot));
  } catch {
    throw new Error("managed processing root must be an existing directory");
  }
  const requestIds = new Set<string>();
  const photoIds = new Set<number>();
  const photoPaths = new Set<string>();
  let totalImageBytes = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).some((key) => !["requestId", "sku", "photos"].includes(key))) {
      throw new Error("re-identification items contain unsupported fields");
    }
    if (typeof item.requestId !== "string" || !item.requestId || item.requestId.length > 128
        || requestIds.has(item.requestId)) {
      throw new Error("re-identification request IDs must be unique bounded strings");
    }
    if (typeof item.sku !== "string" || item.sku.length > 128) {
      throw new Error("re-identification SKU must be a bounded string");
    }
    if (!Array.isArray(item.photos) || item.photos.length < 1
        || item.photos.length > MAX_REENRICH_PHOTOS_PER_ITEM) {
      throw new Error(`each re-identification item needs 1-${MAX_REENRICH_PHOTOS_PER_ITEM} photos`);
    }
    requestIds.add(item.requestId);
    let listingPhotos = 0;
    for (const photo of item.photos) {
      if (!photo || typeof photo !== "object" || Array.isArray(photo)
          || Object.keys(photo).some((key) => !["photoId", "storedPath", "isMarker", "sha256", "rotation"].includes(key))
          || !Number.isSafeInteger(photo.photoId) || photo.photoId <= 0
          || typeof photo.storedPath !== "string" || !photo.storedPath
          || photo.storedPath.length > 4096 || !path.isAbsolute(photo.storedPath)
          || typeof photo.isMarker !== "boolean"
          || typeof photo.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(photo.sha256)
          || photo.rotation !== undefined && ![0, 90, 180, 270].includes(photo.rotation)) {
        throw new Error("re-identification photo metadata is invalid");
      }
      const candidate = path.resolve(photo.storedPath);
      const relative = path.relative(processingRoot, candidate);
      if (!relative || relative.startsWith(`..${path.sep}`)
          || relative === ".." || path.isAbsolute(relative)) {
        throw new Error("re-identification photo is outside the managed processing root");
      }
      let photoReal: string;
      try {
        const photoInfo = fs.lstatSync(candidate);
        if (!photoInfo.isFile() || photoInfo.isSymbolicLink()) {
          throw new Error("not a regular file");
        }
        if (photoInfo.size < 0 || photoInfo.size > MAX_REENRICH_IMAGE_FILE_BYTES) {
          throw new Error("file exceeds the per-file limit");
        }
        totalImageBytes += photoInfo.size;
        if (totalImageBytes > MAX_REENRICH_BATCH_IMAGE_BYTES) {
          throw new Error("batch exceeds the aggregate limit");
        }
        photoReal = path.resolve(fs.realpathSync.native(candidate));
      } catch (error) {
        if (error instanceof Error && /per-file|aggregate/.test(error.message)) {
          throw new Error(`re-identification photo ${error.message}`);
        }
        throw new Error("re-identification photo must be an existing regular file");
      }
      const realRelative = path.relative(processingRootReal, photoReal);
      if (!realRelative || realRelative.startsWith(`..${path.sep}`)
          || realRelative === ".." || path.isAbsolute(realRelative)) {
        throw new Error("re-identification photo resolves outside the managed processing root");
      }
      const pathKey = process.platform === "win32" ? photoReal.toLowerCase() : photoReal;
      if (photoIds.has(photo.photoId) || photoPaths.has(pathKey)) {
        throw new Error("re-identification photo identities must be unique");
      }
      photoIds.add(photo.photoId);
      photoPaths.add(pathKey);
      if (!photo.isMarker) listingPhotos += 1;
    }
    if (!listingPhotos) throw new Error("each re-identification item needs a listing photo");
  }
}

function parsedEvents(lines: string[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        events.push(value as Record<string, unknown>);
      }
    } catch { /* ignore non-protocol stdout */ }
  }
  return events;
}

/** Pure guard for one-shot managed commands. These commands have no streaming
 * phase: exactly one terminal event is permitted, and nothing may follow it. */
export function validateManagedProtocolEvents(
  events: readonly Record<string, unknown>[],
): string | null {
  if (events.length !== 1) {
    return events.length === 0
      ? "worker emitted no terminal event"
      : "worker emitted multiple or non-terminal events";
  }
  const event = events[0].event;
  if (event !== "result" && event !== "deferred" && event !== "cancelled" && event !== "error") {
    return `worker emitted unsupported event ${boundedManagedText(event, 64) || "(missing)"}`;
  }
  return null;
}

export interface ManagedWorkerRunOptions {
  signal?: AbortSignal;
}

/** Spawn one managed-session command with cooperative, close-ordered cancellation. */
async function spawnManagedWorker(
  settings: AppSettingsData,
  args: string[],
  options: ManagedWorkerRunOptions = {},
): Promise<SpawnLineResult> {
  const signal = options.signal;
  if (signal?.aborted) throw new ManagedVisionCancelledError();

  const cancelFile = path.resolve(
    os.tmpdir(), `blackcat-managed-cancel-${randomUUID()}.token`,
  );
  const closeCell = promiseCell<void>();
  let childStarted = false;
  let childClosed = false;
  let cancelRequested = false;
  let cancelFailure: ManagedVisionCancelRequestError | null = null;

  const requestCancellation = () => {
    if (!childStarted || childClosed || cancelRequested || cancelFailure) return;
    try {
      fs.writeFileSync(cancelFile, `${new Date().toISOString()}\n`, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      cancelRequested = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        cancelRequested = true;
      } else {
        // EventTarget does not propagate listener exceptions to the awaiting
        // request. Retain the hard failure and surface it only after cleanup.
        cancelFailure = new ManagedVisionCancelRequestError();
      }
    }
  };

  const onAbort = () => { requestCancellation(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    signal.removeEventListener("abort", onAbort);
    throw new ManagedVisionCancelledError();
  }

  try {
    let completed: SpawnLineResult;
    try {
      completed = await spawnWorker(
        settings,
        args,
        undefined,
        (child) => {
          childStarted = true;
          child.once("close", () => {
            childClosed = true;
            closeCell.resolve();
          });
          // Close the tiny add-listener/spawn race without creating a second
          // cancellation mechanism.
          if (signal?.aborted) requestCancellation();
        },
        {
          BLACKCAT_CANCEL_FILE: cancelFile,
          BLACKCAT_PARENT_PID: String(process.pid),
          BLACKCAT_PARENT_CREATION_TOKEN: "",
        },
      );
    } catch (error) {
      // A spawned child owns any possible ResidentSession until its close event.
      // Even spawn/error paths must not remove its token or listener early.
      if (childStarted && !childClosed) await closeCell.promise;
      if (cancelFailure) throw cancelFailure;
      throw error;
    }
    childClosed = true; // spawnWorker resolves from the same close event.
    if (cancelFailure) throw cancelFailure;
    if (signal?.aborted && completed.code === 0) {
      throw new ManagedVisionCancelledError();
    }
    return completed;
  } finally {
    childClosed = true;
    signal?.removeEventListener("abort", onAbort);
    try { fs.unlinkSync(cancelFile); } catch { /* token is normally absent */ }
  }
}

function managedPayload(result: SpawnLineResult, label: string): unknown {
  if (result.protocolIssue) throw new Error(`${label} failed: ${result.protocolIssue}`);
  const events = parsedEvents(result.lines);
  const eventIssue = validateManagedProtocolEvents(events);
  if (eventIssue) throw new Error(`${label} failed: ${eventIssue}`);
  const results = events.filter((event) => event.event === "result");
  const deferrals = events.filter((event) => event.event === "deferred");
  const cancellations = events.filter((event) => event.event === "cancelled");
  const errors = events.filter((event) => event.event === "error");
  if (result.code === 0 && results.length === 1 && !deferrals.length
      && !cancellations.length && !errors.length) return results[0].payload;
  if (result.code === 75 && deferrals.length === 1 && !results.length
      && !cancellations.length && !errors.length) {
    throw new ManagedVisionDeferredError(managedVisionDeferralFromEvent(deferrals[0]));
  }
  if (result.code === 130 && cancellations.length === 1 && !results.length
      && !deferrals.length && !errors.length) {
    throw new ManagedVisionCancelledError(boundedManagedText(cancellations[0].message, 240));
  }
  const reported = errors.length === 1 ? boundedManagedText(errors[0].message, 500) : "";
  const stderr = boundedManagedText(result.stderr, 500);
  throw new Error(`${label} failed (exit ${result.code}): ${reported || stderr || "invalid worker protocol"}`);
}

/** Re-identify an exact batch in one Python process and one managed session. */
export async function runReenrichBatch(
  settings: AppSettingsData,
  items: ReenrichBatchRequest[],
  options: ManagedWorkerRunOptions = {},
): Promise<ReenrichBatchResult[]> {
  if (options.signal?.aborted) throw new ManagedVisionCancelledError();
  assertReenrichBatchInput(settings, items);
  const requestIds = new Set(items.map((item) => item.requestId));
  const tmp = path.join(os.tmpdir(), `bca-reenrich-${randomUUID()}.json`);
  const serialized = JSON.stringify({ items });
  if (Buffer.byteLength(serialized, "utf-8") > MAX_REENRICH_SPEC_BYTES) {
    throw new Error("re-identification batch spec exceeds the protocol limit");
  }
  fs.writeFileSync(tmp, serialized, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    const output = managedPayload(await spawnManagedWorker(
      settings,
      ["-m", "black_cat_worker.reenrich_batch", tmp],
      options,
    ), "re-identification worker");
    if (!output || typeof output !== "object" || !Array.isArray((output as { items?: unknown }).items)) {
      throw new Error("re-identification worker returned an invalid result payload");
    }
    const rows = (output as { items: unknown[] }).items;
    if (rows.length !== items.length) {
      throw new Error("re-identification worker returned the wrong result count");
    }
    const byId = new Map<string, ReenrichBatchResult>();
    let enrichmentBytes = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        throw new Error("re-identification worker returned an invalid item");
      }
      const candidate = row as Partial<ReenrichBatchResult>;
      if (typeof candidate.requestId !== "string" || !requestIds.has(candidate.requestId)
          || byId.has(candidate.requestId)) {
        throw new Error("re-identification worker returned an unknown or duplicate request ID");
      }
      let enrichment: ItemEnrichment;
      try {
        enrichment = validateWorkerEnrichment(candidate.enrichment);
      } catch {
        throw new Error("re-identification worker returned an invalid enrichment");
      }
      enrichmentBytes += Buffer.byteLength(JSON.stringify(enrichment), "utf-8");
      if (enrichmentBytes > MAX_ENRICHMENT_BATCH_JSON_BYTES) {
        throw new Error("re-identification worker returned an oversized enrichment batch");
      }
      byId.set(candidate.requestId, { requestId: candidate.requestId, enrichment });
    }
    return items.map((item) => byId.get(item.requestId)!);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export async function runReenrich(
  settings: AppSettingsData,
  sku: string,
  photos: ReenrichPhotoRequest[],
  options: ManagedWorkerRunOptions = {},
): Promise<ItemEnrichment> {
  const [result] = await runReenrichBatch(
    settings, [{ requestId: "single", sku, photos }], options,
  );
  return result.enrichment;
}

export interface VisionProbeResult {
  ok: true;
  model: string;
  responseModel: string;
}

export async function runVisionProbe(
  settings: AppSettingsData,
  options: ManagedWorkerRunOptions = {},
): Promise<VisionProbeResult> {
  if (options.signal?.aborted) throw new ManagedVisionCancelledError();
  const payload = managedPayload(await spawnManagedWorker(
    settings,
    ["-m", "black_cat_worker.reenrich_batch", "--probe"],
    options,
  ), "managed vision probe");
  if (!payload || typeof payload !== "object") {
    throw new Error("managed vision probe returned an invalid receipt");
  }
  const receipt = payload as Partial<VisionProbeResult>;
  if (receipt.ok !== true || typeof receipt.model !== "string" || !receipt.model
      || receipt.responseModel !== receipt.model) {
    throw new Error("managed vision probe returned an invalid receipt");
  }
  return receipt as VisionProbeResult;
}

export const runManagedVisionProbe = runVisionProbe;

/** Run the export worker for one item; returns the ready folder path. */
export async function runExport(
  settings: AppSettingsData,
  spec: Record<string, unknown>,
): Promise<string> {
  if (typeof spec.readyDir !== "string" || !path.isAbsolute(spec.readyDir)) {
    throw new Error("Export requires an absolute ready folder.");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bca-export-"));
  const tmp = path.join(directory, "spec.json");
  try {
    fs.writeFileSync(tmp, JSON.stringify(spec), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const { lines, code, stderr, protocolIssue } = await spawnWorker(settings, [
      "-m",
      "black_cat_worker.export",
      tmp,
    ]);
    if (code !== 0) throw new Error(`Export failed (exit ${code}). ${stderr.trim().slice(-600)}`);
    if (protocolIssue || lines.length !== 1) {
      throw new Error(`Export did not return a valid completion receipt: ${protocolIssue || "expected exactly one result"}.`);
    }
    const receipt = JSON.parse(lines[0]);
    if (receipt.ok !== true || receipt.readyDir !== spec.readyDir) {
      throw new Error("Export did not confirm the requested ready folder.");
    }
    return receipt.readyDir;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* absent after a failed write */ }
    try { fs.rmdirSync(directory); } catch { /* never recursively remove unexpected files */ }
  }
}

/** Check whether the configured worker python exists. */
export function workerPythonExists(settings: AppSettingsData): boolean {
  const py = settings.pythonWorkerPath;
  if (!py) return false;
  try {
    return fs.existsSync(py);
  } catch {
    return false;
  }
}
