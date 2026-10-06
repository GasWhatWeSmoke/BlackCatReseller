import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AppSettingsData } from "../types.ts";
import { dbAbsPath } from "../worker.ts";
import { listingIdentity } from "./attempts.ts";

export interface RemovalRequest {
  listingId: number;
  marketplace: string;
  externalListingId: string;
  externalUrl: string;
  attempt: number;
}

export interface RemovalReport {
  outcome: "ended" | "failed" | "unknown";
  verified: boolean;
  submissionStarted?: boolean;
  reason?: string;
}

// Expand only as each native removal worker is implemented and verified.
export const REMOVAL_MARKETPLACES = ["depop", "poshmark", "ebay", "etsy", "mercari"] as const;
export function supportsBrowserRemoval(marketplace: string): boolean {
  return REMOVAL_MARKETPLACES.some((supported) => supported === marketplace);
}

/** Inspection/publication reports cannot certify removal. Even a worker's
 * success needs an exact identity, URL and explicit availability verification. */
export function parseRemovalReport(output: string, request: RemovalRequest): RemovalReport | null {
  if (!supportsBrowserRemoval(request.marketplace)) return null;
  const prefix = `${request.marketplace.toUpperCase()}_END_DONE`;
  const last = [...output.matchAll(new RegExp(`^${prefix} (.+)$`, "gm"))].at(-1)?.[1];
  if (!last) return null;
  try {
    const value = JSON.parse(last);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.outcome === "ended") {
      const identity = typeof value.url === "string" ? listingIdentity(request.marketplace, value.url) : null;
      if (value.verified !== true || value.externalListingId !== request.externalListingId ||
          identity?.id !== request.externalListingId || typeof value.submissionStarted !== "boolean") return null;
      return { outcome: "ended", verified: true, submissionStarted: value.submissionStarted };
    }
    if (!["failed", "unknown"].includes(value.outcome) || value.verified !== false) return null;
    return {
      outcome: value.outcome === "failed" && value.submissionStarted === false ? "failed" : "unknown",
      verified: false,
      ...(typeof value.submissionStarted === "boolean" ? { submissionStarted: value.submissionStarted } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 2000) } : {}),
    };
  } catch { return null; }
}

interface Options {
  timeoutMs?: number;
  launch?: (args: string[], input: string) => ChildProcessWithoutNullStreams;
}

/** The caller retains the shared browser claim until the worker exits.
 * This transport deliberately accepts only native removal reports. */
export function runDelistWorker(settings: AppSettingsData, request: RemovalRequest, options: Options = {}): Promise<RemovalReport> {
  const identity = listingIdentity(request.marketplace, request.externalUrl);
  if (!supportsBrowserRemoval(request.marketplace) || !Number.isSafeInteger(request.listingId) || request.listingId < 1 ||
      !Number.isSafeInteger(request.attempt) || request.attempt < 1 || identity?.id !== request.externalListingId) {
    return Promise.resolve({ outcome: "failed", verified: false, submissionStarted: false, reason: "Native removal requires a supported marketplace and exact listing attempt." });
  }
  const args = ["-m", `black_cat_worker.end_${request.marketplace}`, "--mode", "end", "--listing-stdin"];
  const input = JSON.stringify(request);
  const logsDir = settings.logsPath || path.join(settings.dataRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logsDir, `delist-${request.listingId}.log`), { flags: "a" });
  log.on("error", () => { /* A log failure cannot certify or abort removal. */ });
  log.write(`\n--- ${request.marketplace} removal attempt ${request.attempt} @ ${new Date().toISOString()} ---\n`);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = options.launch ? options.launch(args, input) : spawn(settings.pythonWorkerPath || "python", args, {
      cwd: path.join(process.cwd(), "worker"), windowsHide: true,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8",
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.cwd(), ".local", "playwright"),
        BLACKCAT_DB_PATH: dbAbsPath(), BLACKCAT_DATA_ROOT: settings.dataRoot },
    });
  } catch (error) {
    log.end();
    return Promise.resolve({ outcome: "failed", verified: false, submissionStarted: false,
      reason: `Could not start removal: ${error instanceof Error ? error.message : String(error)}` });
  }
  return new Promise((resolve) => {
    let output = "", settled = false, stopping = false;
    let failure: RemovalReport | null = null;
    const stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = stdout.end();
      output += tail; log.write(tail + stderr.end()); log.end();
      resolve(failure ?? parseRemovalReport(output, request) ?? {
        outcome: "unknown", verified: false, reason: "The removal worker exited without a valid availability result.",
      });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      failure = { outcome: "unknown", verified: false, reason: "Removal timed out; marketplace availability still needs verification." };
      log.write(failure.reason + "\n");
      stop();
    }, options.timeoutMs ?? 5 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!settled) { const text = stdout.write(chunk); output += text; log.write(text); }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (!settled) log.write(stderr.write(chunk)); });
    child.on("error", (error) => {
      if (settled) return;
      failure = { outcome: child.pid ? "unknown" : "failed", verified: false,
        ...(!child.pid ? { submissionStarted: false } : {}), reason: error.message };
      if (!child.pid) finish(); else stop();
    });
    child.on("close", finish);
    child.stdin.on("error", () => { /* Worker close determines the result. */ });
    child.stdin.end(input);
  });
}
