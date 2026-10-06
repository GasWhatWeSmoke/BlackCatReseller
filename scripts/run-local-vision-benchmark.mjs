import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const localVision = require(path.join(root, "electron", "localVisionServer.js"));
const Q6_PROFILE_PATH = path.join(root, "config", "local-vision-q6-benchmark.json");
const ALLOWED_TUNING = Object.freeze({
  batch: new Set([512, 1024, 2048]),
  microBatch: new Set([256, 512, 1024]),
  threads: new Set([8, 12, 16]),
});
const RESERVED_BENCHMARK_FLAGS = new Set([
  "--model-profile", "--server-pid", "--server-log", "--label", "--rescore",
]);
const FORWARDED_VALUE_FLAGS = new Set([
  "--database", "--items", "--repeats", "--timeout", "--output",
]);

function exactQ6Profile() {
  const revision = "4168f45a16a1290d65a4ec0fa312ae917a4c15d6";
  const base = `https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/${revision}`;
  return {
    schemaVersion: 1,
    kind: "blackcat-local-vision-benchmark-profile",
    id: "qwen3.5-4b-q6-k-l",
    sourceRepository: "bartowski/Qwen_Qwen3.5-4B-GGUF",
    revision,
    directory: "models/qwen3.5-4b-q6-k-l",
    weights: {
      name: "Qwen_Qwen3.5-4B-Q6_K_L.gguf",
      url: `${base}/Qwen_Qwen3.5-4B-Q6_K_L.gguf?download=true`,
      sha256: "0d7931a7f143ccfdf675c0d84d542c387cd9255af94ee9c8fb5fa6f6df7c08a0",
      size: 3959316448,
    },
    projector: {
      name: "mmproj-Qwen_Qwen3.5-4B-bf16.gguf",
      url: `${base}/mmproj-Qwen_Qwen3.5-4B-bf16.gguf?download=true`,
      sha256: "463f39bd1c291c1186c319a8c90ff8640aafa678b14cbee2232d695113dfbb66",
      size: 675569216,
    },
  };
}

export function assertPinnedQ6Profile(profile) {
  if (JSON.stringify(profile) !== JSON.stringify(exactQ6Profile())) {
    throw new Error("Tracked Q6 benchmark profile differs from its reviewed immutable pins");
  }
  return profile;
}

function contained(base, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolvedBase = path.resolve(base);
  const candidate = path.resolve(resolvedBase, relative);
  const prefix = `${resolvedBase}${path.sep}`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} escapes the local vision root`);
  }
  return candidate;
}

function takeOption(args, index, name) {
  const current = args[index];
  if (current === name) {
    if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
    return { value: args[index + 1], consumed: 2 };
  }
  if (current.startsWith(`${name}=`)) {
    return { value: current.slice(name.length + 1), consumed: 1 };
  }
  return null;
}

export function parseRunnerArgs(args) {
  const result = {
    modelProfile: null,
    batch: 512,
    microBatch: 256,
    threads: 12,
    benchmarkArgs: [],
  };
  const seen = new Set();
  for (let index = 0; index < args.length;) {
    let matched = false;
    for (const [flag, key] of [
      ["--model-profile", "modelProfile"],
      ["--batch", "batch"],
      ["--micro-batch", "microBatch"],
      ["--threads", "threads"],
    ]) {
      const option = takeOption(args, index, flag);
      if (!option) continue;
      if (seen.has(flag)) throw new Error(`${flag} may only be supplied once`);
      seen.add(flag);
      result[key] = key === "modelProfile" ? option.value : Number(option.value);
      index += option.consumed;
      matched = true;
      break;
    }
    if (matched) continue;
    const reserved = [...RESERVED_BENCHMARK_FLAGS].find(
      (flag) => args[index] === flag || args[index].startsWith(`${flag}=`),
    );
    if (reserved) throw new Error(`${reserved} is owned by the pinned benchmark launcher`);
    result.benchmarkArgs.push(args[index]);
    index += 1;
  }
  if (result.modelProfile !== "q6") {
    throw new Error("This launcher only accepts the tracked q6 benchmark profile");
  }
  for (const key of ["batch", "microBatch", "threads"]) {
    if (!ALLOWED_TUNING[key].has(result[key])) {
      throw new Error(`Unapproved ${key} value: ${result[key]}`);
    }
  }
  if (result.microBatch > result.batch) {
    throw new Error("Micro-batch may not exceed batch");
  }
  result.benchmarkArgs = validateForwardedBenchmarkArgs(result.benchmarkArgs);
  return result;
}

export function validateForwardedBenchmarkArgs(args) {
  const accepted = [];
  const seen = new Set();
  for (let index = 0; index < args.length;) {
    const token = args[index];
    if (token === "--smoke") {
      if (seen.has(token)) throw new Error(`${token} may only be supplied once`);
      seen.add(token);
      accepted.push(token);
      index += 1;
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (flag === "--photo-counts") {
      if (seen.has(flag)) throw new Error(`${flag} may only be supplied once`);
      seen.add(flag);
      const values = [];
      if (equals >= 0) values.push(token.slice(equals + 1));
      else {
        index += 1;
        while (index < args.length && !args[index].startsWith("--")) {
          values.push(args[index]);
          index += 1;
        }
      }
      if (values.length === 0 || values.some((value) => !/^(?:1|2|4)$/.test(value))) {
        throw new Error("--photo-counts only accepts one or more of 1, 2, and 4");
      }
      accepted.push(flag, ...values);
      if (equals >= 0) index += 1;
      continue;
    }
    if (!FORWARDED_VALUE_FLAGS.has(flag)) {
      throw new Error(`Unapproved forwarded benchmark argument: ${token}`);
    }
    if (seen.has(flag)) throw new Error(`${flag} may only be supplied once`);
    seen.add(flag);
    let value;
    if (equals >= 0) {
      value = token.slice(equals + 1);
      index += 1;
    } else {
      if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      value = args[index + 1];
      index += 2;
    }
    if (!value) throw new Error(`${flag} requires a value`);
    accepted.push(flag, value);
  }
  return accepted;
}

function replaceArgument(args, flag, value) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length || args.indexOf(flag, index + 1) >= 0) {
    throw new Error(`Baseline local vision arguments do not contain exactly one ${flag}`);
  }
  args[index + 1] = String(value);
}

export function buildServerArguments(context, profile, tuning, paths) {
  const baseline = [...localVision.APPROVED_ARGUMENTS];
  replaceArgument(baseline, "-b", tuning.batch);
  replaceArgument(baseline, "-ub", tuning.microBatch);
  replaceArgument(baseline, "-t", tuning.threads);
  return [
    "-m", paths.weights,
    "--mmproj", paths.projector,
    "--alias", "blackcat-vision",
    "--host", "127.0.0.1",
    "--port", "1235",
    "--api-key-file", context.apiKeyFile,
    ...baseline,
    "--log-file", paths.log,
  ];
}

export function sanitizedEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !/^LLAMA_/i.test(name)),
  );
}

export function buildServerSpawnOptions(context, environment = process.env) {
  return {
    cwd: context.runtimeDirectory,
    env: sanitizedEnvironment(environment),
    windowsHide: true,
    // llama-server writes the pinned --log-file itself. Keeping its verbose
    // stream off the console avoids duplicate writes and long-run flooding.
    stdio: "ignore",
  };
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filename);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

async function verifyArtifact(artifact, filename) {
  let stat;
  try { stat = fs.statSync(filename); } catch { stat = null; }
  if (!stat?.isFile() || stat.size !== artifact.size) {
    throw new Error(`Missing or truncated pinned Q6 artifact: ${filename}`);
  }
  if (await sha256File(filename) !== artifact.sha256) {
    throw new Error(`Pinned Q6 artifact failed SHA-256 verification: ${filename}`);
  }
}

async function assertPortAvailable() {
  const server = net.createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 1235, exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(`127.0.0.1:1235 is already in use; close Black Cat before the Q6 run (${error.message})`);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

function getLocalJson(pathname, apiKey) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: 1235,
      path: pathname,
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      timeout: 3000,
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 256 * 1024) response.destroy(new Error("local health receipt exceeded 256 KiB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`local health returned ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("local health timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function waitUntilReady(child, apiKey, timeoutMs, logPath) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited early with code ${child.exitCode}; inspect ${logPath}`);
    }
    try {
      const [health, models] = await Promise.all([
        getLocalJson("/health", apiKey),
        getLocalJson("/v1/models", apiKey),
      ]);
      const aliases = Array.isArray(models?.data) ? models.data.map((entry) => entry?.id) : [];
      if (health?.status === "ok" && aliases.length === 1 && aliases[0] === "blackcat-vision") return;
    } catch {
      // Startup connection failures are expected until the pinned timeout expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Pinned Q6 llama-server did not become healthy before the startup timeout; inspect ${logPath}`);
}

function localPython() {
  const candidates = [
    path.join(root, "worker", ".venv", "Scripts", "python.exe"),
    path.join(root, "worker", "python", "python", "python.exe"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { windowsHide: true, stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("No repo-local worker Python found. Run npm.cmd run worker:setup first.");
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("Pinned Q6 benchmark runtime requires Windows");
  const options = parseRunnerArgs(process.argv.slice(2));
  const profile = assertPinnedQ6Profile(JSON.parse(fs.readFileSync(Q6_PROFILE_PATH, "utf8")));
  const context = localVision.__test.loadContext(root);
  localVision.__test.verifySetupReceipt(context);
  const modelDirectory = contained(context.assetRoot, profile.directory, "Q6 model directory");
  const paths = {
    weights: contained(modelDirectory, profile.weights.name, "Q6 weights"),
    projector: contained(modelDirectory, profile.projector.name, "Q6 projector"),
    log: contained(
      context.assetRoot,
      `logs/llama-server-q6-benchmark-${Date.now()}-${process.pid}.log`,
      "Q6 server log",
    ),
  };
  await Promise.all([
    verifyArtifact(profile.weights, paths.weights),
    verifyArtifact(profile.projector, paths.projector),
  ]);
  await assertPortAvailable();
  fs.mkdirSync(path.dirname(paths.log), { recursive: true });
  const apiKey = fs.readFileSync(context.apiKeyFile, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(apiKey)) throw new Error("Local vision API credential is invalid");
  const serverArgs = buildServerArguments(context, profile, options, paths);
  const child = spawn(
    context.executable,
    serverArgs,
    buildServerSpawnOptions(context),
  );
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await waitUntilReady(child, apiKey, context.config.server.startupTimeoutMs, paths.log);
    const label = `q6-k-l-b${options.batch}-ub${options.microBatch}-t${options.threads}`;
    const benchmarkArgs = [
      path.join(root, "scripts", "benchmark_vision.py"),
      "--model-profile", "q6",
      "--server-pid", String(child.pid),
      "--server-log", paths.log,
      "--label", label,
      ...options.benchmarkArgs,
    ];
    const benchmark = spawn(localPython(), benchmarkArgs, {
      cwd: root,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      stdio: "inherit",
    });
    const [code, signal] = await once(benchmark, "exit");
    if (signal) return 130;
    return Number.isInteger(code) ? code : 1;
  } finally {
    await stopOwnedChild(child);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Q6 benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
}
