import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  localVisionPaths,
  managedVisionProbe,
  managedVisionProbeHttpStatus,
  managedVisionStatus,
} from "../src/lib/visionServer.ts";
import {
  LOCAL_VISION_MAX_OUTPUT_TOKENS,
  LOCAL_VISION_MAX_PHOTOS,
  parseProcessIntent,
  retiredVisionSettingKeys,
  stripRetiredVisionSettings,
  retiredSettingKeys,
  stripRetiredSettings,
} from "../src/lib/types.ts";
import { serializeWindowsCommandLine } from "../electron/windowsCommandLine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) failures += 1;
  console.log(`  [${condition ? "ok " : "FAIL"}] ${name}${!condition && detail ? ` — ${detail}` : ""}`);
}

function source(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

async function main(): Promise<void> {
  console.log("== fixed local runtime boundary ==");
  const paths = localVisionPaths({ cwd: ROOT });
  check("manifest pins localhost", paths.manifest.server.host === "127.0.0.1");
  check("manifest pins port", paths.manifest.server.port === 1235);
  check("manifest pins response alias", paths.manifest.server.alias === "blackcat-vision");
  check("all runtime paths stay below .local/vision",
    [paths.runtime, paths.weights, paths.projector, paths.apiKeyFile, paths.state]
      .every((candidate) => path.relative(paths.assetRoot, candidate).split(path.sep)[0] !== ".."));
  const relocatedRoot = path.resolve(ROOT, 'fixture-profile/runtime/vision');
  const relocated = localVisionPaths({ cwd: ROOT, environment: { NODE_ENV: 'test', BLACKCAT_VISION_ROOT: relocatedRoot } });
  check("packaged vision paths share the explicit persistent asset root",
    relocated.assetRoot === relocatedRoot &&
      [relocated.runtime, relocated.weights, relocated.projector, relocated.apiKeyFile, relocated.state, relocated.log]
        .every(candidate => path.relative(relocatedRoot, candidate).split(path.sep)[0] !== '..'));
  check("relocation leaves pinned manifest identity and endpoint unchanged",
    relocated.configSha256 === paths.configSha256 && relocated.endpoint === paths.endpoint &&
      relocated.manifest.model.id === paths.manifest.model.id);
  let relativeRejected = false;
  try { localVisionPaths({ cwd: ROOT, environment: { NODE_ENV: 'test', BLACKCAT_VISION_ROOT: '../relative' } }); }
  catch { relativeRejected = true; }
  check("relative vision overrides fail closed", relativeRejected);
  const escapedManifest = JSON.parse(source('config/local-vision.json'));
  escapedManifest.model.directory = '../outside';
  let escapeRejected = false;
  try { localVisionPaths({ cwd: ROOT, environment: { NODE_ENV: 'test', BLACKCAT_VISION_ROOT: relocatedRoot }, readFileSync: () => JSON.stringify(escapedManifest) }); }
  catch { escapeRejected = true; }
  check("relocation retains manifest-path containment", escapeRejected);

  const missing = await managedVisionStatus(true, { cwd: ROOT, existsSync: () => false });
  check("missing assets fail closed", !missing.ok && missing.kind === "missing");
  const disabled = await managedVisionStatus(false, { cwd: ROOT, existsSync: () => false });
  check("manual mode remains available without assets", disabled.ok && disabled.kind === "disabled");
  check("disabled probe maps to HTTP 422 before generic success",
    managedVisionProbeHttpStatus({ ok: true, kind: "disabled" }) === 422);
  check("probe HTTP mapping preserves ready, retryable, and failed states",
    managedVisionProbeHttpStatus({ ok: true, kind: "ready" }) === 200 &&
      managedVisionProbeHttpStatus({ ok: false, kind: "busy" }) === 503 &&
      managedVisionProbeHttpStatus({ ok: false, kind: "error" }) === 502);

  const commandLine = serializeWindowsCommandLine([paths.runtime, ...paths.serverArguments]);
  const stateReceipt = (
    state: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const hasProcess = state === "running";
    return {
      schemaVersion: 1,
      kind: "blackcat-local-vision-server",
      owner: "blackcat-reseller",
      configSha256: paths.configSha256,
      instanceId: hasProcess ? "8f23d3f1-7d30-4d6d-a060-0432b42f52ac" : null,
      state,
      pid: hasProcess ? 12345 : null,
      adopted: false,
      restartCount: 0,
      endpoint: paths.endpoint,
      alias: paths.manifest.server.alias,
      runtimeId: paths.manifest.runtime.id,
      modelId: paths.manifest.model.id,
      executable: paths.runtime,
      executableSha256: hasProcess ? "a".repeat(64) : null,
      commandFingerprint: hasProcess ? paths.commandFingerprint : null,
      commandLine: hasProcess ? commandLine : null,
      creationTime: hasProcess ? "20260817120000.000000-240" : null,
      startedAt: hasProcess ? "2026-08-17T16:00:00.000Z" : null,
      updatedAt: "2026-08-17T16:00:01.000Z",
      error: null,
      ...overrides,
    };
  };
  const healthyFetch = (
    calls: string[] = [], model = "blackcat-vision", authorizations: Array<string | null> = [],
  ): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("Authorization"));
      const body = url.endsWith("/health")
        ? { status: "ok" }
        : { data: [{ id: model }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  const statusDeps = (
    state: string,
    overrides: Record<string, unknown> = {},
    fetchImpl: typeof fetch = healthyFetch(),
  ) => ({
    cwd: ROOT,
    existsSync: () => true,
    readFileSync: (candidate: string, encoding: BufferEncoding) =>
      candidate === paths.state
        ? JSON.stringify(stateReceipt(state, overrides))
        : candidate === paths.apiKeyFile
          ? `${"a".repeat(64)}\n`
        : fs.readFileSync(candidate, encoding),
    isProcessAlive: () => true,
    fetchImpl,
  });
  const starting = await managedVisionStatus(true, statusDeps("starting"));
  check("loading is represented honestly", !starting.ok && starting.kind === "starting");
  const healthCalls: string[] = [];
  const healthAuthorizations: Array<string | null> = [];
  const ready = await managedVisionStatus(
    true,
    statusDeps("running", {}, healthyFetch(healthCalls, "blackcat-vision", healthAuthorizations)),
  );
  check("verified live receipt reports ready", ready.ok && ready.serverReady && ready.kind === "ready");
  check("readiness checks both fixed localhost endpoints",
    healthCalls.join("|") === `${paths.endpoint}/health|${paths.endpoint}/v1/models`);
  check("readiness authenticates both loopback probes without putting the secret in argv",
    healthAuthorizations.length === 2 &&
      healthAuthorizations.every((value) => value === `Bearer ${"a".repeat(64)}`) &&
      !commandLine.includes("a".repeat(64)));

  const wrongAliasHealth = await managedVisionStatus(
    true,
    statusDeps("running", {}, healthyFetch([], "not-blackcat-vision")),
  );
  check("health requires the one exact model alias",
    !wrongAliasHealth.ok && wrongAliasHealth.kind === "error");

  const receiptTampering: Array<[string, Record<string, unknown>]> = [
    ["schema", { schemaVersion: 2 }],
    ["kind", { kind: "other-server" }],
    ["owner", { owner: "other-app" }],
    ["config hash", { configSha256: "0".repeat(64) }],
    ["endpoint", { endpoint: "http://127.0.0.1:9999" }],
    ["alias", { alias: "other-model" }],
    ["runtime ID", { runtimeId: "other-runtime" }],
    ["model ID", { modelId: "other-model" }],
    ["PID", { pid: -1 }],
    ["instance ID", { instanceId: "arbitrary-instance" }],
    ["command fingerprint", { commandFingerprint: "0".repeat(64) }],
    ["command line", { commandLine: paths.runtime }],
    ["conflicting duplicate command flag", { commandLine: `${commandLine} --port 9999` }],
    ["extra duplicate command switch", { commandLine: `${commandLine} --no-webui` }],
    ["executable path", { executable: path.join(paths.assetRoot, "other.exe") }],
    ["executable digest", { executableSha256: "not-a-digest" }],
    ["started time", { startedAt: null }],
  ];
  for (const [field, override] of receiptTampering) {
    let tamperedHealthCalls = 0;
    const tampered = await managedVisionStatus(true, statusDeps(
      "running",
      override,
      (async () => {
        tamperedHealthCalls += 1;
        return new Response("{}");
      }) as typeof fetch,
    ));
    check(`tampered receipt ${field} fails before health`,
      !tampered.ok && tampered.kind === "error" && tamperedHealthCalls === 0);
  }

  console.log("\n== one real-image probe contract ==");
  let calls = 0;
  const success = await managedVisionProbe(true, async () => {
    calls += 1;
    return { ok: true, model: "blackcat-vision", responseModel: "blackcat-vision" };
  }, statusDeps("running"));
  check("probe invokes one worker request", calls === 1);
  check("exact model identity succeeds", success.ok && success.tested && success.responseModel === "blackcat-vision");

  const wrongModel = await managedVisionProbe(true, async () => ({
    ok: true, model: "other", responseModel: "other",
  }), statusDeps("running"));
  check("wrong model identity fails closed", !wrongModel.ok && wrongModel.kind === "error");
  const busy = await managedVisionProbe(true, async () => ({
    ok: false, code: "VISION_DEFERRED", reason: "session lock is held",
  }), statusDeps("running"));
  check("session-lock contention remains untested and retryable",
    !busy.ok && busy.kind === "busy" && !busy.tested);
  const deferred = await managedVisionProbe(true, async () => {
    throw Object.assign(new Error("session lock is held"), { code: "VISION_DEFERRED" });
  }, statusDeps("running"));
  check("thrown deferral also remains untested and retryable",
    !deferred.ok && deferred.kind === "busy" && !deferred.tested);

  console.log("\n== settings and intent boundary ==");
  const defaults = JSON.parse(source("config/defaults.json")).defaults as Record<string, unknown>;
  check("safe local selection cap is four photos",
    LOCAL_VISION_MAX_PHOTOS === 4 && defaults.visionMaxPhotos === LOCAL_VISION_MAX_PHOTOS);
  check("safe local output cap is 1800 tokens",
    LOCAL_VISION_MAX_OUTPUT_TOKENS === 1800 &&
      defaults.visionMaxTokens === LOCAL_VISION_MAX_OUTPUT_TOKENS);
  const forged = {
    visionEnabled: true,
    visionMaxPhotos: 4,
    visionFields: ["size", "brand"],
    visionTimeoutSeconds: 120,
    visionMaxTokens: 1800,
    visionApiUrl: "https://forged.invalid/v1/chat/completions",
    visionModel: "forged-model",
    visionServerPort: 9999,
    visionModelPath: "C:/forged/model.gguf",
  };
  const retired = retiredVisionSettingKeys(forged);
  const cleaned = stripRetiredVisionSettings(forged) as Record<string, unknown>;
  check("arbitrary model and transport controls are retired",
    ["visionApiUrl", "visionModel", "visionServerPort", "visionModelPath"]
      .every((key) => retired.includes(key) && !(key in cleaned)));
  check("bounded behavior settings survive",
    cleaned.visionMaxPhotos === LOCAL_VISION_MAX_PHOTOS &&
      cleaned.visionMaxTokens === LOCAL_VISION_MAX_OUTPUT_TOKENS);

  // A stored row that predates the local-vision work still carries ocrEngine,
  // whose value claims GPU OCR while decode.py pins device="cpu" everywhere.
  const stale = {
    ocrEnabled: true,
    ocrSmartGate: true,
    ocrEngine: "paddleocr-ppocrv5-gpu",
    skuLength: 6,
  };
  const staleRetired = retiredSettingKeys(stale);
  const staleCleaned = stripRetiredSettings(stale) as Record<string, unknown>;
  check("dead ocrEngine key is retired", staleRetired.includes("ocrEngine"));
  check("dead ocrEngine key is stripped", !("ocrEngine" in staleCleaned));
  check("live ocr settings are untouched",
    staleCleaned.ocrEnabled === true && staleCleaned.ocrSmartGate === true &&
      staleCleaned.skuLength === 6);
  check("retirement ignores non-objects",
    retiredSettingKeys(null).length === 0 && retiredSettingKeys("x").length === 0);

  check("literal true is the only no-AI bypass",
    parseProcessIntent({ force: true }).ok &&
    parseProcessIntent({ force: false }).ok &&
    !parseProcessIntent({ force: "true" }).ok);

  console.log("\n== production surfaces ==");
  const manifest = JSON.parse(source("config/local-vision.json")) as { server: { host: string; alias: string } };
  const settingsPage = source("src/app/settings/page.tsx");
  const settingsPolicy = source("src/lib/settings.ts");
  const settingsRoute = source("src/app/api/settings/route.ts");
  const visionRoute = source("src/app/api/vision/route.ts");
  const processRoute = source("src/app/api/process/route.ts");
  check("tracked manifest remains fixed to localhost and alias",
    manifest.server.host === "127.0.0.1" && manifest.server.alias === "blackcat-vision");
  check("settings expose no endpoint, model, path, port, or lifecycle input",
    ["visionApiUrl", "visionModelPath", "visionMmprojPath", "visionServerPort", "visionAutoStart"]
      .every((key) => !settingsPage.includes(key)));
  check("stored settings and API validation use the shared safety caps",
    [settingsPolicy, settingsRoute].every((text) =>
      text.includes("LOCAL_VISION_MAX_PHOTOS") &&
      text.includes("LOCAL_VISION_MAX_OUTPUT_TOKENS")));
  check("settings UI cannot select beyond the safety caps",
    settingsPage.includes("max={LOCAL_VISION_MAX_PHOTOS}") &&
      settingsPage.includes("max={LOCAL_VISION_MAX_OUTPUT_TOKENS}"));
  check("vision API offers probe only", /action !== "probe"/.test(visionRoute) && !/action === "start"/.test(visionRoute));
  check("vision API awaits health-backed status for GET and probe",
    (visionRoute.match(/await managedVisionStatus/g) ?? []).length >= 2);
  const preflightIndex = processRoute.indexOf("await managedVisionStatus(true)");
  const abortBeforeReserveIndex = processRoute.indexOf("if (req.signal.aborted)", preflightIndex);
  const reserveIndex = processRoute.indexOf("tryReserveIntake()");
  const abortBeforeSpawnIndex = processRoute.indexOf("if (req.signal.aborted)", reserveIndex);
  const startIndex = processRoute.indexOf("startIntake(settings");
  check("AI intake returns typed unavailability before intake mutation",
    processRoute.includes('error: "VISION_UNAVAILABLE"') &&
      processRoute.includes("kind: visionStatus.kind") &&
      preflightIndex >= 0 && preflightIndex < reserveIndex && preflightIndex < startIndex);
  check("an abort during vision preflight cannot reserve or spawn intake",
    abortBeforeReserveIndex > preflightIndex &&
      abortBeforeReserveIndex < reserveIndex &&
      abortBeforeSpawnIndex > reserveIndex &&
      abortBeforeSpawnIndex < startIndex &&
      processRoute.slice(abortBeforeSpawnIndex, startIndex).includes("releaseIntakePrep()"));
  check("intake admits vision before opening its stream",
    processRoute.indexOf("await intake.admission") >= 0 &&
    processRoute.indexOf("await intake.admission") < processRoute.indexOf("const stream = new ReadableStream"));

  console.log(`\n${failures === 0 ? "ALL LOCAL VISION BOUNDARY CHECKS PASSED" : `LOCAL VISION FAILURES: ${failures}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("[local-vision] fatal:", error);
  process.exitCode = 1;
});
