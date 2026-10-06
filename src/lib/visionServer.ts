// Read-only status and probe normalization for the fixed local llama.cpp runtime.
// Electron owns process lifecycle; this module only inspects tracked configuration,
// verified local assets/state, and results returned by the Python worker.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  commandLineHasExactArgv,
  parseWindowsCommandLine,
} from "../../electron/windowsCommandLine.js";
import { resolveVisionAssetRoot } from "../../electron/runtimePaths.js";

export type ManagedVisionKind =
  | "ready"
  | "disabled"
  | "missing"
  | "starting"
  | "busy"
  | "error";

export interface ManagedVisionStatus {
  ok: boolean;
  mode: "local-llama-cpp";
  kind: ManagedVisionKind;
  enabled: boolean;
  runtimeAvailable: boolean;
  modelAvailable: boolean;
  serverReady: boolean;
  model: string;
  reason: string;
}

export interface ManagedVisionProbeResult extends ManagedVisionStatus {
  /** True only when a real image request reached the local model. */
  tested: boolean;
  responseModel?: string;
}

export function managedVisionProbeHttpStatus(
  probe: Pick<ManagedVisionProbeResult, "ok" | "kind">,
): number {
  if (probe.kind === "disabled") return 422;
  if (probe.ok) return 200;
  if (probe.kind === "busy" || probe.kind === "starting" || probe.kind === "missing") return 503;
  return 502;
}

export type ManagedVisionProbeRunner = () => Promise<unknown>;

type LocalVisionManifest = {
  schemaVersion: number;
  assetRoot: string;
  runtime: { id: string; directory: string; executable: string };
  model: {
    id: string;
    revision: string;
    directory: string;
    weights: { name: string };
    projector: { name: string };
  };
  server: {
    host: string;
    port: number;
    alias: string;
    apiKeyFile: string;
    maxRestarts: number;
    arguments: string[];
  };
  receipts: { state: string; log: string };
};

type RuntimeState = {
  schemaVersion: number;
  kind: string;
  owner: string;
  configSha256: string;
  instanceId: string | null;
  state: string;
  pid: number | null;
  adopted: boolean;
  restartCount: number;
  endpoint: string;
  alias: string;
  runtimeId: string;
  modelId: string;
  executable: string;
  executableSha256: string | null;
  commandFingerprint: string | null;
  commandLine: string | null;
  creationTime: string | null;
  startedAt: string | null;
  updatedAt: string;
  error: string | null;
};

interface ManagedVisionDeps {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
  readFileSync?: (candidate: string, encoding: BufferEncoding) => string;
  isProcessAlive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}

const STATE_KIND = "blackcat-local-vision-server";
const STATE_OWNER = "blackcat-reseller";
const RUNTIME_ID = "llama-b10218-win-cuda-13.3-x64";
const MODEL_ID = "qwen3.5-4b-q4-k-m";
const MODEL_REVISION = "f9f88ac3e234be915e23811a6d28ea287bdb927e";
const ACTIVE_STATES = new Set(["starting", "running", "restarting"]);
const ALLOWED_STATES = new Set([
  ...ACTIVE_STATES, "stopping", "stopped", "failed", "blocked",
]);
const MAX_STATUS_JSON_BYTES = 256 * 1024;
const MAX_HEALTH_JSON_BYTES = 64 * 1024;

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readText(
  candidate: string,
  read: ManagedVisionDeps["readFileSync"],
  maximum = MAX_STATUS_JSON_BYTES,
): string {
  const text = (read ?? fs.readFileSync)(candidate, "utf8");
  if (Buffer.byteLength(text, "utf8") > maximum) {
    throw new Error("local vision JSON exceeded its safety limit");
  }
  return text;
}

function readJson<T>(candidate: string, read: ManagedVisionDeps["readFileSync"]): T {
  return JSON.parse(readText(candidate, read)) as T;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function commandFingerprint(executable: string, args: string[]): string {
  return sha256Text(JSON.stringify({ executable: path.resolve(executable), args }));
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function localVisionPaths(deps: ManagedVisionDeps = {}) {
  const projectRoot = path.resolve(deps.cwd ?? process.cwd());
  const manifestPath = path.join(projectRoot, "config", "local-vision.json");
  const manifestText = readText(manifestPath, deps.readFileSync);
  const manifest = JSON.parse(manifestText) as LocalVisionManifest;
  if (manifest.schemaVersion !== 1 || manifest.assetRoot !== ".local/vision") {
    throw new Error("local vision manifest has an unsupported schema or asset root");
  }
  if (manifest.runtime?.id !== RUNTIME_ID || manifest.model?.id !== MODEL_ID ||
      manifest.model?.revision !== MODEL_REVISION) {
    throw new Error("local vision manifest has an unexpected runtime or model identity");
  }
  if (manifest.server.host !== "127.0.0.1" || manifest.server.port !== 1235 ||
      manifest.server.alias !== "blackcat-vision" || manifest.server.maxRestarts !== 1 ||
      manifest.server.apiKeyFile !== "api-key.txt" ||
      !Array.isArray(manifest.server.arguments) ||
      manifest.server.arguments.some((argument) => typeof argument !== "string")) {
    throw new Error("local vision manifest must use the fixed localhost endpoint and model alias");
  }
  const assetRoot = resolveVisionAssetRoot(projectRoot, deps.environment ?? process.env);
  const runtime = path.resolve(assetRoot, manifest.runtime.directory, manifest.runtime.executable);
  const weights = path.resolve(assetRoot, manifest.model.directory, manifest.model.weights.name);
  const projector = path.resolve(assetRoot, manifest.model.directory, manifest.model.projector.name);
  const apiKeyFile = path.resolve(assetRoot, manifest.server.apiKeyFile);
  const state = path.resolve(assetRoot, manifest.receipts.state);
  const log = path.resolve(assetRoot, manifest.receipts.log);
  for (const candidate of [runtime, weights, projector, apiKeyFile, state, log]) {
    if (!within(assetRoot, candidate)) throw new Error("local vision manifest path escapes its asset root");
  }
  const endpoint = `http://${manifest.server.host}:${manifest.server.port}`;
  const serverArguments = [
    "-m", weights,
    "--mmproj", projector,
    "--alias", manifest.server.alias,
    "--host", manifest.server.host,
    "--port", String(manifest.server.port),
    "--api-key-file", apiKeyFile,
    ...manifest.server.arguments,
    "--log-file", log,
  ];
  return {
    projectRoot,
    manifestPath,
    manifest,
    configSha256: sha256Text(manifestText),
    assetRoot,
    runtime,
    weights,
    projector,
    apiKeyFile,
    state,
    log,
    endpoint,
    serverArguments,
    commandFingerprint: commandFingerprint(runtime, serverArguments),
  };
}

function processAlive(pid: number, injected?: (pid: number) => boolean): boolean {
  if (injected) return injected(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validTimestamp(value: unknown): value is string {
  return boundedString(value, 128) && Number.isFinite(Date.parse(value));
}

function validInstanceId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function commandLineFingerprint(
  commandLine: string,
  paths: ReturnType<typeof localVisionPaths>,
): string | null {
  const expectedArgv = [paths.runtime, ...paths.serverArguments];
  if (!commandLineHasExactArgv(commandLine, expectedArgv)) return null;
  const argv = parseWindowsCommandLine(commandLine);
  return argv === null ? null : commandFingerprint(argv[0], argv.slice(1));
}

function validateRuntimeState(
  value: unknown,
  paths: ReturnType<typeof localVisionPaths>,
): RuntimeState {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || value.kind !== STATE_KIND ||
      value.owner !== STATE_OWNER || value.configSha256 !== paths.configSha256 ||
      typeof value.state !== "string" || !ALLOWED_STATES.has(value.state) ||
      value.endpoint !== paths.endpoint || value.alias !== paths.manifest.server.alias ||
      value.runtimeId !== paths.manifest.runtime.id || value.modelId !== paths.manifest.model.id ||
      typeof value.executable !== "string" ||
      normalizedPath(value.executable) !== normalizedPath(paths.runtime) ||
      typeof value.adopted !== "boolean" || !Number.isSafeInteger(value.restartCount) ||
      (value.restartCount as number) < 0 ||
      (value.restartCount as number) > paths.manifest.server.maxRestarts ||
      !validTimestamp(value.updatedAt) ||
      !(value.error === null || typeof value.error === "string" && value.error.length <= 4_000) ||
      !(value.instanceId === null || validInstanceId(value.instanceId))) {
    throw new Error("The local vision state receipt did not match the pinned supervisor contract.");
  }

  const pid = value.pid;
  if (!(pid === null || Number.isSafeInteger(pid) && (pid as number) > 0)) {
    throw new Error("The local vision state receipt contained an invalid process ID.");
  }
  if (value.state === "running" && pid === null) {
    throw new Error("The local vision running receipt did not contain a process ID.");
  }
  if (pid !== null && value.instanceId === null) {
    throw new Error("The local vision process receipt did not contain an instance ID.");
  }

  const identityValues = [
    value.executableSha256,
    value.commandFingerprint,
    value.commandLine,
    value.creationTime,
    value.startedAt,
  ];
  const identityMissing = identityValues.every((candidate) => candidate === null);
  const identityPresent = identityValues.every((candidate) => typeof candidate === "string");
  if ((!identityMissing && !identityPresent) || (pid !== null && !identityPresent)) {
    throw new Error("The local vision state receipt contained a partial process identity.");
  }
  if (identityPresent) {
    const actualCommandFingerprint = boundedString(value.commandLine, 32 * 1024)
      ? commandLineFingerprint(value.commandLine, paths) : null;
    if (!/^[0-9a-f]{64}$/.test(value.executableSha256 as string) ||
        value.commandFingerprint !== paths.commandFingerprint ||
        actualCommandFingerprint === null ||
        value.commandFingerprint !== actualCommandFingerprint ||
        !boundedString(value.creationTime, 256) || !validTimestamp(value.startedAt)) {
      throw new Error("The local vision state receipt process identity did not match the pinned command.");
    }
  }

  return value as unknown as RuntimeState;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const lengthText = response.headers.get("content-length");
  if (lengthText !== null) {
    const length = Number(lengthText);
    if (Number.isFinite(length) && length > MAX_HEALTH_JSON_BYTES) {
      throw new Error("local vision health response exceeded its safety limit");
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_HEALTH_JSON_BYTES) {
    throw new Error("local vision health response exceeded its safety limit");
  }
  return JSON.parse(text) as unknown;
}

async function serverHasExpectedModel(
  paths: ReturnType<typeof localVisionPaths>,
  fetchImpl: typeof fetch = fetch,
  readFileSync?: ManagedVisionDeps["readFileSync"],
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  let apiKey: string;
  try {
    apiKey = readText(paths.apiKeyFile, readFileSync, 128).trim();
  } catch {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(apiKey)) return false;
  const options: RequestInit = {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: controller.signal,
  };
  try {
    const health = await fetchImpl(`${paths.endpoint}/health`, options);
    if (!health.ok) return false;
    const healthBody = await boundedResponseJson(health);
    if (!isPlainRecord(healthBody) || healthBody.status !== "ok") return false;

    const models = await fetchImpl(`${paths.endpoint}/v1/models`, options);
    if (!models.ok) return false;
    const modelsBody = await boundedResponseJson(models);
    if (!isPlainRecord(modelsBody) || !Array.isArray(modelsBody.data) ||
        modelsBody.data.length !== 1 || !isPlainRecord(modelsBody.data[0])) return false;
    return modelsBody.data[0].id === paths.manifest.server.alias;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Read-only readiness. It never starts, stops, or sends work to the model. */
export async function managedVisionStatus(
  enabled: boolean,
  deps: ManagedVisionDeps = {},
): Promise<ManagedVisionStatus> {
  const base = {
    mode: "local-llama-cpp" as const,
    enabled,
    runtimeAvailable: false,
    modelAvailable: false,
    serverReady: false,
    model: "blackcat-vision",
  };
  let paths: ReturnType<typeof localVisionPaths>;
  try {
    paths = localVisionPaths(deps);
  } catch (error) {
    return {
      ...base,
      ok: false,
      kind: "error",
      reason: boundedMessage(error, "The local vision manifest is invalid."),
    };
  }

  const exists = deps.existsSync ?? fs.existsSync;
  const runtimeAvailable = exists(paths.runtime);
  const modelAvailable = exists(paths.weights) && exists(paths.projector);
  const available = { ...base, runtimeAvailable, modelAvailable, model: paths.manifest.server.alias };

  if (!enabled) {
    return {
      ...available,
      ok: true,
      kind: "disabled",
      reason: "AI vision is disabled; item fields remain available for manual entry.",
    };
  }
  const apiKeyAvailable = exists(paths.apiKeyFile);
  if (!runtimeAvailable || !modelAvailable || !apiKeyAvailable) {
    const missing = [
      !runtimeAvailable ? "llama.cpp runtime" : "",
      !modelAvailable ? "Qwen model/projector" : "",
      !apiKeyAvailable ? "local API credential" : "",
    ].filter(Boolean).join(" and ");
    return {
      ...available,
      ok: false,
      kind: "missing",
      reason: `Local vision setup is incomplete (${missing}). Follow the optional local AI steps in Getting started, then reopen Black Cat.`,
    };
  }

  let state: RuntimeState;
  try {
    if (!exists(paths.state)) {
      return {
        ...available,
        ok: false,
        kind: "error",
        reason: "The local vision assets are installed, but no supervisor state receipt exists.",
      };
    }
    state = validateRuntimeState(readJson<unknown>(paths.state, deps.readFileSync), paths);
  } catch (error) {
    return {
      ...available,
      ok: false,
      kind: "error",
      reason: boundedMessage(error, "The local vision state receipt is unreadable."),
    };
  }
  if (state.state === "running" && state.pid !== null &&
      processAlive(state.pid, deps.isProcessAlive) &&
      await serverHasExpectedModel(paths, deps.fetchImpl, deps.readFileSync)) {
    return {
      ...available,
      ok: true,
      kind: "ready",
      serverReady: true,
      reason: "The offline local vision model is loaded and ready.",
    };
  }
  if (["starting", "restarting"].includes(state.state)) {
    if (state.pid !== null && !processAlive(state.pid, deps.isProcessAlive)) {
      return {
        ...available,
        ok: false,
        kind: "error",
        reason: "The local vision supervisor receipt points to a process that is no longer running.",
      };
    }
    return {
      ...available,
      ok: false,
      kind: "starting",
      reason: "The offline local vision model is still loading.",
    };
  }
  if (["failed", "blocked"].includes(state.state)) {
    return {
      ...available,
      ok: false,
      kind: "error",
      reason: boundedMessage(state.error, "The local vision server could not start; check its log."),
    };
  }
  return {
    ...available,
    ok: false,
    kind: "error",
    reason: state.state === "running"
      ? "The local vision server is not healthy or did not expose the exact configured model alias."
      : "The local vision assets are installed, but the app-owned server is not running.",
  };
}

function boundedMessage(value: unknown, fallback: string): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return " ".concat(text).trim().replace(/\s+/g, " ").slice(0, 400) || fallback;
}

function deferredError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const shaped = value as { code?: unknown; kind?: unknown; name?: unknown };
  return shaped.code === "VISION_DEFERRED" || shaped.kind === "generation_queue" ||
    shaped.name === "ManagedVisionDeferredError";
}

/** Normalize one worker-owned, real-image probe without taking over lifecycle. */
export async function managedVisionProbe(
  enabled: boolean,
  runProbe?: ManagedVisionProbeRunner,
  deps: ManagedVisionDeps = {},
): Promise<ManagedVisionProbeResult> {
  const status = await managedVisionStatus(enabled, deps);
  if (!status.ok || status.kind === "disabled") return { ...status, tested: false };
  if (!runProbe) {
    return {
      ...status,
      ok: false,
      kind: "error",
      tested: false,
      reason: "The local vision worker probe is unavailable in this build.",
    };
  }

  try {
    const raw = await runProbe();
    if (!raw || typeof raw !== "object" || (raw as { ok?: unknown }).ok !== true) {
      const shaped = (raw && typeof raw === "object")
        ? raw as { reason?: unknown; error?: unknown; code?: unknown; kind?: unknown }
        : {};
      const busy = shaped.code === "VISION_DEFERRED" || shaped.kind === "generation_queue";
      return {
        ...status,
        ok: false,
        kind: busy ? "busy" : "error",
        tested: false,
        reason: boundedMessage(shaped.reason ?? shaped.error,
          busy ? "Another local vision batch is running; retry shortly." : "Local vision probe failed."),
      };
    }
    const responseModel = (raw as { responseModel?: unknown; model?: unknown }).responseModel ??
      (raw as { model?: unknown }).model;
    if (responseModel !== status.model) {
      return {
        ...status,
        ok: false,
        kind: "error",
        tested: true,
        reason: "The local server answered with an unexpected model identity.",
      };
    }
    return {
      ...status,
      tested: true,
      responseModel: status.model,
      reason: "The offline local model answered a real image probe successfully.",
    };
  } catch (error) {
    const busy = deferredError(error);
    return {
      ...status,
      ok: false,
      kind: busy ? "busy" : "error",
      tested: false,
      reason: boundedMessage(error,
        busy ? "Another local vision batch is running; retry shortly." : "Local vision probe failed."),
    };
  }
}
