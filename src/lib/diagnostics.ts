import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "./types.ts";

// Restored from the user's beta8 build. This is a local, bounded support log;
// collection never captures request bodies, headers, photos or browser profiles.
const CURRENT = "diagnostics.jsonl", PREVIOUS = "diagnostics.previous.jsonl", OPTIONS = "diagnostics-options.json";
const MAX_LOG_BYTES = 1024 * 1024;
const MARKETPLACES = ["ebay", "depop", "etsy", "mercari", "poshmark"] as const;
const KINDS = ["navigation", "request", "action", "error"];
const ACTIONS = ["chrome_connect", "chrome_disconnect", "ebay_connect", "ebay_settings_save", "marketplace_link",
  "run_start", "run_pause", "item_delete", "listing_removed", "diagnostics_export", "worker_setup", "folder_select",
  "file_select", "external_open", "photo_copy", "widget_open", "widget_settings"];
const PATH_PARTS = new Set(("api settings publish accounts account login confirm removals runs jobs retry pause resume cancel " +
  "items inventory review ready activity recovery history batches upload import import-folder photos rotate cover reorder move split " +
  "ready reidentify ai-suggestions pricing market sales setup diagnostics events export preferences chrome status connection ebay-policies listings").split(" "));
export interface DiagnosticEvent {
  at: string; kind: string; path: string; action?: string; method?: string; phase?: string;
  status?: number; durationMs?: number; message?: string;
}

export function redactDiagnosticText(value: unknown): string {
  if (typeof value !== "string") return "";
  const unescaped = value.replace(/\\+(?=["'])/g, "");
  if (/(?:authorization|auth|session(?:id)?|credentials?|cookies?|password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret)\s*["']?\s*[:=]/i.test(unescaped))
    return "[Error details containing credentials were redacted]";
  return value.replace(/(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret)\s*["']?\s*[:=]\s*[^\r\n,;}]+/gi, "[credential redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[credential redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[credential redacted]")
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, url => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.hostname}/[path redacted]`; }
      catch { return "[URL redacted]"; }
    })
    .replace(/\b[A-Z]:[\\/][^\r\n"'<>]+|\/(?:Users|home)\/[^\r\n"'<>]+/gi, "[local path redacted]")
    .replace(/\\\\[^\\\s]+\\[^\r\n"'<>]+/g, "[local path redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\d[ -]?){10,16}\b/g, "[number redacted]")
    .replace(/[\u0000-\u001f]+/g, " ").slice(0, 800);
}

export function diagnosticPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  try {
    const parts = new URL(value, "http://127.0.0.1").pathname.split("/").filter(Boolean);
    return "/" + parts.slice(0, 8).map((part, index) => PATH_PARTS.has(part) ||
      /^\d{1,10}$/.test(part) && ["items", "inventory", "runs", "jobs", "batches"].includes(parts[index - 1]) ? part : ":value").join("/");
  } catch { return "/"; }
}

export function normalizeDiagnosticEvent(value: unknown, at = new Date()): DiagnosticEvent {
  const input = value as Record<string, unknown> | null;
  if (!input || !KINDS.includes(String(input.kind))) throw new Error("Invalid diagnostic event.");
  const event: DiagnosticEvent = { at: at.toISOString(), kind: String(input.kind), path: diagnosticPath(input.path) };
  if (ACTIONS.includes(String(input.action))) event.action = String(input.action);
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(input.method))) event.method = String(input.method);
  if (["started", "completed", "failed"].includes(String(input.phase))) event.phase = String(input.phase);
  if (Number.isInteger(input.status) && Number(input.status) >= 0 && Number(input.status) <= 599) event.status = Number(input.status);
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) event.durationMs = Math.min(600_000, Math.max(0, Math.round(input.durationMs)));
  if (typeof input.message === "string") event.message = redactDiagnosticText(input.message);
  return event;
}

function logRoot(settings: Pick<AppSettingsData, "dataRoot" | "logsPath">) {
  const root = path.resolve(settings.logsPath || path.join(settings.dataRoot, "logs"));
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}
function logFile(root: string, name: string) {
  const file = path.join(root, name);
  if (path.dirname(file) !== root) throw Error("Invalid diagnostic path.");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Diagnostic file is not a regular file.");
  }
  return file;
}
function tail(file: string, bytes = MAX_LOG_BYTES): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const text = buffer.toString("utf8");
    return size > bytes ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { fs.closeSync(fd); }
}

export function diagnosticsEnabled(settings: AppSettingsData): boolean {
  const file = logFile(logRoot({ ...settings, logsPath: settings.dataRoot }), OPTIONS);
  if (!fs.existsSync(file)) return true;
  try { return fs.statSync(file).size <= 1024 && JSON.parse(fs.readFileSync(file, "utf8")).enabled === true; }
  catch { return false; }
}
export function setDiagnosticsEnabled(settings: AppSettingsData, enabled: unknown) {
  if (typeof enabled !== "boolean") throw Error("Choose whether local diagnostics are enabled.");
  fs.writeFileSync(logFile(logRoot({ ...settings, logsPath: settings.dataRoot }), OPTIONS), JSON.stringify({ enabled }), "utf8");
  return diagnosticsEnabled(settings);
}
export function recordDiagnosticEvents(settings: AppSettingsData, events: unknown): boolean {
  if (!Array.isArray(events) || events.length > 20) throw Error("Too many diagnostic events.");
  const text = events.map(event => JSON.stringify(normalizeDiagnosticEvent(event)) + "\n").join("");
  if (!diagnosticsEnabled(settings)) return false;
  const root = logRoot(settings), current = logFile(root, CURRENT), previous = logFile(root, PREVIOUS);
  if (fs.existsSync(current) && fs.statSync(current).size + Buffer.byteLength(text) > MAX_LOG_BYTES) {
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(current, previous);
  }
  fs.appendFileSync(current, text, "utf8");
  return true;
}

export async function exportDiagnostics(settings: AppSettingsData,
  db: Pick<PrismaClient, "publishJob" | "marketplaceListing" | "problemLog">) {
  const root = logRoot(settings), events: DiagnosticEvent[] = [], workerReports: Record<string, unknown>[] = [], serverErrors: string[] = [];
  for (const name of [PREVIOUS, CURRENT]) {
    const file = logFile(root, name);
    if (fs.existsSync(file)) for (const line of tail(file).split("\n")) try {
      const value = JSON.parse(line), at = new Date(value.at);
      if (Number.isFinite(at.getTime())) events.push(normalizeDiagnosticEvent(value, at));
    } catch { /* interrupted or malformed log line */ }
  }
  const reports = fs.readdirSync(root).filter(name => /^(?:ebay|depop|etsy|mercari|poshmark)-[A-Za-z0-9_-]{1,100}\.log$/.test(name))
    .flatMap(name => { try { const file = logFile(root, name); return [{ file, name, at: fs.statSync(file).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.at - a.at).slice(0, 20);
  for (const report of reports) {
    const lines = tail(report.file, 65_536).split("\n").filter(line => /^(EBAY|DEPOP|ETSY|MERCARI|POSHMARK)_DONE /.test(line));
    try {
      const line = lines.at(-1)!, value = JSON.parse(line.slice(line.indexOf(" ") + 1));
      workerReports.push({ marketplace: report.name.split("-")[0], logModifiedAt: new Date(report.at).toISOString(),
        itemRef: report.name.replace(/^[^-]+-|\.log$/g, ""),
        outcome: ["posted", "filled", "failed", "unknown"].includes(value.outcome) ? value.outcome : "unknown",
        reason: redactDiagnosticText(value.reason || value.message), submissionStarted: typeof value.submissionStarted === "boolean" ? value.submissionStarted : null });
    } catch { /* no confirmed terminal report */ }
  }
  const server = logFile(root, "server.log");
  if (fs.existsSync(server)) for (const line of tail(server, 65_536).split("\n"))
    if (/\b(?:Error:|TypeError:|RuntimeError:|ValueError:|stream failed|ECONNREFUSED|ETIMEDOUT)/i.test(line)) serverErrors.push(redactDiagnosticText(line));
  const [jobs, listings, problems] = await Promise.all([
    db.publishJob.findMany({ orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, runId: true, itemId: true, marketplace: true,
      status: true, attemptCount: true, lastError: true, errorClass: true, updatedAt: true,
      item: { select: { sku: true, department: true, itemType: true, size: true, color: true, secondaryColor: true, brand: true } } } }),
    db.marketplaceListing.findMany({ orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, itemId: true, marketplace: true,
      status: true, attemptCount: true, lastError: true, updatedAt: true, endedAt: true } }),
    db.problemLog.findMany({ orderBy: { id: "desc" }, take: 50, select: { id: true, type: true, sku: true, resolved: true } }),
  ]);
  const publish = settings.publish;
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), appVersion: JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version,
    system: { platform: process.platform, architecture: process.arch, osRelease: os.release(), memoryGiB: Math.round(os.totalmem() / 1073741824) },
    collectionEnabled: diagnosticsEnabled(settings), settings: {
      marketplaces: MARKETPLACES.map(marketplace => ({ marketplace, enabled: (marketplace === "ebay" ? publish?.ebayBrowser : publish?.[marketplace])?.enabled === true })),
      ebayPolicies: Object.fromEntries((["shippingPolicyName", "returnPolicyName", "paymentPolicyName"] as const).map(name => [name, redactDiagnosticText(publish?.ebayBrowser?.[name])])),
      autoRunEnabled: publish?.autoRun?.enabled === true, visionEnabled: settings.visionEnabled === true,
      workerPathExists: !!settings.pythonWorkerPath && fs.existsSync(settings.pythonWorkerPath),
      depopFillCheckOnly: publish?.depop?.autoPost === false, ebayFillCheckOnly: publish?.ebayBrowser?.autoPost === false,
    }, events: events.slice(-1000), workerReports, serverErrors: serverErrors.slice(-30),
    jobs: jobs.map(({ item, ...job }) => ({ ...job, lastError: redactDiagnosticText(job.lastError),
      reviewedFields: Object.fromEntries(Object.entries(item ?? {}).map(([field, value]) => [field, redactDiagnosticText(value)])) })),
    listings: listings.map(listing => ({ ...listing, lastError: redactDiagnosticText(listing.lastError) })),
    problems: problems.map(problem => ({ ...problem, type: redactDiagnosticText(problem.type), sku: redactDiagnosticText(problem.sku) })),
    contents: "Local app events, recent posting outcomes and error summaries. UI actions are attempts; HTTP completion does not confirm marketplace publication. No database file, photos, cookies, request bodies, headers or browser profiles are included.",
  };
}
