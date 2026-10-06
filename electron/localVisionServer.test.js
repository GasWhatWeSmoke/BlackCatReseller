"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  commandLineHasExactArgv,
  parseWindowsCommandLine,
  serializeWindowsCommandLine,
} = require("./windowsCommandLine.js");

const {
  APPROVED_ARGUMENTS,
  createLocalVisionServer,
  __test,
} = require("./localVisionServer.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEMP_PREFIX = path.join(os.tmpdir(), "blackcat-local-vision-supervisor-");

class FakeChild extends EventEmitter {
  constructor(pid, onExit) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
    this.onExit = onExit;
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.exitCode = 0;
    this.onExit();
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }

  crash(code = 1) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.onExit();
    this.emit("exit", code, null);
  }
}

function sha256(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function makeHarness() {
  const root = fs.mkdtempSync(TEMP_PREFIX);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "config", "local-vision.json"),
    path.join(root, "config", "local-vision.json"),
  );
  const context = __test.loadContext(root);
  fs.mkdirSync(context.runtimeDirectory, { recursive: true });
  fs.mkdirSync(context.modelDirectory, { recursive: true });
  fs.writeFileSync(context.executable, "fake pinned llama-server b10218");
  fs.writeFileSync(context.weights, "fake model fixture");
  fs.writeFileSync(context.projector, "fake projector fixture");
  fs.writeFileSync(context.apiKeyFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
  const executableSha256 = sha256(context.executable);

  let nextPid = 41_000;
  let listenerPid = null;
  let spawnCount = 0;
  let killCount = 0;
  let failedHealthChecks = 0;
  let lastSpawn = null;
  const fetchHeaders = [];
  const processes = new Map();
  const children = [];

  const spawnImpl = (executable, args, options) => {
    spawnCount += 1;
    const pid = nextPid++;
    const commandLine = serializeWindowsCommandLine([executable, ...args]);
    const info = {
      pid,
      executablePath: executable,
      commandLine,
      creationTime: `2026-08-17T22:00:${String(spawnCount).padStart(2, "0")}.0000000Z`,
    };
    processes.set(pid, info);
    listenerPid = pid;
    const child = new FakeChild(pid, () => {
      processes.delete(pid);
      if (listenerPid === pid) listenerPid = null;
    });
    children.push(child);
    lastSpawn = { executable, args: [...args], options, child };
    return child;
  };

  const inspectProcess = async (pid) => processes.get(pid) || null;
  const findListenerPid = async () => listenerPid;
  const fetchImpl = async (url, options = {}) => {
    fetchHeaders.push(options.headers || {});
    if (url.endsWith("/health") && failedHealthChecks > 0) {
      failedHealthChecks -= 1;
      return { ok: false, json: async () => ({ status: "unavailable" }) };
    }
    return {
      ok: true,
      json: async () => url.endsWith("/health")
        ? { status: "ok" }
        : { data: [{ id: "blackcat-vision" }] },
    };
  };
  const killProcess = (pid) => {
    killCount += 1;
    processes.delete(pid);
    if (listenerPid === pid) listenerPid = null;
  };
  const options = {
    appRoot: root,
    spawnImpl,
    inspectProcess,
    findListenerPid,
    fetchImpl,
    killProcess,
    verifySetup: async () => ({ executableSha256 }),
    sleep: async () => {},
    monitorEnabled: false,
  };

  return {
    root,
    context,
    options,
    processes,
    children,
    get listenerPid() { return listenerPid; },
    set listenerPid(value) { listenerPid = value; },
    get spawnCount() { return spawnCount; },
    get killCount() { return killCount; },
    get lastSpawn() { return lastSpawn; },
    fetchHeaders,
    failNextHealthChecks(count) { failedHealthChecks = count; },
    cleanup() {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(TEMP_PREFIX));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

function makeSetupVerificationFixture(externalAssets = false) {
  const root = fs.mkdtempSync(TEMP_PREFIX);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "config", "local-vision.json"),
    path.join(root, "config", "local-vision.json"),
  );
  const context = __test.loadContext(root, undefined, externalAssets ? { BLACKCAT_VISION_ROOT: path.join(root, 'persistent assets/vision') } : {});
  fs.mkdirSync(path.join(context.runtimeDirectory, "backend", "cuda"), { recursive: true });
  fs.mkdirSync(context.modelDirectory, { recursive: true });
  fs.writeFileSync(context.executable, "fixture llama server");
  const dependency = path.join(context.runtimeDirectory, "backend", "cuda", "backend.dll");
  fs.writeFileSync(dependency, "fixture CUDA backend");
  fs.writeFileSync(context.weights, "fixture weights");
  fs.writeFileSync(context.projector, "fixture projector");
  fs.writeFileSync(context.apiKeyFile, `${"a".repeat(64)}\n`, { mode: 0o600 });

  context.config.model.weights.size = fs.statSync(context.weights).size;
  context.config.model.projector.size = fs.statSync(context.projector).size;
  const portable = (filename) => path.relative(context.assetRoot, filename).replaceAll("\\", "/");
  const runtimeFiles = __test.runtimeFileInventory(context.runtimeDirectory)
    .map(({ name, size, sha256: fileSha256 }) => ({ name, size, sha256: fileSha256 }));
  const receipt = {
    schemaVersion: 1,
    kind: "blackcat-local-vision-setup",
    configSha256: context.configSha256,
    assetRoot: context.assetRoot,
    runtime: {
      id: context.config.runtime.id,
      executable: portable(context.executable),
      executableSha256: sha256(context.executable),
      files: runtimeFiles,
    },
    model: {
      id: context.config.model.id,
      weights: portable(context.weights),
      projector: portable(context.projector),
    },
    server: {
      host: context.config.server.host,
      port: context.config.server.port,
      alias: context.config.server.alias,
      apiKeyFile: portable(context.apiKeyFile),
      apiKeySha256: sha256(context.apiKeyFile),
    },
    artifacts: [
      ...context.config.runtime.archives,
      context.config.model.weights,
      context.config.model.projector,
    ].map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, size: artifact.size })),
  };
  const writeReceipt = () => {
    fs.writeFileSync(context.setupReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  };
  writeReceipt();
  return {
    root,
    context,
    dependency,
    receipt,
    writeReceipt,
    cleanup() {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(TEMP_PREFIX));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("Windows command-line parsing preserves the exact spawned argv", () => {
  const expected = [
    "C:\\Program Files\\llama.cpp\\llama-server.exe",
    "--model", "E:\\Models\\Qwen model.gguf",
    "--label", 'quoted "value"',
    "--directory", "E:\\Trailing Slash\\",
    "",
  ];
  const commandLine = serializeWindowsCommandLine(expected);
  assert.deepEqual(parseWindowsCommandLine(commandLine), expected);
  assert.equal(commandLineHasExactArgv(commandLine, expected), true);
  assert.equal(
    commandLineHasExactArgv('"app.exe" plain', ["app.exe", "plain"]),
    false,
    "noncanonical alternative quoting fails closed even when Windows would produce the same argv",
  );
  assert.equal(parseWindowsCommandLine(` ${commandLine}`), null, "ambiguous leading whitespace fails closed");
});

test("canonical argv matches the command line reported for a real Windows spawn", {
  skip: process.platform !== "win32",
}, async (context) => {
  const args = [
    "-e", "setTimeout(() => {}, 30000)", "--",
    "plain", "space value", "E:\\Trailing Slash\\", 'quoted "value"', "",
  ];
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: "ignore" });
  context.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await waitFor(() => Number.isSafeInteger(child.pid), "real child did not receive a PID");

  const info = await __test.inspectWindowsProcess(child.pid);
  const expectedArgv = [process.execPath, ...args];
  assert.equal(info.commandLine, serializeWindowsCommandLine(expectedArgv));
  assert.deepEqual(parseWindowsCommandLine(info.commandLine), expectedArgv);
  child.kill();
});

test("setup verification hashes the complete recursive runtime inventory", (context) => {
  const fixture = makeSetupVerificationFixture();
  context.after(() => fixture.cleanup());

  assert.equal(fixture.receipt.runtime.files.length, 2);
  assert.ok(fixture.receipt.runtime.files.some((entry) => entry.name === "backend/cuda/backend.dll"));
  assert.doesNotThrow(() => __test.verifySetupReceipt(fixture.context));

  fs.writeFileSync(fixture.dependency, "tampered CUDA backend");
  assert.throws(
    () => __test.verifySetupReceipt(fixture.context),
    (error) => error?.code === "SETUP_REQUIRED" && /corrupt/.test(error.message),
  );
});

test("relocated vision retains pinned receipt identity across application replacement", (testContext) => {
  const fixture = makeSetupVerificationFixture(true);
  testContext.after(() => fixture.cleanup());
  assert.notEqual(fixture.context.assetRoot, path.join(fixture.root, '.local/vision'));
  assert.doesNotThrow(() => __test.verifySetupReceipt(fixture.context));
  const newAppRoot = path.join(fixture.root, 'new application');
  fs.mkdirSync(path.join(newAppRoot, 'config'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'config/local-vision.json'), path.join(newAppRoot, 'config/local-vision.json'));
  const updated = __test.loadContext(newAppRoot, undefined, { BLACKCAT_VISION_ROOT: fixture.context.assetRoot });
  for (const field of ['assetRoot', 'runtimeDirectory', 'modelDirectory', 'executable', 'weights', 'projector', 'apiKeyFile', 'setupReceipt', 'stateReceipt', 'log', 'configSha256']) {
    assert.equal(updated[field], fixture.context[field], field);
  }
  fixture.receipt.assetRoot = path.join(fixture.root, 'foreign-assets');
  fixture.writeReceipt();
  assert.throws(() => __test.verifySetupReceipt(fixture.context), error => error.code === 'SETUP_REQUIRED');
  const manifestPath = path.join(newAppRoot, 'config/local-vision.json');
  const changed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  changed.runtime.directory = '../outside';
  fs.writeFileSync(manifestPath, JSON.stringify(changed));
  assert.throws(() => __test.loadContext(newAppRoot, undefined, { BLACKCAT_VISION_ROOT: fixture.context.assetRoot }), /escapes/);
});

test("setup verification rejects missing and extra runtime files", (context) => {
  const missing = makeSetupVerificationFixture();
  context.after(() => missing.cleanup());
  fs.unlinkSync(missing.dependency);
  assert.throws(
    () => __test.verifySetupReceipt(missing.context),
    (error) => error?.code === "SETUP_REQUIRED" && /file set/.test(error.message),
  );

  const extra = makeSetupVerificationFixture();
  context.after(() => extra.cleanup());
  fs.writeFileSync(path.join(extra.context.runtimeDirectory, "unreceipted.dll"), "extra");
  assert.throws(
    () => __test.verifySetupReceipt(extra.context),
    (error) => error?.code === "SETUP_REQUIRED" && /file set/.test(error.message),
  );
});

test("setup verification rejects escaping and duplicate runtime receipt paths", (context) => {
  const escaping = makeSetupVerificationFixture();
  context.after(() => escaping.cleanup());
  escaping.receipt.runtime.files[0].name = "../outside.dll";
  escaping.writeReceipt();
  assert.throws(
    () => __test.verifySetupReceipt(escaping.context),
    (error) => error?.code === "SETUP_REQUIRED" && /escapes/.test(error.message),
  );

  const duplicate = makeSetupVerificationFixture();
  context.after(() => duplicate.cleanup());
  duplicate.receipt.runtime.files[1].name = duplicate.receipt.runtime.files[0].name;
  duplicate.writeReceipt();
  assert.throws(
    () => __test.verifySetupReceipt(duplicate.context),
    (error) => error?.code === "SETUP_REQUIRED" && /Duplicate/.test(error.message),
  );
});

test("builds only the pinned localhost GPU-only command", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);

  const state = await supervisor.start();
  assert.equal(state.state, "running");
  assert.equal(state.adopted, false);
  assert.equal(harness.spawnCount, 1);
  assert.equal(path.resolve(harness.lastSpawn.executable), path.resolve(harness.context.executable));
  assert.deepEqual(harness.lastSpawn.args, __test.buildArguments(harness.context));
  assert.deepEqual(
    harness.lastSpawn.args.slice(12, 12 + APPROVED_ARGUMENTS.length),
    [...APPROVED_ARGUMENTS],
  );
  assert.equal(harness.lastSpawn.options.windowsHide, true);
  assert.equal(harness.lastSpawn.options.cwd, harness.context.runtimeDirectory);
  assert.equal(harness.lastSpawn.options.stdio, "ignore", "llama --log-file is the only log writer");
  assert.equal(harness.lastSpawn.args.filter((value) => value === "--log-file").length, 1);
  assert.equal(harness.lastSpawn.args[10], "--api-key-file");
  assert.equal(harness.lastSpawn.args[11], harness.context.apiKeyFile);
  assert.ok(!harness.lastSpawn.args.includes("a".repeat(64)), "secret never enters argv");
  assert.ok(harness.fetchHeaders.length >= 2);
  assert.ok(harness.fetchHeaders.every((headers) =>
    headers.Authorization === `Bearer ${"a".repeat(64)}`));

  const receipt = JSON.parse(fs.readFileSync(harness.context.stateReceipt, "utf8"));
  assert.equal(receipt.owner, "blackcat-reseller");
  assert.equal(receipt.pid, state.pid);
  assert.equal(receipt.alias, "blackcat-vision");
  assert.equal(receipt.state, "running");
  assert.match(receipt.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(Number.isFinite(Date.parse(receipt.startedAt)));

  await supervisor.stop();
  assert.equal(harness.children[0].killed, true);
  assert.equal(harness.killCount, 0, "direct owned child uses its exact ChildProcess handle");
});

test("strips every LLAMA_* environment override before spawning", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const original = {
    LLAMA_ARG_MODEL: process.env.LLAMA_ARG_MODEL,
    llama_api_key: process.env.llama_api_key,
    BlackCatSafeFixture: process.env.BlackCatSafeFixture,
  };
  process.env.LLAMA_ARG_MODEL = "C:\\attacker\\other.gguf";
  process.env.llama_api_key = "leaked-secret";
  process.env.BlackCatSafeFixture = "preserved";
  try {
    const supervisor = createLocalVisionServer(harness.options);
    await supervisor.start();
    assert.equal(harness.lastSpawn.options.env.LLAMA_ARG_MODEL, undefined);
    assert.equal(harness.lastSpawn.options.env.llama_api_key, undefined);
    assert.equal(harness.lastSpawn.options.env.BlackCatSafeFixture, "preserved");
    assert.equal(JSON.stringify(harness.lastSpawn.options.env).includes("leaked-secret"), false);
    await supervisor.stop();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("refuses an unreceipted listener and never kills it", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  harness.listenerPid = 55_555;
  harness.processes.set(55_555, {
    pid: 55_555,
    executablePath: "C:\\other\\server.exe",
    commandLine: "other-server --port 1235",
    creationTime: "2026-08-17T20:00:00.0000000Z",
  });
  const supervisor = createLocalVisionServer(harness.options);

  await assert.rejects(
    supervisor.start(),
    (error) => error?.code === "PORT_IN_USE_UNOWNED" && /Refusing to adopt or kill/.test(error.message),
  );
  assert.equal(supervisor.getState().state, "blocked");
  assert.equal(harness.spawnCount, 0);
  assert.equal(harness.killCount, 0);
  assert.ok(harness.processes.has(55_555));
});

test("adopts only the exact receipted process and may stop that PID", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const original = createLocalVisionServer(harness.options);
  const originalState = await original.start();
  assert.equal(harness.spawnCount, 1);

  const adopting = createLocalVisionServer(harness.options);
  const adopted = await adopting.start();
  assert.equal(adopted.state, "running");
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.pid, originalState.pid);
  assert.equal(adopted.endpoint, "http://127.0.0.1:1235");
  assert.equal(adopted.alias, "blackcat-vision");
  assert.equal(harness.spawnCount, 1, "adoption did not start a competing server");

  const stopped = await adopting.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(harness.killCount, 1, "the revalidated adopted PID was stopped directly");
  assert.equal(harness.processes.has(originalState.pid), false);
});

for (const [description, extraArguments] of [
  ["a conflicting duplicate port", ["--port", "9999"]],
  ["an extra duplicate switch", ["--no-webui"]],
]) {
  test(`adoption rejects ${description} even when every required token remains`, async (context) => {
    const harness = makeHarness();
    context.after(() => harness.cleanup());
    const original = createLocalVisionServer(harness.options);
    const originalState = await original.start();
    const info = harness.processes.get(originalState.pid);
    const forgedCommandLine = `${info.commandLine} ${serializeWindowsCommandLine(extraArguments)}`;
    harness.processes.set(originalState.pid, { ...info, commandLine: forgedCommandLine });
    const receipt = JSON.parse(fs.readFileSync(harness.context.stateReceipt, "utf8"));
    receipt.commandLine = forgedCommandLine;
    fs.writeFileSync(harness.context.stateReceipt, `${JSON.stringify(receipt, null, 2)}\n`);

    const adopting = createLocalVisionServer(harness.options);
    await assert.rejects(
      adopting.start(),
      (error) => error?.code === "PORT_IN_USE_UNOWNED" && /ownership receipt/.test(error.message),
    );
    assert.equal(harness.spawnCount, 1);
    assert.equal(harness.killCount, 0);
    assert.ok(harness.processes.has(originalState.pid));
  });
}

test("ownership drift blocks shutdown instead of killing a reused PID", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const original = createLocalVisionServer(harness.options);
  const originalState = await original.start();
  const adopting = createLocalVisionServer(harness.options);
  await adopting.start();

  const reused = harness.processes.get(originalState.pid);
  harness.processes.set(originalState.pid, {
    ...reused,
    creationTime: "2026-08-17T23:59:59.0000000Z",
    commandLine: "unrelated-server --port 1235",
  });
  await assert.rejects(
    adopting.stop(),
    (error) => error?.code === "OWNERSHIP_LOST" && /Refusing to kill/.test(error.message),
  );
  assert.equal(adopting.getState().state, "blocked");
  assert.equal(adopting.getState().pid, originalState.pid);
  assert.equal(harness.killCount, 0);
  assert.ok(harness.processes.has(originalState.pid));
});

test("a malformed adoption receipt cannot expand the restart budget", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const original = createLocalVisionServer(harness.options);
  const originalState = await original.start();
  const receipt = JSON.parse(fs.readFileSync(harness.context.stateReceipt, "utf8"));
  receipt.restartCount = -1;
  fs.writeFileSync(harness.context.stateReceipt, `${JSON.stringify(receipt, null, 2)}\n`);

  const adopting = createLocalVisionServer(harness.options);
  await assert.rejects(
    adopting.start(),
    (error) => error?.code === "PORT_IN_USE_UNOWNED" && /ownership receipt/.test(error.message),
  );
  assert.equal(adopting.getState().state, "blocked");
  assert.equal(harness.killCount, 0);
  assert.ok(harness.processes.has(originalState.pid));
});

for (const [description, corrupt] of [
  ["an empty instance ID", (receipt) => { receipt.instanceId = ""; }],
  ["a non-v4 instance ID", (receipt) => { receipt.instanceId = "00000000-0000-1000-8000-000000000000"; }],
  ["a missing startedAt", (receipt) => { delete receipt.startedAt; }],
  ["an invalid startedAt", (receipt) => { receipt.startedAt = "not-a-timestamp"; }],
  ["a partial process identity", (receipt) => { receipt.creationTime = null; }],
]) {
  test(`adoption rejects ${description}`, async (context) => {
    const harness = makeHarness();
    context.after(() => harness.cleanup());
    const original = createLocalVisionServer(harness.options);
    const originalState = await original.start();
    const receipt = JSON.parse(fs.readFileSync(harness.context.stateReceipt, "utf8"));
    corrupt(receipt);
    fs.writeFileSync(harness.context.stateReceipt, `${JSON.stringify(receipt, null, 2)}\n`);

    const adopting = createLocalVisionServer(harness.options);
    await assert.rejects(
      adopting.start(),
      (error) => error?.code === "PORT_IN_USE_UNOWNED" && /ownership receipt/.test(error.message),
    );
    assert.equal(harness.killCount, 0);
    assert.ok(harness.processes.has(originalState.pid));
  });
}

test("stop during startup listener discovery prevents the child spawn", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  let listenerLookups = 0;
  let releaseDiscovery;
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  const supervisor = createLocalVisionServer({
    ...harness.options,
    findListenerPid: async () => {
      listenerLookups += 1;
      if (listenerLookups === 1) return null;
      return discovery;
    },
  });

  const starting = supervisor.start();
  const startRejected = assert.rejects(
    starting,
    (error) => error?.code === "START_CANCELLED",
  );
  await waitFor(() => listenerLookups === 2, "startup did not reach listener discovery");
  const stopping = supervisor.stop();
  releaseDiscovery(null);

  await startRejected;
  const stopped = await stopping;
  assert.equal(stopped.state, "stopped");
  assert.equal(harness.spawnCount, 0);
  assert.equal(harness.children.length, 0);
});

for (const spawnErrorCode of ["ENOENT", "EACCES"]) {
  test(`an asynchronous ${spawnErrorCode} spawn error is contained`, async (context) => {
    const harness = makeHarness();
    context.after(() => harness.cleanup());
    let attempts = 0;
    const failedChildren = [];
    const supervisor = createLocalVisionServer({
      ...harness.options,
      spawnImpl: () => {
        attempts += 1;
        const child = new FakeChild(undefined, () => {});
        failedChildren.push(child);
        const error = Object.assign(new Error(`fake ${spawnErrorCode} from spawn`), {
          code: spawnErrorCode,
        });
        queueMicrotask(() => child.emit("error", error));
        return child;
      },
    });

    await assert.rejects(
      supervisor.start(),
      (error) => error?.code === "SPAWN_FAILED" && error.message.includes(spawnErrorCode),
    );
    assert.equal(supervisor.getState().state, "failed");
    assert.equal(attempts, 2, "the spawn failure may consume only the single restart budget");
    assert.equal(supervisor.getState().restartCount, 1);
    assert.ok(failedChildren.every((child) => child.killed), "each exact failed child handle was cleaned up");
  });
}

test("an unexpected child exit gets exactly one restart", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);
  await supervisor.start();
  const first = harness.children[0];

  first.crash(7);
  await waitFor(
    () => harness.spawnCount === 2 && supervisor.getState().state === "running",
    "supervisor did not complete its one restart",
  );
  assert.equal(supervisor.getState().restartCount, 1);

  harness.children[1].crash(8);
  await waitFor(
    () => supervisor.getState().state === "failed",
    "supervisor did not stop after exhausting the restart budget",
  );
  assert.equal(harness.spawnCount, 2, "a second restart must never be attempted");
  assert.equal(supervisor.getState().restartCount, 1);
});

test("a transient process inspection failure leaves the tracked server running", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);
  const running = await supervisor.start();
  const inspectProcess = supervisor.inspectProcess;
  supervisor.inspectProcess = async () => { throw new Error("temporary CIM failure"); };

  await supervisor._monitorTick();

  assert.equal(supervisor.getState().state, "running");
  assert.equal(supervisor.getState().pid, running.pid);
  assert.equal(harness.children[0].killed, false);
  supervisor.inspectProcess = inspectProcess;
  await supervisor.stop();
});

test("shutdown retains a tracked PID when inspection is temporarily unavailable", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);
  const running = await supervisor.start();
  const inspectProcess = supervisor.inspectProcess;
  supervisor.inspectProcess = async () => { throw new Error("temporary CIM failure"); };

  await assert.rejects(
    supervisor.stop(),
    (error) => error?.code === "OWNERSHIP_LOST" && /inspection failed/.test(error.message),
  );
  assert.equal(supervisor.getState().state, "blocked");
  assert.equal(supervisor.getState().pid, running.pid);
  assert.equal(harness.children[0].killed, false);

  supervisor.inspectProcess = inspectProcess;
  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(harness.children[0].killed, true);
});

test("shutdown does not treat a transient post-kill inspection error as confirmed gone", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const original = createLocalVisionServer(harness.options);
  const running = await original.start();
  const adopting = createLocalVisionServer(harness.options);
  await adopting.start();
  let inspections = 0;
  let kills = 0;
  adopting.killProcess = () => { kills += 1; };
  adopting.inspectProcess = async (pid) => {
    inspections += 1;
    if (inspections === 2) throw new Error("temporary CIM failure after termination request");
    if (inspections >= 3) {
      harness.processes.delete(pid);
      harness.listenerPid = null;
      return null;
    }
    return harness.processes.get(pid) || null;
  };

  const stopped = await adopting.stop();

  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.pid, null);
  assert.equal(kills, 1);
  assert.ok(inspections >= 3, "shutdown must retry inspection before confirming absence");
  assert.equal(harness.processes.has(running.pid), false);
});

test("monitor identity drift blocks while retaining the tracked PID", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);
  const running = await supervisor.start();
  const info = harness.processes.get(running.pid);
  harness.processes.set(running.pid, {
    ...info,
    commandLine: "unrelated-server --port 1235",
  });

  await supervisor._monitorTick();

  assert.equal(supervisor.getState().state, "blocked");
  assert.equal(supervisor.getState().pid, running.pid);
  assert.equal(harness.children[0].killed, false);
  await assert.rejects(supervisor.stop(), (error) => error?.code === "OWNERSHIP_LOST");
  assert.equal(supervisor.getState().pid, running.pid);
});

test("a confirmed-gone adopted process consumes the restart budget", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const original = createLocalVisionServer(harness.options);
  const originalState = await original.start();
  const adopting = createLocalVisionServer(harness.options);
  await adopting.start();
  harness.processes.delete(originalState.pid);
  harness.listenerPid = null;

  await adopting._monitorTick();

  assert.equal(adopting.getState().state, "running");
  assert.equal(adopting.getState().adopted, false);
  assert.equal(adopting.getState().restartCount, 1);
  assert.equal(harness.spawnCount, 2);
  assert.notEqual(adopting.getState().pid, originalState.pid);
  await adopting.stop();
});

test("three failed health-and-model probes terminate only the owned child and restart once", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);
  await supervisor.start();
  const first = harness.children[0];
  harness.failNextHealthChecks(3);

  await supervisor._monitorTick();
  await supervisor._monitorTick();
  assert.equal(first.killed, false, "transient health failures do not restart immediately");
  await supervisor._monitorTick();

  await waitFor(
    () => harness.spawnCount === 2 && supervisor.getState().state === "running",
    "unhealthy owned process did not consume the single restart",
  );
  assert.equal(first.killed, true);
  assert.equal(harness.killCount, 0, "the exact child handle was used, not a broad PID kill");
  assert.equal(supervisor.getState().restartCount, 1);
});

test("wildcard and non-loopback listeners on port 1235 are treated as unowned", () => {
  const output = [
    "  TCP    127.0.0.1:1235       0.0.0.0:0       LISTENING       100",
    "  TCP    0.0.0.0:1235         0.0.0.0:0       LISTENING       200",
    "  TCP    [::]:1235            [::]:0          LISTENING       300",
    "  TCP    192.168.1.8:1235     0.0.0.0:0       LISTENING       400",
  ].join("\r\n");
  const listeners = __test.parseNetstatListeners(output, 1235);
  assert.deepEqual(listeners, [
    { address: "127.0.0.1", pid: 100 },
    { address: "0.0.0.0", pid: 200 },
    { address: "::", pid: 300 },
    { address: "192.168.1.8", pid: 400 },
  ]);
  assert.throws(
    () => __test.selectListenerPid(listeners, "127.0.0.1", 1235),
    (error) => error?.code === "PORT_IN_USE_UNOWNED" && /0\.0\.0\.0/.test(error.message),
  );
  assert.equal(
    __test.selectListenerPid([{ address: "127.0.0.1", pid: 100 }], "127.0.0.1", 1235),
    100,
  );
});

test("a wildcard listener appearing during monitoring blocks without a kill", async (context) => {
  const harness = makeHarness();
  context.after(() => harness.cleanup());
  const supervisor = createLocalVisionServer(harness.options);
  const running = await supervisor.start();
  harness.options.findListenerPid = async () => {
    const error = new Error("Port 1235 is already listening on 0.0.0.0 (PID 60000)");
    error.code = "PORT_IN_USE_UNOWNED";
    throw error;
  };
  supervisor.findListenerPid = harness.options.findListenerPid;

  await supervisor._monitorTick();
  assert.equal(supervisor.getState().state, "blocked");
  assert.equal(supervisor.getState().pid, running.pid);
  assert.match(supervisor.getState().error, /no process was killed/);
  assert.equal(harness.children[0].killed, false);
  assert.equal(harness.killCount, 0);
});
