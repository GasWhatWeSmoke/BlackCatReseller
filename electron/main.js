// Electron main process: boots the local Next.js server, opens the app window,
// lives in the system tray, and bridges native features (folder pickers,
// desktop notifications) to the renderer over IPC.
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, Notification, nativeImage, shell, clipboard, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const localVisionServer = require("./localVisionServer");
const { openEtsyChrome, openEbayChrome, openMercariChrome, openSellerChrome } = require("./openEtsyChrome");
const { crawlerDisplay, watchCrawlerDisplay } = require("./crawlerDisplay");
const { writeSaleMonitorWindow, watchSaleMonitorWindow } = require("./saleMonitorWindow");
const { assertNativeCaller, guardNavigation, copyManagedImage } = require("./nativeBoundary");
const { createChromeControl } = require("./chromeControl");
const { prepareDatabase, waitForOwnedServer, waitForDevelopmentServer } = require("./startupGuard");
const { resolveWorkerRuntime } = require("./runtimePaths");
const { createWorkerSetup } = require("./workerSetup");

const isPreview = process.env.BLACKCAT_PREVIEW === "1";
const requestedPreviewPort = Number(process.env.BLACKCAT_PREVIEW_PORT);
const PORT = 41999;
const serverPort = isPreview && Number.isInteger(requestedPreviewPort) && requestedPreviewPort >= 49152 && requestedPreviewPort <= 65535 ? requestedPreviewPort : PORT;
const URL = `http://127.0.0.1:${serverPort}`;
const isDev = !app.isPackaged && process.env.BLACKCAT_DEV === "1";
const appRoot = path.join(__dirname, "..");

let win = null;
let tray = null;
let serverProc = null;
let isQuitting = false;
let serverRestarts = 0; // consecutive unstable restarts, not a lifetime limit
let serverReadyAt = null;
let startupFailed = false;
const SERVER_STABLE_MS = 5 * 60 * 1000;
let serverRestartTimer = null;
let shutdownStarted = false;
let shutdownComplete = false;

// ---- Persistent storage location (root cause of the "history resets on boot" bug) ----
// The DB + media MUST resolve to the SAME absolute, persistent path on every launch.
// The old code fell back to an empty `userData/black-cat.db` whenever the launcher's
// env vars weren't set (e.g. a desktop shortcut straight to the exe) — so launching
// two different ways used two different databases and looked like data loss.
//
// Resolution order (first that applies):
//   1. Explicit env (set by launch.ps1) — always wins.
//   2. Source/dev run  -> the project's own data/ + var/ (where the real data lives).
//   3. Packaged app    -> a STABLE per-user folder (~/BlackCatAgent), never the
//                          throwaway Electron cache dir.
function resolvePaths() {
  const packagedBase = path.join(app.getPath("home"), "BlackCatAgent");
  const dbFile =
    (process.env.DATABASE_URL || "").replace(/^file:/, "") ||
    (app.isPackaged ? path.join(packagedBase, "data", "black-cat.db")
                    : path.join(appRoot, "data", "black-cat.db"));
  const dataRoot =
    process.env.BLACKCAT_DATA_ROOT ||
    (app.isPackaged ? path.join(packagedBase, "var") : path.join(appRoot, "var"));
  return { dbFile: path.resolve(dbFile), dataRoot: path.resolve(dataRoot) };
}

function runtimeEnvironment() {
  const { dataRoot } = resolvePaths();
  const runtime = resolveWorkerRuntime({ appRoot, dataRoot, packaged: app.isPackaged });
  return { ...process.env, ...(runtime.runtimeRoot ? { BLACKCAT_RUNTIME_ROOT: runtime.runtimeRoot } : {}),
    BLACKCAT_PYTHON: runtime.pythonPath, PLAYWRIGHT_BROWSERS_PATH: runtime.browsersPath,
    BLACKCAT_VISION_ROOT: process.env.BLACKCAT_VISION_ROOT || (runtime.runtimeRoot ? path.join(runtime.runtimeRoot, "vision") : path.join(appRoot, ".local", "vision")),
    PYTHONHOME: "", PYTHONPYCACHEPREFIX: path.join(dataRoot, "cache", "python") };
}

const workerSetup = createWorkerSetup({ getContext: () => {
  const { dataRoot } = resolvePaths(), environment = runtimeEnvironment();
  return { appRoot, dataRoot, environment, runtime: resolveWorkerRuntime({ appRoot, dataRoot, packaged: app.isPackaged, environment }) };
} });

function showStartupFailure(error) {
  startupFailed = true;
  const message = error instanceof Error ? error.message : "The local workspace could not start.";
  logLine(resolvePaths().dataRoot, `Startup stopped: ${message}`);
  const safe = message.replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
  if (win && !win.isDestroyed()) void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="background:#111722;color:#f3f6fc;font:16px system-ui;padding:48px;max-width:760px"><h1>Black Cat could not start</h1><p>${safe}</p><p>Quit Black Cat from its tray menu, resolve the reported issue, then reopen it. Your existing inventory has not been replaced.</p></body></html>`));
}

function logLine(dataRoot, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    const dir = path.join(dataRoot, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "electron.log"), line + "\n");
  } catch { /* ignore */ }
  console.log(line);
}

function startServerIfNeeded() {
  if (isDev || isQuitting) return; // the dev script runs `next dev` separately
  const { dbFile, dataRoot } = resolvePaths();
  prepareDatabase({ appRoot, dbFile, dataRoot, execPath: process.execPath,
    env: runtimeEnvironment(), log: message => logLine(dataRoot, message) });

  const logPath = path.join(dataRoot, "logs", "server.log");
  let out = "ignore";
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); out = fs.openSync(logPath, "a"); } catch { /* ignore */ }

  const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");
  serverReadyAt = null;
  try {
    serverProc = spawn(process.execPath, [
      nextBin, "start", "-H", "127.0.0.1", "-p", String(serverPort),
    ], {
      cwd: appRoot,
      env: {
        ...runtimeEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(serverPort),
        HOSTNAME: "127.0.0.1",
        DATABASE_URL: `file:${dbFile}`,           // absolute + stable -> data persists
        BLACKCAT_DATA_ROOT: dataRoot,
        BLACKCAT_CHROME_OWNER_PID: String(process.pid),
      },
      stdio: ["ignore", out, out],
    });
  } finally {
    // The child owns its inherited handle; the desktop must not leak one per restart.
    if (typeof out === "number") try { fs.closeSync(out); } catch { /* ignore */ }
  }
  const child = serverProc;
  serverProc.on("error", (e) => logLine(dataRoot, `next start failed: ${e}`));

  // Self-heal: if the Next server dies while the app is still open, the window goes
  // blank and the app *looks* broken / "forgot everything" even though the DB is fine.
  // Respawn it (capped) and reload the window so the UI comes back on its own.
  serverProc.on("exit", (code, signal) => {
    if (isQuitting || serverProc !== child) return;
    logLine(dataRoot, `next server exited unexpectedly (code=${code}, signal=${signal})`);
    if (serverReadyAt !== null && performance.now() - serverReadyAt >= SERVER_STABLE_MS) serverRestarts = 0;
    serverReadyAt = null;
    if (serverRestarts >= 5) {
      logLine(dataRoot, "giving up after 5 unstable server restarts — check var/logs/server.log");
      return;
    }
    serverRestarts++;
    serverRestartTimer = setTimeout(() => {
      serverRestartTimer = null;
      if (isQuitting) return;
      logLine(dataRoot, `restarting next server (attempt ${serverRestarts})`);
      try {
        startServerIfNeeded();
        const restarted = serverProc;
        waitForServer(URL).then(() => {
          if (!isQuitting && serverProc === restarted && restarted.exitCode === null && restarted.signalCode === null && win && !win.isDestroyed()) {
            if (startupFailed) { startupFailed = false; return win.loadURL(URL); }
            win.reload();
          }
        }).catch(error => { if (!isQuitting && serverProc === restarted) showStartupFailure(error); });
      } catch (error) { showStartupFailure(error); }
    }, 800);
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const child = serverProc;
  const wait = isDev ? waitForDevelopmentServer : waitForOwnedServer;
  return wait({ url, child, timeoutMs, requestTimeoutMs: timeoutMs, allowPreviewPort: isPreview, isCurrent: owner => serverProc === owner, isStopping: () => isQuitting })
    .then(() => {
      if (child && !isQuitting && serverProc === child && child.exitCode === null && child.signalCode === null && serverReadyAt === null) serverReadyAt = performance.now();
    });
}

const ICON_PNG = path.join(appRoot, "build", "icon.png");
const TRAY_PNG = path.join(appRoot, "build", "tray.png");

// Branded boot splash, shown the INSTANT the window opens while the local server wakes
// up. (The old flow waited for the server — up to 30s — before showing ANY window, so a
// slow start looked like the app was dead.) Inline data: URL — no file, no server needed.
const SPLASH_URL = "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html>
<html><head><style>
  html,body{margin:0;height:100%;background:#000;color:#9a9a9a;font-family:system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;user-select:none}
  .wrap{text-align:center}
  .eyes{transform-origin:center 60%;animation:blink 2.4s ease-in-out infinite}
  @keyframes blink{0%,88%,100%{transform:scaleY(1)}92%,95%{transform:scaleY(.08)}}
  .t{margin-top:14px;font-size:14px;letter-spacing:2.5px;font-weight:700;color:#fff}
  .s{margin-top:6px;font-size:12px;animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.35}}
</style></head><body><div class="wrap">
  <svg width="76" height="76" viewBox="0 0 32 32" fill="none">
    <path d="M5 13 L4 4 L12 8.5 C13.2 8.1 14.6 7.9 16 7.9 C17.4 7.9 18.8 8.1 20 8.5 L28 4 L27 13 C28.2 15 29 17.2 29 19.5 C29 26 23.2 29.5 16 29.5 C8.8 29.5 3 26 3 19.5 C3 17.2 3.8 15 5 13 Z"
      fill="#000" stroke="#b7ff2e" stroke-width="1.6" stroke-linejoin="round"/>
    <g class="eyes" fill="#b7ff2e">
      <ellipse cx="11.2" cy="18.6" rx="2.1" ry="3.1"/><ellipse cx="20.8" cy="18.6" rx="2.1" ry="3.1"/>
      <ellipse cx="11.2" cy="18.6" rx=".7" ry="2.4" fill="#000"/><ellipse cx="20.8" cy="18.6" rx=".7" ry="2.4" fill="#000"/>
    </g>
  </svg>
  <div class="t">BLACK CAT</div><div class="s">waking up…</div>
</div></body></html>`);

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const secondary = screen.getAllDisplays().find(display => display.id !== primary.id);
  if (isPreview && !secondary) throw Error("A second monitor is required for this isolated preview.");
  const area = (secondary || primary).workArea;
  const width = Math.min(1320, area.width - 32), height = Math.min(880, area.height - 32);
  win = new BrowserWindow({
    x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2),
    width, height, minWidth: Math.min(980, width), show: !isPreview,
    backgroundColor: "#000000",
    title: "Black Cat Reseller",
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  try { win.webContents.session.setSpellCheckerLanguages(["en-US"]); } catch { /* ignore */ }
  watchSaleMonitorWindow(win, open => {
    const { dataRoot } = resolvePaths();
    try { writeSaleMonitorWindow(dataRoot, open); }
    catch { logLine(dataRoot, "Could not update sale-monitor window state; automatic checks will stay paused if the state is unavailable."); }
  });
  guardNavigation(win.webContents, URL);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isPreview && /^https:\/\//i.test(url)) void openSellerChrome(url, browserDisplay());
    return { action: 'deny' };
  });
  win.loadURL(SPLASH_URL);   // instant branded splash; whenReady swaps to the app URL

  // Right-click menu. Electron ships NO context menu at all, so misspelling
  // corrections (and even plain copy/paste) never appeared — this builds one:
  // spellcheck suggestions first, then the standard edit actions.
  win.webContents.on("context-menu", (_e, params) => {
    const items = [];
    for (const s of (params.dictionarySuggestions || []).slice(0, 6)) {
      items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    }
    if (params.misspelledWord) {
      items.push({
        label: `Add "${params.misspelledWord}" to dictionary`,
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: "separator" });
    }
    if (params.isEditable) {
      items.push(
        { role: "undo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: "copy" });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Close minimizes to tray instead of quitting.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  // Black-cat tray icon (falls back to an empty image if the asset is missing).
  let trayImg = nativeImage.createEmpty();
  try {
    const p = fs.existsSync(TRAY_PNG) ? TRAY_PNG : (fs.existsSync(ICON_PNG) ? ICON_PNG : null);
    if (p) trayImg = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  } catch { /* ignore */ }
  tray = new Tray(trayImg);
  tray.setToolTip("Black Cat Reseller");
  const menu = Menu.buildFromTemplate([
    { label: "Open", click: () => { if (win) { win.show(); win.focus(); } } },
    {
      label: "Process /incoming",
      click: async () => {
        try {
          // /api/process STREAMS NDJSON progress lines; the outcome is the final
          // "done"/"error" event, not a single JSON body (res.json() would throw here).
          const res = await fetch(`${URL}/api/process`, { method: "POST" });
          const text = await res.text();
          let summary = null, error = null;
          for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const ev = JSON.parse(t);
              if (ev.type === "done") summary = ev.summary;
              else if (ev.type === "error") error = ev.error;
            } catch { /* non-JSON line */ }
          }
          const body = summary
            ? `${summary.itemsCreated} items, ${summary.problems} problems`
            : `Failed: ${error || "unknown"}`;
          new Notification({ title: "Black Cat — batch complete", body }).show();
        } catch (e) {
          new Notification({ title: "Black Cat", body: String(e) }).show();
        }
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { if (win) { win.show(); win.focus(); } });
}

// ---- IPC: native features bridged to the renderer ----
function handleNative(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertNativeCaller(event, win, URL);
    if (isPreview && /^(?:open-|chrome-connect|chrome-disconnect|setup-worker|copy-image|notify|refocus)/.test(channel)) throw Error("This isolated preview cannot start native actions.");
    return handler(event, ...args);
  });
}
handleNative("setup-worker", () => workerSetup.start());
handleNative("worker-setup-status", () => workerSetup.status());
handleNative("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
handleNative("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
});
handleNative("notify", (_e, { title, body }) => {
  new Notification({ title: title || "Black Cat", body: body || "" }).show();
  return true;
});
const browserDisplay = () => ({ display: crawlerDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id),
  environment: { ...runtimeEnvironment(), BLACKCAT_DATA_ROOT: resolvePaths().dataRoot, BLACKCAT_CHROME_OWNER_PID: String(process.pid) } });
// Comps lookups etc. follow the same second-monitor rule as marketplace windows.
handleNative("open-external", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    return openSellerChrome(url, browserDisplay());
  }
  return false;
});
handleNative("open-etsy-seller", () => openEtsyChrome(browserDisplay()));
handleNative("open-ebay-seller", () => openEbayChrome(browserDisplay()));
handleNative("open-mercari-seller", () => openMercariChrome(browserDisplay()));
let chromeControls;
const chromeConnection = () => chromeControls ??= createChromeControl({ root: appRoot,
  dataRoot: resolvePaths().dataRoot, ownerPid: process.pid, environment: runtimeEnvironment() });
handleNative("chrome-status", () => chromeConnection().status());
handleNative("chrome-connect", () => chromeConnection().command('connect'));
handleNative("chrome-disconnect", () => chromeConnection().command('disconnect'));
handleNative("open-chrome-widget", () => openSellerChrome("http://127.0.0.1:41999/browser-link", browserDisplay()));
handleNative("open-chrome-extensions", () => openSellerChrome("chrome://extensions/", browserDisplay()));
handleNative("show-chrome-extension-folder", () => shell.openPath(path.join(appRoot, 'extensions', 'marketplace-bridge')));
// Kick the window's keyboard focus. Chromium/Electron has a long-standing bug where
// closing a NATIVE JS dialog (confirm/prompt/alert) leaves the window looking focused
// but with dead keyboard input — the user's workaround was alt-tabbing out and back.
// A programmatic blur+focus is the same cure; the renderer calls this after every
// native dialog (see NativeFixes.tsx).
handleNative("refocus", () => {
  try {
    if (win && !win.isDestroyed()) { win.blur(); win.focus(); win.webContents.focus(); }
    return true;
  } catch { return false; }
});
// Copy a managed photo to the OS clipboard (the Google-Lens flow: copy, open Lens,
// Ctrl+V). Image files only; the photo never leaves the machine until the user pastes.
handleNative("copy-image", (event, p) => copyManagedImage(p, {
  origin: URL, nativeImage, clipboard,
  checkCaller: () => assertNativeCaller(event, win, URL),
}));

if (isPreview) {
  const { dbFile, dataRoot } = resolvePaths();
  if (!process.env.DATABASE_URL || !process.env.BLACKCAT_DATA_ROOT || serverPort === PORT || !path.isAbsolute(process.env.BLACKCAT_DATA_ROOT) || !path.isAbsolute(process.env.DATABASE_URL.replace(/^file:/, ''))) throw Error("A preview requires explicit isolated data, database and port paths.");
  app.setPath("userData", path.join(dataRoot, "desktop-profile"));
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(async () => {
    const { dataRoot } = resolvePaths();
    watchCrawlerDisplay(screen, dataRoot, message => logLine(dataRoot, message));
    // Clear any previous session's state before the server starts its monitor.
    writeSaleMonitorWindow(dataRoot, false);
    createWindow();
    if (isPreview) win.showInactive();
    createTray();
    try { startServerIfNeeded(); }
    catch (error) { showStartupFailure(error); return; }
    // Model loading is asynchronous: the UI and manual workflow stay available
    // while llama.cpp loads, or if the optional local assets are not installed.
    if (!isPreview) void localVisionServer.start({
      appRoot, environment: runtimeEnvironment(),
      log: (message) => logLine(dataRoot, message),
    }).catch((error) => {
      logLine(dataRoot, `local vision unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    const starting = serverProc;
    try {
      await waitForServer(URL);
      if (!isQuitting && (isDev || (serverProc === starting && starting?.exitCode === null && starting?.signalCode === null)) && win && !win.isDestroyed()) {
        await win.loadURL(URL); startupFailed = false;
      }
    } catch (error) { if (!isQuitting && serverProc === starting) showStartupFailure(error); }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (win) win.show();
    });
  });

  app.on("window-all-closed", () => { /* keep running in tray */ });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    isQuitting = true;
    if (serverRestartTimer) clearTimeout(serverRestartTimer);
    serverRestartTimer = null;
    if (serverProc) try { serverProc.kill(); } catch { /* ignore */ }
    void Promise.all([workerSetup.stop(), isPreview ? Promise.resolve() : localVisionServer.stop()]).catch((error) => {
      try {
        const { dataRoot } = resolvePaths();
        logLine(dataRoot, `local vision shutdown warning: ${error instanceof Error ? error.message : String(error)}`);
      } catch { /* ignore during shutdown */ }
    }).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { app.quit(); });
  }
  // Windows delivers Ctrl+Break as SIGBREAK, which the POSIX list above misses.
  // It is win32-only — listening for it on other platforms throws — so guard.
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => { app.quit(); });
  }
}
