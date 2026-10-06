"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { commandLineHasExactArgv, parseWindowsCommandLine } = require("./windowsCommandLine.js");
const { resolveVisionAssetRoot } = require("./runtimePaths.js");

const OWNER = "blackcat-reseller";
const RECEIPT_KIND = "blackcat-local-vision-server";
const RECEIPT_SCHEMA_VERSION = 1;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;
const ACTIVE_RECEIPT_STATES = new Set(["starting", "running", "restarting"]);
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVED_ARGUMENTS = Object.freeze([
  "-ngl", "all", "-c", "8192", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0",
  "--parallel", "1", "-b", "512", "-ub", "256", "-t", "12", "--reasoning", "off",
  "--image-min-tokens", "1024", "--image-max-tokens", "1024", "--cache-ram", "0",
  "--cors-origins", "http://127.0.0.1", "--no-cors-credentials",
  "--offline", "--no-webui", "-lv", "4",
]);

class LocalVisionServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalVisionServerError";
    this.code = code;
  }
}

function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
}

function relativePortable(base, value) {
  return path.relative(base, value).replaceAll("\\", "/");
}

function resolveContained(base, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new LocalVisionServerError("INVALID_CONFIG", `${label} must be a relative path`);
  }
  const root = path.resolve(base);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new LocalVisionServerError("INVALID_CONFIG", `${label} escapes its allowed root`);
  }
  return resolved;
}

function runtimeFileInventory(runtimeDirectory) {
  const root = path.resolve(runtimeDirectory);
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { rootStat = null; }
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new LocalVisionServerError("SETUP_REQUIRED", `Local vision runtime directory is invalid: ${root}`);
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new LocalVisionServerError("SETUP_REQUIRED", `Local vision runtime contains a link: ${absolute}`);
      }
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        files.push({
          name: relativePortable(root, absolute),
          absolute,
          size: stat.size,
          sha256: sha256File(absolute),
        });
      } else {
        throw new LocalVisionServerError("SETUP_REQUIRED", `Unsupported local vision runtime entry: ${absolute}`);
      }
    }
  };
  try {
    visit(root);
  } catch (error) {
    if (error instanceof LocalVisionServerError) throw error;
    throw new LocalVisionServerError("SETUP_REQUIRED", `Could not inventory local vision runtime (${error.message})`);
  }
  if (files.length === 0) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "Local vision runtime directory is empty");
  }
  return files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isBoundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isValidTimestamp(value) {
  return isBoundedString(value, 128) && Number.isFinite(Date.parse(value));
}

function readJson(filename, maxBytes = 256 * 1024) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid JSON file: ${filename}`);
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!isPlainObject(value)) throw new Error(`Invalid JSON object: ${filename}`);
  return value;
}

function writeJsonAtomic(filename, value) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const backup = `${filename}.${process.pid}.${crypto.randomUUID()}.bak`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  let backedUp = false;
  try {
    if (fs.existsSync(filename)) {
      fs.renameSync(filename, backup);
      backedUp = true;
    }
    fs.renameSync(temporary, filename);
    if (backedUp) fs.unlinkSync(backup);
  } catch (error) {
    try {
      if (backedUp && !fs.existsSync(filename) && fs.existsSync(backup)) fs.renameSync(backup, filename);
    } catch { /* keep the original error */ }
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already moved or absent */ }
  }
}

function assertManifest(config) {
  if (!isPlainObject(config) || config.schemaVersion !== 1) {
    throw new LocalVisionServerError("INVALID_CONFIG", "Unsupported local vision manifest");
  }
  if (config.assetRoot !== ".local/vision" || config.runtime?.id !== "llama-b10218-win-cuda-13.3-x64" ||
      config.runtime?.releaseTag !== "b10218" || config.runtime?.cudaVersion !== "13.3" ||
      config.runtime?.executable !== "llama-server.exe") {
    throw new LocalVisionServerError("INVALID_CONFIG", "The local vision runtime pin has drifted");
  }
  if (config.model?.id !== "qwen3.5-4b-q4-k-m" ||
      config.model?.revision !== "f9f88ac3e234be915e23811a6d28ea287bdb927e" ||
      config.model?.weights?.sha256 !== "25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c" ||
      config.model?.projector?.sha256 !== "ae08d9d7eceb8f2d0672d61b5e6aa78b611f2942b55ed71d21414980cc454b91") {
    throw new LocalVisionServerError("INVALID_CONFIG", "The local vision model pin has drifted");
  }
  if (config.server?.host !== "127.0.0.1" || config.server?.port !== 1235 ||
      config.server?.alias !== "blackcat-vision" || config.server?.apiKeyFile !== "api-key.txt" ||
      config.server?.maxRestarts !== 1) {
    throw new LocalVisionServerError("INVALID_CONFIG", "The local vision server contract has drifted");
  }
  if (!Array.isArray(config.server.arguments) ||
      config.server.arguments.length !== APPROVED_ARGUMENTS.length ||
      config.server.arguments.some((value, index) => value !== APPROVED_ARGUMENTS[index])) {
    throw new LocalVisionServerError("INVALID_CONFIG", "The local vision arguments are not approved");
  }
  for (const [key, minimum, maximum] of [
    ["startupTimeoutMs", 1_000, 600_000],
    ["shutdownTimeoutMs", 1_000, 60_000],
    ["healthPollMs", 100, 10_000],
  ]) {
    const value = config.server[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new LocalVisionServerError("INVALID_CONFIG", `Invalid server.${key}`);
    }
  }
  if (!isPlainObject(config.receipts)) {
    throw new LocalVisionServerError("INVALID_CONFIG", "Missing local vision receipt paths");
  }
}

function loadContext(appRoot, configPath, environment = process.env) {
  const root = path.resolve(appRoot);
  const manifestPath = path.resolve(configPath || path.join(root, "config", "local-vision.json"));
  const manifestBytes = fs.readFileSync(manifestPath);
  const config = JSON.parse(manifestBytes.toString("utf8"));
  assertManifest(config);
  const assetRoot = resolveVisionAssetRoot(root, environment);
  const runtimeDirectory = resolveContained(assetRoot, config.runtime.directory, "runtime.directory");
  const modelDirectory = resolveContained(assetRoot, config.model.directory, "model.directory");
  const executable = resolveContained(runtimeDirectory, config.runtime.executable, "runtime.executable");
  const weights = resolveContained(modelDirectory, config.model.weights.name, "model.weights.name");
  const projector = resolveContained(modelDirectory, config.model.projector.name, "model.projector.name");
  const apiKeyFile = resolveContained(assetRoot, config.server.apiKeyFile, "server.apiKeyFile");
  const setupReceipt = resolveContained(assetRoot, config.receipts.setup, "receipts.setup");
  const stateReceipt = resolveContained(assetRoot, config.receipts.state, "receipts.state");
  const log = resolveContained(assetRoot, config.receipts.log, "receipts.log");
  return {
    root,
    manifestPath,
    config,
    configSha256: sha256Bytes(manifestBytes),
    assetRoot,
    runtimeDirectory,
    modelDirectory,
    executable,
    weights,
    projector,
    apiKeyFile,
    setupReceipt,
    stateReceipt,
    log,
    endpoint: `http://${config.server.host}:${config.server.port}`,
  };
}

function verifySetupReceipt(context) {
  let receipt;
  try {
    receipt = readJson(context.setupReceipt);
  } catch (error) {
    throw new LocalVisionServerError(
      "SETUP_REQUIRED",
      `Run scripts/setup-local-vision.ps1 before starting vision (${error.message})`,
    );
  }
  const { config } = context;
  if (receipt.schemaVersion !== 1 || receipt.kind !== "blackcat-local-vision-setup" ||
      receipt.configSha256 !== context.configSha256 || receipt.runtime?.id !== config.runtime.id ||
      receipt.model?.id !== config.model.id || receipt.server?.host !== config.server.host ||
      receipt.server?.port !== config.server.port || receipt.server?.alias !== config.server.alias ||
      normalizePath(receipt.assetRoot) !== normalizePath(context.assetRoot) ||
      receipt.runtime?.executable !== relativePortable(context.assetRoot, context.executable) ||
      receipt.model?.weights !== relativePortable(context.assetRoot, context.weights) ||
      receipt.model?.projector !== relativePortable(context.assetRoot, context.projector)) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "Local vision setup receipt does not match the manifest");
  }
  if (receipt.server?.apiKeyFile !== relativePortable(context.assetRoot, context.apiKeyFile) ||
      !/^[0-9a-f]{64}$/.test(receipt.server?.apiKeySha256 || "")) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "Local vision API credential receipt is invalid");
  }
  let apiKeyText;
  try {
    apiKeyText = fs.readFileSync(context.apiKeyFile, "utf8");
  } catch (error) {
    throw new LocalVisionServerError("SETUP_REQUIRED", `Missing local vision API credential (${error.message})`);
  }
  if (!/^[0-9a-f]{64}\n$/.test(apiKeyText) ||
      sha256File(context.apiKeyFile) !== receipt.server.apiKeySha256) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "Local vision API credential differs from setup receipt");
  }
  for (const [filename, expectedSize] of [
    [context.weights, config.model.weights.size],
    [context.projector, config.model.projector.size],
  ]) {
    let stat;
    try { stat = fs.statSync(filename); } catch { stat = null; }
    if (!stat?.isFile() || stat.size !== expectedSize) {
      throw new LocalVisionServerError("SETUP_REQUIRED", `Missing or truncated local vision asset: ${filename}`);
    }
  }
  if (!Array.isArray(receipt.runtime?.files) || receipt.runtime.files.length === 0) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "Setup receipt has no runtime file inventory");
  }
  const recordedRuntimeFiles = new Map();
  for (const entry of receipt.runtime.files) {
    if (!isPlainObject(entry) || !isBoundedString(entry.name, 32 * 1024) ||
        entry.name.includes("\\") || path.isAbsolute(entry.name) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
      throw new LocalVisionServerError("SETUP_REQUIRED", "Setup receipt has an invalid runtime file entry");
    }
    let absolute;
    try {
      absolute = resolveContained(context.runtimeDirectory, entry.name, "runtime receipt file");
    } catch {
      throw new LocalVisionServerError("SETUP_REQUIRED", `Runtime receipt path escapes its directory: ${entry.name}`);
    }
    if (relativePortable(context.runtimeDirectory, absolute) !== entry.name) {
      throw new LocalVisionServerError("SETUP_REQUIRED", `Runtime receipt path is not canonical: ${entry.name}`);
    }
    const identity = normalizePath(absolute);
    if (recordedRuntimeFiles.has(identity)) {
      throw new LocalVisionServerError("SETUP_REQUIRED", `Duplicate runtime receipt path: ${entry.name}`);
    }
    recordedRuntimeFiles.set(identity, { ...entry, absolute });
  }

  const actualRuntimeFiles = runtimeFileInventory(context.runtimeDirectory);
  if (actualRuntimeFiles.length !== recordedRuntimeFiles.size) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "Local vision runtime file set differs from setup receipt");
  }
  for (const actual of actualRuntimeFiles) {
    const recorded = recordedRuntimeFiles.get(normalizePath(actual.absolute));
    if (!recorded || recorded.name !== actual.name || recorded.size !== actual.size ||
        recorded.sha256 !== actual.sha256) {
      throw new LocalVisionServerError(
        "SETUP_REQUIRED",
        `Missing, extra, or corrupt local vision runtime file: ${actual.absolute}`,
      );
    }
  }
  const executableSha256 = sha256File(context.executable);
  if (!/^[0-9a-f]{64}$/.test(receipt.runtime.executableSha256 || "") ||
      executableSha256 !== receipt.runtime.executableSha256) {
    throw new LocalVisionServerError("SETUP_REQUIRED", "llama-server.exe differs from the verified setup receipt");
  }
  const artifacts = new Map(Array.isArray(receipt.artifacts)
    ? receipt.artifacts.map((entry) => [entry?.name, entry]) : []);
  for (const artifact of [...config.runtime.archives, config.model.weights, config.model.projector]) {
    const recorded = artifacts.get(artifact.name);
    if (!recorded || recorded.sha256 !== artifact.sha256 || recorded.size !== artifact.size) {
      throw new LocalVisionServerError("SETUP_REQUIRED", `Setup receipt is missing ${artifact.name}`);
    }
  }
  return { receipt, executableSha256 };
}

function execFileText(executable, args, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function inspectWindowsProcess(pid) {
  if (process.platform !== "win32") {
    throw new LocalVisionServerError("UNSUPPORTED_PLATFORM", "Pinned local vision runtime requires Windows");
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "$created = $p.CreationDate.ToUniversalTime().ToString('o')",
    "[ordered]@{ pid = [int]$p.ProcessId; executablePath = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine; creationTime = $created } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    return JSON.parse(await execFileText("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ]));
  } catch (error) {
    if (error.code === 3) return null;
    throw error;
  }
}

function parseNetstatListeners(output, port) {
  const listeners = [];
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" ||
        fields[3].toUpperCase() !== "LISTENING" || !/^\d+$/.test(fields[4])) continue;
    const endpoint = fields[1];
    const match = endpoint.match(/^(.*):(\d+)$/);
    if (!match || Number(match[2]) !== port) continue;
    const address = match[1].replace(/^\[(.*)\]$/, "$1").toLowerCase();
    listeners.push({ address, pid: Number(fields[4]) });
  }
  return listeners;
}

function selectListenerPid(listeners, host, port) {
  if (!Array.isArray(listeners) || listeners.length === 0) return null;
  const wantedHost = String(host).toLowerCase();
  const foreignBind = listeners.find((listener) => listener.address !== wantedHost);
  if (foreignBind) {
    throw new LocalVisionServerError(
      "PORT_IN_USE_UNOWNED",
      `Port ${port} is already listening on ${foreignBind.address} (PID ${foreignBind.pid})`,
    );
  }
  const pids = new Set(listeners.map((listener) => listener.pid));
  if (pids.size > 1) {
    throw new LocalVisionServerError("PORT_OWNERSHIP_AMBIGUOUS", `Multiple listeners claim ${host}:${port}`);
  }
  return [...pids][0];
}

function isPortOwnershipError(error) {
  return error?.code === "PORT_IN_USE_UNOWNED" || error?.code === "PORT_OWNERSHIP_AMBIGUOUS";
}

async function findWindowsListenerPid(host, port) {
  if (process.platform !== "win32") {
    throw new LocalVisionServerError("UNSUPPORTED_PLATFORM", "Pinned local vision runtime requires Windows");
  }
  const output = await execFileText("netstat.exe", ["-ano", "-p", "tcp"]);
  return selectListenerPid(parseNetstatListeners(output, port), host, port);
}

function defaultKillProcess(pid) {
  process.kill(pid, "SIGTERM");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandFingerprint(executable, args) {
  return sha256Bytes(JSON.stringify({ executable: path.resolve(executable), args }));
}

function sanitizedLlamaEnvironment(environment = process.env) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!/^LLAMA_/i.test(name)) sanitized[name] = value;
  }
  return sanitized;
}

function buildArguments(context) {
  const { config } = context;
  return [
    "-m", context.weights,
    "--mmproj", context.projector,
    "--alias", config.server.alias,
    "--host", config.server.host,
    "--port", String(config.server.port),
    "--api-key-file", context.apiKeyFile,
    ...config.server.arguments,
    "--log-file", context.log,
  ];
}

function expectedCommandArgv(context) {
  return [context.executable, ...buildArguments(context)];
}

function commandLineMatchesPinnedArgv(commandLine, context) {
  return commandLineHasExactArgv(commandLine, expectedCommandArgv(context));
}

function fingerprintCommandLine(commandLine, context) {
  if (!commandLineMatchesPinnedArgv(commandLine, context)) return null;
  const argv = parseWindowsCommandLine(commandLine);
  return commandFingerprint(argv[0], argv.slice(1));
}

async function probeServer(context, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const apiKey = fs.readFileSync(context.apiKeyFile, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(apiKey)) return false;
    const options = {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    };
    const health = await fetchImpl(`${context.endpoint}/health`, options);
    if (!health.ok) return false;
    const healthBody = await health.json().catch(() => null);
    if (healthBody?.status !== "ok") return false;
    const models = await fetchImpl(`${context.endpoint}/v1/models`, options);
    if (!models.ok) return false;
    const body = await models.json().catch(() => null);
    return Array.isArray(body?.data) && body.data.length === 1 &&
      body.data[0]?.id === context.config.server.alias;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function publicState(state) {
  return Object.freeze({
    state: state.state,
    pid: state.pid,
    adopted: state.adopted,
    restartCount: state.restartCount,
    endpoint: state.endpoint,
    alias: state.alias,
    error: state.error,
    updatedAt: state.updatedAt,
  });
}

class LocalVisionSupervisor {
  constructor(options = {}) {
    this.appRoot = path.resolve(options.appRoot || path.join(__dirname, ".."));
    this.configPath = options.configPath ? path.resolve(options.configPath) : null;
    this.environment = { ...(options.environment || process.env) };
    this.logFn = typeof options.log === "function" ? options.log : () => {};
    this.spawnImpl = options.spawnImpl || spawn;
    this.inspectProcess = options.inspectProcess || inspectWindowsProcess;
    this.findListenerPid = options.findListenerPid || findWindowsListenerPid;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.killProcess = options.killProcess || defaultKillProcess;
    this.sleep = options.sleep || delay;
    this.verifySetup = options.verifySetup || verifySetupReceipt;
    this.monitorEnabled = options.monitorEnabled !== false;
    this.listeners = new Set();
    this.context = null;
    this.child = null;
    this.identity = null;
    this.instanceId = null;
    this.desiredRunning = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.restartPromise = null;
    this.monitor = null;
    this.monitorBusy = false;
    this.healthFailures = 0;
    this.state = {
      state: "idle",
      pid: null,
      adopted: false,
      restartCount: 0,
      endpoint: null,
      alias: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }

  setLog(log) {
    if (typeof log === "function") this.logFn = log;
  }

  getState() {
    return publicState(this.state);
  }

  onState(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _log(message) {
    const line = `LOCAL-VISION ${message}`;
    try { this.logFn(line); } catch { /* logging cannot own lifecycle */ }
  }

  _readStateReceipt() {
    if (!this.context || !fs.existsSync(this.context.stateReceipt)) return null;
    try { return readJson(this.context.stateReceipt); } catch { return null; }
  }

  _receiptForState() {
    const identity = this.identity;
    return {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      kind: RECEIPT_KIND,
      owner: OWNER,
      configSha256: this.context?.configSha256 || null,
      instanceId: this.instanceId,
      state: this.state.state,
      pid: this.state.pid,
      adopted: this.state.adopted,
      restartCount: this.state.restartCount,
      endpoint: this.state.endpoint,
      alias: this.state.alias,
      runtimeId: this.context?.config.runtime.id || null,
      modelId: this.context?.config.model.id || null,
      executable: this.context?.executable || null,
      executableSha256: identity?.executableSha256 || null,
      commandFingerprint: identity?.commandFingerprint || null,
      commandLine: identity?.commandLine || null,
      creationTime: identity?.creationTime || null,
      startedAt: identity?.startedAt || null,
      updatedAt: this.state.updatedAt,
      error: this.state.error,
    };
  }

  _setState(next, { persist = true } = {}) {
    this.state = {
      ...this.state,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    if (persist && this.context) {
      try { writeJsonAtomic(this.context.stateReceipt, this._receiptForState()); }
      catch (error) { this._log(`STATE-RECEIPT-FAILED ${error.message}`); }
    }
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* observers cannot own lifecycle */ }
    }
    return snapshot;
  }

  async _processInfoWithRetry(pid, getChildError = () => null) {
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const childError = getChildError();
      if (childError) {
        throw new LocalVisionServerError(
          "SPAWN_FAILED",
          `llama-server spawn failed${childError.code ? ` (${childError.code})` : ""}: ${childError.message}`,
        );
      }
      try {
        const info = await this.inspectProcess(pid);
        if (info) return info;
      } catch (error) {
        lastError = error;
      }
      await this.sleep(50);
    }
    if (lastError) throw lastError;
    return null;
  }

  _identityFromInfo(info, context, executableSha256, args, startedAt = new Date().toISOString()) {
    const actualFingerprint = isBoundedString(info?.commandLine, 32 * 1024)
      ? fingerprintCommandLine(info.commandLine, context) : null;
    const expectedFingerprint = commandFingerprint(context.executable, args);
    if (!info || !Number.isSafeInteger(info.pid) || info.pid <= 0 ||
        !isBoundedString(info.executablePath, 32 * 1024) ||
        normalizePath(info.executablePath) !== normalizePath(context.executable) ||
        !isBoundedString(info.commandLine, 32 * 1024) ||
        actualFingerprint === null || actualFingerprint !== expectedFingerprint ||
        !isBoundedString(info.creationTime, 256) || !isValidTimestamp(startedAt) ||
        !/^[0-9a-f]{64}$/.test(executableSha256 || "")) {
      throw new LocalVisionServerError("PROCESS_IDENTITY_MISMATCH", "Spawned llama-server identity did not match");
    }
    return {
      pid: info.pid,
      executablePath: path.resolve(info.executablePath),
      executableSha256,
      commandLine: info.commandLine,
      commandFingerprint: actualFingerprint,
      creationTime: info.creationTime,
      startedAt,
    };
  }

  async _verifyIdentity(identity) {
    const actualFingerprint = isBoundedString(identity?.commandLine, 32 * 1024)
      ? fingerprintCommandLine(identity.commandLine, this.context) : null;
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
        !isBoundedString(identity.executablePath, 32 * 1024) ||
        !/^[0-9a-f]{64}$/.test(identity.executableSha256 || "") ||
        !isBoundedString(identity.commandLine, 32 * 1024) ||
        !/^[0-9a-f]{64}$/.test(identity.commandFingerprint || "") ||
        actualFingerprint === null || actualFingerprint !== identity.commandFingerprint ||
        !isBoundedString(identity.creationTime, 256) || !isValidTimestamp(identity.startedAt)) {
      return { ok: false, status: "drift", reason: "missing or invalid process identity" };
    }
    let info;
    try { info = await this.inspectProcess(identity.pid); }
    catch (error) {
      return { ok: false, status: "unavailable", reason: `process inspection failed: ${error.message}` };
    }
    if (!info) return { ok: false, status: "gone", reason: "process is no longer running" };
    if (normalizePath(info.executablePath) !== normalizePath(identity.executablePath) ||
        info.creationTime !== identity.creationTime || info.commandLine !== identity.commandLine) {
      return { ok: false, status: "drift", reason: "PID was reused or command identity changed" };
    }
    try {
      if (!fs.existsSync(identity.executablePath) ||
          sha256File(identity.executablePath) !== identity.executableSha256) {
        return { ok: false, status: "drift", reason: "runtime executable changed after launch" };
      }
    } catch (error) {
      return {
        ok: false,
        status: "unavailable",
        reason: `runtime executable could not be verified: ${error.message}`,
      };
    }
    return { ok: true, status: "verified", info };
  }

  _identityFromReceipt(receipt) {
    if (!isPlainObject(receipt) || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt.kind !== RECEIPT_KIND ||
        receipt.owner !== OWNER || receipt.configSha256 !== this.context.configSha256 ||
        !ACTIVE_RECEIPT_STATES.has(receipt.state) || receipt.runtimeId !== this.context.config.runtime.id ||
        receipt.modelId !== this.context.config.model.id || receipt.alias !== this.context.config.server.alias ||
        receipt.endpoint !== this.context.endpoint || !isBoundedString(receipt.executable, 32 * 1024) ||
        normalizePath(receipt.executable) !== normalizePath(this.context.executable) ||
        !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 ||
        !isBoundedString(receipt.instanceId, 128) || !INSTANCE_ID_PATTERN.test(receipt.instanceId) ||
        typeof receipt.adopted !== "boolean" || !isValidTimestamp(receipt.updatedAt) ||
        !(receipt.error === null || typeof receipt.error === "string" && receipt.error.length <= 4_000) ||
        !Number.isSafeInteger(receipt.restartCount) || receipt.restartCount < 0 ||
        receipt.restartCount > this.context.config.server.maxRestarts ||
        !isBoundedString(receipt.commandLine, 32 * 1024) ||
        !isBoundedString(receipt.creationTime, 256) || !isValidTimestamp(receipt.startedAt) ||
        !/^[0-9a-f]{64}$/.test(receipt.executableSha256 || "") ||
        !/^[0-9a-f]{64}$/.test(receipt.commandFingerprint || "")) {
      return null;
    }
    const expectedFingerprint = commandFingerprint(this.context.executable, buildArguments(this.context));
    const actualFingerprint = fingerprintCommandLine(receipt.commandLine, this.context);
    if (actualFingerprint === null || receipt.commandFingerprint !== actualFingerprint ||
        receipt.commandFingerprint !== expectedFingerprint ||
        receipt.executableSha256 !== this.setup.executableSha256) {
      return null;
    }
    return {
      pid: receipt.pid,
      executablePath: receipt.executable,
      executableSha256: receipt.executableSha256,
      commandLine: receipt.commandLine,
      commandFingerprint: receipt.commandFingerprint,
      creationTime: receipt.creationTime,
      startedAt: receipt.startedAt,
    };
  }

  async _verifyAdoption(receipt, listenerPid) {
    const identity = this._identityFromReceipt(receipt);
    if (!identity) return { ok: false, reason: "missing or mismatched ownership receipt" };
    if (listenerPid !== identity.pid) return { ok: false, reason: "receipt PID does not own the listener" };
    const verified = await this._verifyIdentity(identity);
    if (!verified.ok) return verified;
    if (!await probeServer(this.context, this.fetchImpl)) {
      return { ok: false, reason: "listener did not expose the expected healthy model alias" };
    }
    return { ok: true, identity };
  }

  async _waitUntilReady(pid, child = null, getChildError = () => null) {
    const deadline = Date.now() + this.context.config.server.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.desiredRunning) throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
      const childError = getChildError();
      if (childError) {
        throw new LocalVisionServerError(
          "SPAWN_FAILED",
          `llama-server spawn failed${childError.code ? ` (${childError.code})` : ""}: ${childError.message}`,
        );
      }
      if (child && child.exitCode !== null) {
        throw new LocalVisionServerError(
          "SERVER_EXITED",
          `llama-server exited with code ${child.exitCode}; inspect ${this.context.log}`,
        );
      }
      const listenerPid = await this.findListenerPid(
        this.context.config.server.host,
        this.context.config.server.port,
      );
      if (listenerPid !== null && listenerPid !== pid) {
        throw new LocalVisionServerError(
          "PORT_IN_USE_UNOWNED",
          `Port ${this.context.config.server.port} is owned by PID ${listenerPid}, not PID ${pid}`,
        );
      }
      if (listenerPid === pid && await probeServer(this.context, this.fetchImpl)) return;
      await this.sleep(this.context.config.server.healthPollMs);
    }
    throw new LocalVisionServerError(
      "START_TIMEOUT",
      `Timed out waiting for the local vision model to load; inspect ${this.context.log}`,
    );
  }

  async _waitUntilGone(pid) {
    const deadline = Date.now() + this.context.config.server.shutdownTimeoutMs;
    while (Date.now() < deadline) {
      let info;
      try { info = await this.inspectProcess(pid); }
      catch {
        await this.sleep(100);
        continue;
      }
      if (!info) return true;
      await this.sleep(100);
    }
    return false;
  }

  async _cleanupFailedChild(child, identity) {
    if (!child || child.exitCode !== null) return;
    try {
      if (identity) {
        const verified = await this._verifyIdentity(identity);
        if (!verified.ok) {
          this._log(`CLEANUP-REFUSED pid=${identity.pid} reason=${verified.reason}`);
          return;
        }
      }
      child.kill();
      if (Number.isSafeInteger(child.pid)) await this._waitUntilGone(child.pid);
    } catch (error) {
      this._log(`CLEANUP-FAILED ${error.message}`);
    }
  }

  async _spawnOnce() {
    const listenerBefore = await this.findListenerPid(
      this.context.config.server.host,
      this.context.config.server.port,
    );
    if (!this.desiredRunning) {
      throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
    }
    if (listenerBefore !== null) {
      throw new LocalVisionServerError(
        "PORT_IN_USE_UNOWNED",
        `Refusing to replace PID ${listenerBefore} on port ${this.context.config.server.port}`,
      );
    }
    const args = buildArguments(this.context);
    fs.mkdirSync(path.dirname(this.context.log), { recursive: true });
    let child;
    let childError = null;
    if (!this.desiredRunning) {
      throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
    }
    child = this.spawnImpl(this.context.executable, args, {
      cwd: this.context.runtimeDirectory,
      env: sanitizedLlamaEnvironment(process.env),
      windowsHide: true,
      // llama-server owns its pinned --log-file. Redirecting stdout/stderr to
      // that same file duplicates verbose output and can corrupt provenance.
      stdio: "ignore",
    });
    if (child && typeof child.on === "function") {
      child.on("error", (error) => {
        if (!childError) childError = error;
        this._log(
          `CHILD-ERROR pid=${Number.isSafeInteger(child.pid) ? child.pid : "unassigned"}` +
          `${error?.code ? ` code=${error.code}` : ""} ${error?.message || String(error)}`,
        );
      });
    }
    let identity = null;
    try {
      if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        // Native spawn failures emit `error` asynchronously. Yield once so its
        // code/message become the controlled startup error instead of an
        // unhandled EventEmitter exception.
        await this.sleep(0);
        throw new LocalVisionServerError(
          "SPAWN_FAILED",
          childError
            ? `llama-server spawn failed${childError.code ? ` (${childError.code})` : ""}: ${childError.message}`
            : "llama-server did not return a child PID",
        );
      }
      this.child = child;
      this.instanceId = crypto.randomUUID();
      const info = await this._processInfoWithRetry(child.pid, () => childError);
      if (!info) throw new LocalVisionServerError("SPAWN_FAILED", "Could not inspect spawned llama-server");
      identity = this._identityFromInfo(info, this.context, this.setup.executableSha256, args);
      this.identity = identity;
      this._setState({
        state: this.state.restartCount > 0 ? "restarting" : "starting",
        pid: child.pid,
        adopted: false,
        endpoint: this.context.endpoint,
        alias: this.context.config.server.alias,
        error: null,
      });
      await this._waitUntilReady(child.pid, child, () => childError);
      if (!this.desiredRunning) {
        throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
      }
      if (child.exitCode !== null) {
        throw new LocalVisionServerError(
          "SERVER_EXITED", `llama-server exited during startup; inspect ${this.context.log}`,
        );
      }
      child.once("exit", (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        this._handleUnexpectedExit(code, signal).catch((error) => {
          this._log(`RESTART-HANDLER-FAILED ${error.message}`);
        });
      });
      if (child.exitCode !== null) {
        throw new LocalVisionServerError(
          "SERVER_EXITED", `llama-server exited during startup; inspect ${this.context.log}`,
        );
      }
      this._setState({ state: "running", pid: child.pid, adopted: false, error: null });
      this.healthFailures = 0;
      this._log(`RUNNING pid=${child.pid} restart=${this.state.restartCount}`);
      this._startMonitor();
      return this.getState();
    } catch (error) {
      await this._cleanupFailedChild(child, identity);
      if (this.child === child) this.child = null;
      this.identity = null;
      throw error;
    }
  }

  async _launchWithinRestartBudget() {
    while (this.desiredRunning) {
      try {
        return await this._spawnOnce();
      } catch (error) {
        if (!this.desiredRunning || error?.code === "START_CANCELLED") throw error;
        if (error?.code === "PORT_IN_USE_UNOWNED") {
          this._setState({ state: "blocked", pid: null, error: error.message });
          throw error;
        }
        if (this.state.restartCount >= this.context.config.server.maxRestarts) {
          this._setState({ state: "failed", pid: null, adopted: false, error: error.message });
          throw error;
        }
        const restartCount = this.state.restartCount + 1;
        this._setState({ state: "restarting", pid: null, adopted: false, restartCount, error: error.message });
        this._log(`RESTART attempt=${restartCount} reason=${error.message}`);
        await this.sleep(800);
      }
    }
    throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
  }

  async _handleUnexpectedExit(code, signal) {
    this._stopMonitor();
    this.identity = null;
    if (!this.desiredRunning || this.state.state === "stopping" || this.state.state === "stopped") return;
    if (this.restartPromise) return this.restartPromise;
    if (this.state.restartCount >= this.context.config.server.maxRestarts) {
      this._setState({
        state: "failed",
        pid: null,
        adopted: false,
        error: `llama-server exited after its only restart (code=${code}, signal=${signal})`,
      });
      return;
    }
    const restartCount = this.state.restartCount + 1;
    this._setState({
      state: "restarting",
      pid: null,
      adopted: false,
      restartCount,
      error: `llama-server exited unexpectedly (code=${code}, signal=${signal})`,
    });
    this.restartPromise = (async () => {
      await this.sleep(800);
      if (!this.desiredRunning) return this.getState();
      try {
        return await this._spawnOnce();
      } catch (error) {
        this._setState({ state: "failed", pid: null, adopted: false, error: error.message });
        return this.getState();
      }
    })().finally(() => { this.restartPromise = null; });
    return this.restartPromise;
  }

  _startMonitor() {
    this._stopMonitor();
    if (!this.monitorEnabled) return;
    const interval = Math.max(2_000, this.context.config.server.healthPollMs * 4);
    this.monitor = setInterval(() => {
      this._monitorTick().catch((error) => this._log(`MONITOR-FAILED ${error.message}`));
    }, interval);
    if (this.monitor.unref) this.monitor.unref();
  }

  _stopMonitor() {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  async _monitorTick() {
    if (this.monitorBusy || !this.desiredRunning || this.state.state !== "running" || !this.identity) return;
    this.monitorBusy = true;
    try {
      const identity = this.identity;
      const verified = await this._verifyIdentity(identity);
      if (!this.desiredRunning || this.state.state !== "running" || this.identity !== identity) return;
      if (verified.status === "unavailable") {
        this._log(`PROCESS-INSPECTION-DEFERRED pid=${identity.pid} reason=${verified.reason}`);
        return;
      }
      if (verified.status === "gone") {
        this.healthFailures = 0;
        if (this.child?.pid === identity.pid) this.child = null;
        this.identity = null;
        await this._handleUnexpectedExit(null, "process-gone");
        return;
      }
      if (!verified.ok) {
        this.healthFailures = 0;
        this.desiredRunning = false;
        this._setState({
          state: "blocked",
          pid: identity.pid,
          error: `Process ownership changed; no process was killed (${verified.reason})`,
        });
        this._stopMonitor();
        return;
      }
      let listenerPid;
      try {
        listenerPid = await this.findListenerPid(
          this.context.config.server.host,
          this.context.config.server.port,
        );
      } catch (error) {
        if (!isPortOwnershipError(error)) throw error;
        this.healthFailures = 0;
        this.desiredRunning = false;
        this._setState({
          state: "blocked",
          pid: identity.pid,
          error: `${error.message}; no process was killed`,
        });
        this._stopMonitor();
        return;
      }
      if (!this.desiredRunning || this.state.state !== "running" || this.identity !== identity) return;
      if (listenerPid !== null && listenerPid !== identity.pid) {
        this.healthFailures = 0;
        this.desiredRunning = false;
        this._setState({
          state: "blocked",
          pid: identity.pid,
          error: `Listener ownership changed to PID ${listenerPid}; no process was killed`,
        });
        this._stopMonitor();
        return;
      }
      const healthy = listenerPid === identity.pid && await probeServer(this.context, this.fetchImpl);
      if (!this.desiredRunning || this.state.state !== "running" || this.identity !== identity) return;
      if (healthy) {
        this.healthFailures = 0;
      } else {
        this.healthFailures += 1;
        this._log(`HEALTH-FAILED count=${this.healthFailures} pid=${identity.pid}`);
        if (this.healthFailures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
          await this._restartUnhealthyOwnedProcess();
        }
      }
    } finally {
      this.monitorBusy = false;
    }
  }

  async _restartUnhealthyOwnedProcess() {
    const identity = this.identity;
    if (!identity || !this.desiredRunning) return;
    const verified = await this._verifyIdentity(identity);
    if (!this.desiredRunning || this.identity !== identity) return;
    if (verified.status === "unavailable") {
      this._log(`PROCESS-INSPECTION-DEFERRED pid=${identity.pid} reason=${verified.reason}`);
      return;
    }
    if (verified.status === "gone") {
      if (this.child?.pid === identity.pid) this.child = null;
      this.identity = null;
      await this._handleUnexpectedExit(null, "process-gone");
      return;
    }
    let listenerPid;
    try {
      listenerPid = await this.findListenerPid(
        this.context.config.server.host,
        this.context.config.server.port,
      );
    } catch (error) {
      if (!isPortOwnershipError(error)) throw error;
      this.desiredRunning = false;
      this._setState({
        state: "blocked",
        pid: identity.pid,
        error: `${error.message}; no process was killed`,
      });
      this._stopMonitor();
      return;
    }
    if (!this.desiredRunning || this.identity !== identity) return;
    if (!verified.ok || (listenerPid !== null && listenerPid !== identity.pid)) {
      this.desiredRunning = false;
      this._setState({
        state: "blocked",
        pid: identity.pid,
        error: `Unhealthy server ownership changed; no process was killed (${verified.reason || `listener PID ${listenerPid}`})`,
      });
      this._stopMonitor();
      return;
    }

    this.healthFailures = 0;
    const child = this.child;
    this._log(`TERMINATING-UNHEALTHY-OWNED pid=${identity.pid}`);
    try {
      if (child && child.pid === identity.pid && child.exitCode === null) child.kill();
      else this.killProcess(identity.pid);
    } catch (error) {
      this.desiredRunning = false;
      this._setState({
        state: "failed",
        error: `Failed to stop owned unhealthy PID ${identity.pid}: ${error.message}`,
      });
      return;
    }
    const gone = await this._waitUntilGone(identity.pid);
    if (!gone) {
      this.desiredRunning = false;
      this._setState({
        state: "failed",
        error: `Owned unhealthy PID ${identity.pid} did not exit; no broader kill was attempted`,
      });
      return;
    }
    // A direct ChildProcess normally emits `exit` and takes this branch itself.
    // If the OS reports it gone before Node delivers that event, detach it here;
    // the event callback checks object identity and will then become a no-op.
    await this.sleep(0);
    if (this.child === child) {
      this.child = null;
      this.identity = null;
      await this._handleUnexpectedExit(null, "health-check-failed");
    }
  }

  async _startInternal() {
    this.context = loadContext(this.appRoot, this.configPath, this.environment);
    this.setup = await this.verifySetup(this.context);
    if (!this.desiredRunning) {
      throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
    }
    if (!this.setup || !/^[0-9a-f]{64}$/.test(this.setup.executableSha256 || "")) {
      throw new LocalVisionServerError("SETUP_REQUIRED", "Setup verification did not return an executable digest");
    }
    const listenerPid = await this.findListenerPid(
      this.context.config.server.host,
      this.context.config.server.port,
    );
    if (!this.desiredRunning) {
      throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
    }
    if (listenerPid !== null) {
      const receipt = this._readStateReceipt();
      const adoption = await this._verifyAdoption(receipt, listenerPid);
      if (!this.desiredRunning) {
        throw new LocalVisionServerError("START_CANCELLED", "Vision start was cancelled");
      }
      if (!adoption.ok) {
        const error = new LocalVisionServerError(
          "PORT_IN_USE_UNOWNED",
          `Refusing to adopt or kill PID ${listenerPid}: ${adoption.reason}`,
        );
        this._setState({ state: "blocked", pid: null, adopted: false, error: error.message });
        throw error;
      }
      this.identity = adoption.identity;
      this.instanceId = receipt.instanceId;
      this._setState({
        state: "running",
        pid: listenerPid,
        adopted: true,
        restartCount: Math.min(receipt.restartCount || 0, this.context.config.server.maxRestarts),
        endpoint: this.context.endpoint,
        alias: this.context.config.server.alias,
        error: null,
      });
      this.healthFailures = 0;
      this._log(`ADOPTED pid=${listenerPid}`);
      this._startMonitor();
      return this.getState();
    }
    this._setState({
      state: "starting",
      pid: null,
      adopted: false,
      restartCount: 0,
      endpoint: this.context.endpoint,
      alias: this.context.config.server.alias,
      error: null,
    });
    return this._launchWithinRestartBudget();
  }

  async start(options = {}) {
    if (typeof options.log === "function") this.setLog(options.log);
    if (this.state.state === "running") return this.getState();
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    if (options.environment) this.environment = { ...options.environment };
    this.desiredRunning = true;
    this.startPromise = this._startInternal().catch((error) => {
      if (!new Set(["blocked", "failed"]).has(this.state.state)) {
        this._setState({
          state: isPortOwnershipError(error) ? "blocked" : "failed",
          pid: null,
          adopted: false,
          error: error.message,
        });
      }
      throw error;
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async _stopInternal() {
    this.desiredRunning = false;
    this._stopMonitor();
    if (this.restartPromise) await this.restartPromise.catch(() => undefined);
    const identity = this.identity;
    const pid = identity?.pid || this.state.pid;
    if (!pid && !identity) {
      this.child = null;
      this.identity = null;
      this._setState({ state: "stopped", pid: null, adopted: false, error: null });
      return this.getState();
    }
    if (!identity || !Number.isSafeInteger(pid) || pid <= 0 || identity.pid !== pid) {
      const error = new LocalVisionServerError(
        "OWNERSHIP_LOST",
        `Refusing to report stopped while tracked PID ${pid || "unknown"} lacks a complete identity`,
      );
      this._setState({ state: "blocked", pid: pid || this.state.pid, error: error.message });
      throw error;
    }

    this._setState({ state: "stopping", pid, error: null });
    const verified = await this._verifyIdentity(identity);
    if (verified.status === "gone") {
      if (this.child?.pid === pid) this.child = null;
      this.identity = null;
      this.instanceId = null;
      this._setState({ state: "stopped", pid: null, adopted: false, error: null });
      this._log(`STOPPED pid=${pid} (already gone)`);
      return this.getState();
    }
    if (!verified.ok) {
      const error = new LocalVisionServerError(
        "OWNERSHIP_LOST",
        `Refusing to kill PID ${pid}: ${verified.reason}`,
      );
      this._setState({ state: "blocked", pid, error: error.message });
      throw error;
    }

    try {
      if (this.child && this.child.pid === pid && this.child.exitCode === null) this.child.kill();
      else this.killProcess(pid);
    } catch (error) {
      this._setState({ state: "failed", error: `Failed to stop owned PID ${pid}: ${error.message}` });
      throw error;
    }
    if (!await this._waitUntilGone(pid)) {
      const error = new LocalVisionServerError(
        "STOP_TIMEOUT",
        `Owned PID ${pid} did not exit; no broader kill was attempted`,
      );
      this._setState({ state: "failed", error: error.message });
      throw error;
    }
    this.child = null;
    this.identity = null;
    this.instanceId = null;
    this._setState({ state: "stopped", pid: null, adopted: false, error: null });
    this._log(`STOPPED pid=${pid}`);
    return this.getState();
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.startPromise) {
      this.desiredRunning = false;
      await this.startPromise.catch(() => undefined);
    }
    this.stopPromise = this._stopInternal().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}

function createLocalVisionServer(options = {}) {
  return new LocalVisionSupervisor(options);
}

let singleton = null;

function singletonFor(options = {}) {
  if (!singleton) singleton = createLocalVisionServer(options);
  else if (typeof options.log === "function") singleton.setLog(options.log);
  return singleton;
}

async function start(options = {}) {
  return singletonFor(options).start(options);
}

async function stop() {
  if (!singleton) return publicState({
    state: "idle", pid: null, adopted: false, restartCount: 0,
    endpoint: null, alias: null, error: null, updatedAt: new Date().toISOString(),
  });
  return singleton.stop();
}

function getState() {
  return singletonFor().getState();
}

function onState(listener) {
  return singletonFor().onState(listener);
}

module.exports = {
  OWNER,
  APPROVED_ARGUMENTS,
  LocalVisionServerError,
  createLocalVisionServer,
  start,
  stop,
  getState,
  onState,
  __test: {
    assertManifest,
    buildArguments,
    commandFingerprint,
    commandLineMatchesPinnedArgv,
    expectedCommandArgv,
    fingerprintCommandLine,
    inspectWindowsProcess,
    loadContext,
    parseNetstatListeners,
    probeServer,
    runtimeFileInventory,
    sanitizedLlamaEnvironment,
    selectListenerPid,
    verifySetupReceipt,
    writeJsonAtomic,
  },
};
