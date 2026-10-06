import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettingsData } from "../types.ts";
import { workerPythonExists } from "../worker.ts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "../browserCoordinator.ts";
import { MARKETPLACE_NAMES, type BrowserMarketplace } from "./platforms.ts";

const active = new Map<BrowserMarketplace, ChildProcessWithoutNullStreams>();
const errors = new Map<BrowserMarketplace, string>();
export const browserLoginInProgress = (marketplace: BrowserMarketplace) => active.has(marketplace);
const marker = (settings: AppSettingsData, marketplace: BrowserMarketplace, kind: "ok" | "pending") =>
  path.join(settings.dataRoot, `${marketplace}-login-${kind}.json`);

export function browserAccountStatus(settings: AppSettingsData, marketplace: BrowserMarketplace) {
  let refreshedAt: string | null = null;
  try { refreshedAt = fs.statSync(marker(settings, marketplace, "ok")).mtime.toISOString(); } catch { /* not linked */ }
  return {
    marketplace, name: MARKETPLACE_NAMES[marketplace], loggedIn: refreshedAt != null, refreshedAt,
    loginInProgress: active.has(marketplace), awaitingConfirmation: fs.existsSync(marker(settings, marketplace, "pending")),
    error: errors.get(marketplace) ?? null,
  };
}

/** Login runs without an attached debugger. Hold the shared browser claim until
 *  the child exits so publishing cannot collide with the operator's login. */
export function startBrowserAccountLogin(
  settings: AppSettingsData, marketplace: BrowserMarketplace,
  launch?: () => ChildProcessWithoutNullStreams,
): { ok: boolean; error?: string } {
  if (active.has(marketplace)) return { ok: false, error: `${MARKETPLACE_NAMES[marketplace]} login is already open.` };
  if (!workerPythonExists(settings)) return { ok: false, error: "The browser worker is not installed. Run worker setup first." };
  if (!claimBrowser(`${MARKETPLACE_NAMES[marketplace]} login`)) return { ok: false, error: browserBusyMessage() };
  let log: fs.WriteStream | undefined;
  try {
    fs.mkdirSync(settings.dataRoot, { recursive: true });
    const logs = settings.logsPath || path.join(settings.dataRoot, "logs");
    fs.mkdirSync(logs, { recursive: true });
    for (const kind of ["ok", "pending"] as const) {
      fs.rmSync(marker(settings, marketplace, kind), { force: true });
    }
    errors.delete(marketplace);
    log = fs.createWriteStream(path.join(logs, `${marketplace}-login.log`), { flags: "a" });
    log.on("error", () => { /* login still works if diagnostics cannot be written */ });
    const child = launch ? launch() : spawn(settings.pythonWorkerPath || "python", [
      "-m", "black_cat_worker.marketplace_login", "--marketplace", marketplace, "--data-root", settings.dataRoot,
    ], { cwd: path.join(process.cwd(), "worker"), windowsHide: true,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8" } });
    active.set(marketplace, child);
    let output = "";
    let childError = false;
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-32000);
      log?.write(text);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => {
      childError = true;
      errors.set(marketplace, `Could not open ${MARKETPLACE_NAMES[marketplace]}: ${error.message}`);
      // Spawn errors have no running process. Other errors retain the claim
      // until close, since a browser could still be open.
      if (!child.pid) finish(false);
    });
    const finish = (closed: boolean) => {
      if (active.get(marketplace) !== child) return;
      if (closed) {
        try { fs.writeFileSync(marker(settings, marketplace, "pending"), JSON.stringify({ at: new Date().toISOString() })); }
        catch { errors.set(marketplace, "Could not save the login handoff. Reopen the login window and try again."); }
      }
      active.delete(marketplace);
      releaseBrowser();
      log?.end();
    };
    child.on("close", (code) => {
      const closed = !childError && code === 0 && /^MARKETPLACE_LOGIN_DONE window-closed\r?$/m.test(output);
      if (!closed && !errors.has(marketplace)) errors.set(marketplace, `The ${MARKETPLACE_NAMES[marketplace]} login window did not finish normally. Close any older login window and try again.`);
      finish(closed);
    });
    return { ok: true };
  } catch (error) {
    log?.end();
    releaseBrowser();
    const message = error instanceof Error ? error.message : "Could not open the login window.";
    errors.set(marketplace, message);
    return { ok: false, error: message };
  }
}

export function confirmBrowserAccountLogin(settings: AppSettingsData, marketplace: BrowserMarketplace): { ok: boolean; error?: string } {
  if (active.has(marketplace)) return { ok: false, error: "Close the marketplace Chrome window before confirming." };
  if (!fs.existsSync(marker(settings, marketplace, "pending"))) return { ok: false, error: "Open the login window and finish signing in before confirming." };
  try {
    fs.writeFileSync(marker(settings, marketplace, "ok"), JSON.stringify({ at: new Date().toISOString() }));
    fs.rmSync(marker(settings, marketplace, "pending"), { force: true });
    errors.delete(marketplace);
    return { ok: true };
  } catch { return { ok: false, error: "Could not save the account confirmation." }; }
}
