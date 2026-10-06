import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AppSettingsData } from "../types.ts";
import { dbAbsPath } from "../worker.ts";
import { parseSalesReport, SALES_MARKETPLACES, validReceiptId, type SalesMarketplace, type SalesReport } from "./salesProtocol.ts";

interface Options {
  timeoutMs?: number;
  launch?: (args: string[], input: string) => ChildProcessWithoutNullStreams;
}
const failed = (reason: string): SalesReport => ({ ok: false, complete: false, observations: [], confirmedReceiptIds: [], reason });

/** Read-only worker. The caller keeps the shared browser claim until close. */
export function runSalesWorker(settings: AppSettingsData, marketplace: SalesMarketplace, knownReceipts: string[], options: Options = {}): Promise<SalesReport> {
  if (!SALES_MARKETPLACES.includes(marketplace) || !Array.isArray(knownReceipts) || knownReceipts.length > 10000 ||
      knownReceipts.some((id) => !validReceiptId(marketplace, id))) return Promise.resolve(failed("Invalid sales scan request."));
  const args = ["-m", `black_cat_worker.${marketplace}_sales`, ...(marketplace === "depop"
    ? ["--scan", "--max-receipts", "100", "--known-confirmed-receipts-stdin"] : [])];
  const input = JSON.stringify({ receiptIds: knownReceipts });
  const logsDir = settings.logsPath || path.join(settings.dataRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logsDir, `${marketplace}-sales.log`), { flags: "a" });
  log.on("error", () => { /* Diagnostic storage does not certify a scan. */ });
  log.write(`\n--- sales scan @ ${new Date().toISOString()} ---\n`);
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
    return Promise.resolve(failed(`Could not start sales scan: ${error instanceof Error ? error.message : String(error)}`));
  }
  return new Promise((resolve) => {
    let output = "", settled = false, stopping = false, errorMessage: string | null = null;
    const stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const tail = stdout.end(); output += tail;
      log.write(tail + stderr.end()); log.end();
      resolve(errorMessage ? failed(errorMessage) : parseSalesReport(output, marketplace) ?? failed("Sales scan exited without a valid receipt report."));
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { errorMessage = "Sales scan timed out; coverage is unverified."; stop(); }, options.timeoutMs ?? 5 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || errorMessage) return;
      const text = stdout.write(chunk); output += text; log.write(text);
      if (output.length > 8_000_000) { errorMessage = "Sales scan exceeded its report size limit."; stop(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (!settled) log.write(stderr.write(chunk)); });
    child.on("error", (error) => {
      if (settled) return;
      errorMessage = error.message;
      if (!child.pid) finish(); else stop();
    });
    child.on("close", finish);
    child.stdin.on("error", () => { /* Wait for the worker's final result. */ });
    child.stdin.end(input);
  });
}
