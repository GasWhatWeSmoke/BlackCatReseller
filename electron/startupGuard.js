"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { execFile, spawnSync } = require("node:child_process");

function startupError(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkedPreparation(result, operation) {
  if (!result || result.error || result.signal || result.status !== 0) {
    throw startupError("DATABASE_PREPARATION_FAILED", `${operation} did not finish successfully. Your existing inventory was not replaced. Check the startup log before trying again.`);
  }
}

/** Never expose a partly seeded template as the user's permanent database. */
function prepareDatabase({ appRoot, dbFile, dataRoot, execPath, env = process.env, log = () => {},
  fsImpl = fs, spawnSyncImpl = spawnSync }) {
  fsImpl.mkdirSync(path.dirname(dbFile), { recursive: true });
  fsImpl.mkdirSync(dataRoot, { recursive: true });
  const run = (script, database, timeout) => {
    const result = spawnSyncImpl(execPath, [path.join(appRoot, "scripts", script)], {
      cwd: appRoot, windowsHide: true, timeout, encoding: "utf8",
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", DATABASE_URL: `file:${database}`, BLACKCAT_DATA_ROOT: dataRoot },
    });
    const output = `${result?.stdout || ""}${result?.stderr || ""}`.trim();
    if (output) for (const line of output.split(/\r?\n/)) log(line);
    if (result?.error) log(`${script}: ${result.error.message || "Could not start the database preparation process."}`);
    if (result?.signal) log(`${script}: preparation stopped (${result.signal}).`);
    checkedPreparation(result, script === "init-db.mjs" ? "First-run database setup" : "Database compatibility check");
  };
  if (fsImpl.existsSync(dbFile)) {
    run("schema-sync.mjs", dbFile, 120000);
    return { created: false };
  }
  const template = path.join(appRoot, "config", "template.db");
  if (!fsImpl.existsSync(template)) throw startupError("DATABASE_TEMPLATE_MISSING", "This download is missing its database template. Extract or reinstall the complete Black Cat download before starting.");
  const stage = path.join(path.dirname(dbFile), `.blackcat-first-run-${randomUUID()}.db`);
  try {
    fsImpl.copyFileSync(template, stage, fs.constants.COPYFILE_EXCL);
    run("init-db.mjs", stage, 60000);
    // A successful seed must close/checkpoint SQLite before its main file moves.
    if (fsImpl.existsSync(`${stage}-wal`) && fsImpl.statSync(`${stage}-wal`).size > 0) {
      throw startupError("DATABASE_PREPARATION_FAILED", "First-run database setup has unfinished changes. Close Black Cat and retry; no existing inventory was replaced.");
    }
    // Same-directory hard linking is atomic and fails if another startup created
    // the destination. Unlike rename/copy it cannot replace or expose a partial DB.
    fsImpl.linkSync(stage, dbFile);
    log("First-run database setup completed.");
    return { created: true };
  } finally {
    for (const file of [stage, `${stage}-wal`, `${stage}-shm`]) {
      try { fsImpl.unlinkSync(file); } catch { /* Only this attempt's files; never the user's DB. */ }
    }
  }
}

function listenerPid(output, host, port) {
  const owners = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" || fields[3].toUpperCase() !== "LISTENING") continue;
    const endpoint = /^(.*):(\d+)$/.exec(fields[1]);
    if (!endpoint || Number(endpoint[2]) !== port) continue;
    const address = endpoint[1].replace(/^\[(.*)\]$/, "$1");
    if (address !== host || !/^\d+$/.test(fields[4]) || Number(fields[4]) <= 0) {
      throw startupError("SERVER_PORT_UNOWNED", `Another listener occupies Black Cat's port ${port}. Close the conflicting program and retry.`);
    }
    owners.add(Number(fields[4]));
  }
  if (owners.size > 1) throw startupError("SERVER_PORT_UNOWNED", `Black Cat's port ${port} has more than one owner. Close the conflicting program and retry.`);
  return owners.size ? [...owners][0] : null;
}

function findWindowsListener(host, port) {
  if (process.platform !== "win32") return Promise.reject(startupError("SERVER_PLATFORM_UNSUPPORTED", "The desktop startup check requires Windows."));
  return new Promise((resolve, reject) => {
    execFile("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
      if (error) { reject(startupError("SERVER_OWNERSHIP_UNAVAILABLE", "Black Cat could not verify its local server. Close the app and retry.")); return; }
      try { resolve(listenerPid(output, host, port)); } catch (failure) { reject(failure); }
    });
  });
}

function waitForServer({ url, child, isCurrent = () => true, isStopping = () => false,
  timeoutMs = 30000, requestTimeoutMs = 5000, httpGet = http.get, findListener = findWindowsListener,
  timers = { setTimeout, clearTimeout }, development = false, allowPreviewPort = false }) {
  const address = new URL(url);
  const previewOrigin = allowPreviewPort === true && address.protocol === "http:" && address.hostname === "127.0.0.1" &&
    Number(address.port) >= 49152 && Number(address.port) <= 65535;
  if (address.username || address.password || (address.origin !== "http://127.0.0.1:41999" && !previewOrigin)) {
    return Promise.reject(startupError("SERVER_ORIGIN_INVALID", "Black Cat requires its fixed local server address or an explicitly isolated preview port."));
  }
  return new Promise((resolve, reject) => {
    let settled = false, request = null, retryTimer = null, requestTimer = null, deadline = null;
    const current = () => !isStopping() && (development || (child && Number.isSafeInteger(child.pid) && child.pid > 0 &&
      child.exitCode === null && child.signalCode === null && !child.killed && isCurrent(child)));
    const clearRequest = () => {
      if (requestTimer !== null) timers.clearTimeout(requestTimer);
      requestTimer = null;
      if (request) { request.on("error", () => {}); request.destroy(); }
      request = null;
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      if (deadline !== null) timers.clearTimeout(deadline);
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      clearRequest();
      child?.removeListener("exit", stopped);
      child?.removeListener("error", stopped);
      if (error) reject(error); else resolve();
    };
    const stopped = () => finish(startupError("SERVER_PROCESS_EXITED", "Black Cat's local server stopped before it was ready. Check the startup log and retry."));
    const checkCurrent = () => { if (current()) return true; stopped(); return false; };
    const attempt = () => {
      retryTimer = null;
      if (settled || !checkCurrent()) return;
      try {
        let receivedResponse = false;
        const active = httpGet(url, response => {
          if (settled || request !== active) { response.destroy(); return; }
          receivedResponse = true;
          if (requestTimer !== null) timers.clearTimeout(requestTimer);
          requestTimer = null;
          const status = response.statusCode;
          response.destroy();
          if (!checkCurrent()) return;
          if (!Number.isInteger(status) || status < 200 || status >= 300) {
            finish(startupError("SERVER_RESPONSE_INVALID", `Black Cat's local server returned HTTP ${status || "unknown"}. Check the startup log and retry.`));
            return;
          }
          if (development) { finish(); return; }
          Promise.resolve().then(() => findListener(address.hostname, Number(address.port))).then(owner => {
            if (settled || !checkCurrent()) return;
            if (owner !== child.pid) finish(startupError("SERVER_PORT_UNOWNED", "Black Cat's local address belongs to another process. Close the conflicting program and retry."));
            else finish();
          }, error => finish(error));
        });
        request = active;
        active.once("error", error => {
          if (settled || receivedResponse) return;
          clearRequest();
          if (!checkCurrent()) return;
          if (!["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code)) { finish(error); return; }
          retryTimer = timers.setTimeout(attempt, 400);
        });
        requestTimer = timers.setTimeout(() => finish(startupError("SERVER_REQUEST_TIMEOUT", "Black Cat's local server did not respond in time. Close the app and retry.")), requestTimeoutMs);
      } catch (error) { finish(error); }
    };
    if (!checkCurrent()) return;
    child?.once("exit", stopped);
    child?.once("error", stopped);
    deadline = timers.setTimeout(() => finish(startupError("SERVER_STARTUP_TIMEOUT", "Black Cat's local server did not start in time. Check the startup log and retry.")), timeoutMs);
    attempt();
  });
}

function waitForOwnedServer(options) { return waitForServer({ ...options, development: false }); }
function waitForDevelopmentServer(options) { return waitForServer({ ...options, child: null, development: true }); }

module.exports = { prepareDatabase, checkedPreparation, listenerPid, waitForOwnedServer, waitForDevelopmentServer };
