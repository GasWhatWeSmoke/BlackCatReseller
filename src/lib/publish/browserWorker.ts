import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AppSettingsData } from "../types.ts";
import { dbAbsPath } from "../worker.ts";
import type { CanonicalListing } from "./types.ts";
import type { BrowserMarketplace } from "./platforms.ts";
import { parseBrowserReport, type BrowserReport, type ReportPrefix } from "./browserProtocol.ts";
import { beginUploadProgress } from "./liveProgress.ts";

interface Options {
  marketplace: BrowserMarketplace;
  mode: "post" | "fill";
  timeoutMs?: number;
  launch?: (args: string[], input: string) => ChildProcessWithoutNullStreams;
}

/** One visible browser worker. The caller owns the shared browser claim until
 *  this resolves, which only happens after the process has actually exited. */
export function runBrowserWorker(
  settings: AppSettingsData, listing: CanonicalListing, options: Options,
): Promise<{ done: BrowserReport | null; raw: string }> {
  const { marketplace, mode } = options;
  const prefix = `${marketplace.toUpperCase()}_DONE` as ReportPrefix;
  const args = ["-m", `black_cat_worker.post_${marketplace}`, "--sku", listing.sku, "--mode", mode, "--listing-stdin"];
  const input = JSON.stringify(listing);
  const logsDir = settings.logsPath || path.join(settings.dataRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logsDir, `${marketplace}-${listing.sku}.log`), { flags: "a" });
  log.on("error", () => { /* diagnostics failure must not crash a posting worker */ });
  log.write(`\n--- ${marketplace} ${mode} @ ${new Date().toISOString()} ---\n`);
  let child: ChildProcessWithoutNullStreams;
  const progress = mode === "post" ? beginUploadProgress(marketplace, listing.sku) : null;
  try {
    child = options.launch ? options.launch(args, input) : spawn(settings.pythonWorkerPath || "python", args, {
      cwd: path.join(process.cwd(), "worker"), windowsHide: true,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8",
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.cwd(), ".local", "playwright"),
        BLACKCAT_DB_PATH: dbAbsPath(), BLACKCAT_DATA_ROOT: settings.dataRoot,
        BLACKCAT_CHROME_OWNER_PID: process.env.BLACKCAT_CHROME_OWNER_PID || String(process.pid) },
    });
  } catch (error) {
    progress?.close();
    log.end();
    return Promise.resolve({ done: { outcome: "failed", submissionStarted: false,
      reason: `Could not start the browser worker: ${error instanceof Error ? error.message : String(error)}` }, raw: "" });
  }

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let stopping = false;
    const stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
    const append = (text: string) => { output += text; log.write(text); };
    const finish = () => {
      if (settled) return;
      settled = true;
      progress?.close();
      clearTimeout(timer);
      append(stdout.end() + stderr.end());
      log.end();
      resolve({ done: parseBrowserReport(output, prefix), raw: output });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
          .on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const timeout = options.timeoutMs ?? (mode === "fill" ? 35 : 8) * 60 * 1000;
    const timer = setTimeout(() => {
      append(`\n${prefix} ${JSON.stringify({ outcome: "failed", reason: `${marketplace} worker timed out` })}\n`);
      stop();
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => { if (!settled) { const text = stdout.write(chunk); progress?.feed(text); append(text); } });
    child.stderr.on("data", (chunk: Buffer) => { if (!settled) append(stderr.write(chunk)); });
    child.on("error", (error) => {
      if (settled) return;
      append(`\n${prefix} ${JSON.stringify({ outcome: "failed", reason: error.message,
        ...(!child.pid ? { submissionStarted: false } : {}) })}\n`);
      if (!child.pid) finish();
      else stop();
    });
    child.on("close", finish);
    child.stdin.on("error", () => { /* close/report provides the worker outcome */ });
    child.stdin.end(input);
  });
}
