"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { prepareDatabase, listenerPid, waitForOwnedServer, waitForDevelopmentServer } = require("./startupGuard");

const flush = () => new Promise(resolve => setImmediate(resolve));
const url = "http://127.0.0.1:41999";

function databaseFixture(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-startup-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appRoot = path.join(root, "app"), dbFile = path.join(root, "data", "black-cat.db"), dataRoot = path.join(root, "var");
  fs.mkdirSync(path.join(appRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "config", "template.db"), "empty template fixture");
  const calls = [];
  const prepare = () => prepareDatabase({ appRoot, dbFile, dataRoot, execPath: process.execPath,
    env: { BLACKCAT_PYTHON: "C:/fixture-runtime/worker/.venv/Scripts/python.exe", BLACKCAT_RUNTIME_ROOT: "C:/fixture-runtime" },
    spawnSyncImpl: (exe, args, options) => { calls.push({ exe, args, options }); return run?.(options, args) ?? { status: 0 }; },
  });
  return { root, appRoot, dbFile, dataRoot, calls, prepare };
}

for (const result of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { status: null, error: Error("timed out") }]) {
  test(`first-run seed failure leaves no permanent or partly seeded database (${result.status}/${result.signal || "exit"})`, t => {
    const h = databaseFixture(t, () => result);
    assert.throws(h.prepare, { code: "DATABASE_PREPARATION_FAILED" });
    assert.equal(fs.existsSync(h.dbFile), false);
    assert.deepEqual(fs.readdirSync(path.dirname(h.dbFile)), []);
  });
}

test("fresh setup promotes only completed seed data with the caller's persistent worker environment", t => {
  const h = databaseFixture(t, options => {
    assert.equal(fs.existsSync(h.dbFile), false, "The user's database does not exist while seeding is incomplete");
    fs.appendFileSync(options.env.DATABASE_URL.slice(5), " seeded");
    return { status: 0 };
  });
  assert.deepEqual(h.prepare(), { created: true });
  assert.equal(fs.readFileSync(h.dbFile, "utf8"), "empty template fixture seeded");
  assert.deepEqual(fs.readdirSync(path.dirname(h.dbFile)), ["black-cat.db"]);
  assert.equal(h.calls[0].options.env.BLACKCAT_PYTHON, "C:/fixture-runtime/worker/.venv/Scripts/python.exe");
  assert.equal(h.calls[0].options.env.BLACKCAT_RUNTIME_ROOT, "C:/fixture-runtime");
  assert.equal(h.calls[0].options.windowsHide, true);
});

test("a failed first run can be retried without treating the failed template as existing inventory", t => {
  let attempt = 0;
  const h = databaseFixture(t, () => ({ status: ++attempt === 1 ? 1 : 0 }));
  assert.throws(h.prepare, { code: "DATABASE_PREPARATION_FAILED" });
  assert.deepEqual(h.prepare(), { created: true });
  assert.equal(attempt, 2);
  assert.ok(h.calls.every(call => path.basename(call.args[0]) === "init-db.mjs"));
});

test("missing templates and unfinished WAL changes block first-run promotion", t => {
  const h = databaseFixture(t, options => {
    fs.writeFileSync(`${options.env.DATABASE_URL.slice(5)}-wal`, "unfinished changes");
    return { status: 0 };
  });
  assert.throws(h.prepare, { code: "DATABASE_PREPARATION_FAILED" });
  assert.equal(fs.existsSync(h.dbFile), false);
  assert.deepEqual(fs.readdirSync(path.dirname(h.dbFile)), []);
  fs.unlinkSync(path.join(h.appRoot, "config", "template.db"));
  assert.throws(h.prepare, { code: "DATABASE_TEMPLATE_MISSING" });
});

test("an existing database is preserved when schema compatibility fails", t => {
  const h = databaseFixture(t, () => ({ status: 2 }));
  fs.mkdirSync(path.dirname(h.dbFile)); fs.writeFileSync(h.dbFile, "existing private inventory fixture");
  assert.throws(h.prepare, { code: "DATABASE_PREPARATION_FAILED" });
  assert.equal(fs.readFileSync(h.dbFile, "utf8"), "existing private inventory fixture");
  assert.equal(path.basename(h.calls[0].args[0]), "schema-sync.mjs");
  assert.equal(h.calls[0].options.env.DATABASE_URL, `file:${h.dbFile}`);
});

test("another first-run destination is never overwritten during promotion", t => {
  const h = databaseFixture(t, () => { fs.writeFileSync(h.dbFile, "concurrent inventory fixture"); return { status: 0 }; });
  assert.throws(h.prepare, { code: "EEXIST" });
  assert.equal(fs.readFileSync(h.dbFile, "utf8"), "concurrent inventory fixture");
  assert.deepEqual(fs.readdirSync(path.dirname(h.dbFile)), ["black-cat.db"]);
});

test("listener identity rejects foreign, wildcard, malformed and ambiguous owners", () => {
  const line = (host, pid) => `  TCP    ${host}:41999    0.0.0.0:0    LISTENING    ${pid}\r\n`;
  assert.equal(listenerPid(line("127.0.0.1", 42), "127.0.0.1", 41999), 42);
  assert.equal(listenerPid("TCP 127.0.0.1:419990 0.0.0.0:0 LISTENING 42", "127.0.0.1", 41999), null);
  for (const output of [line("0.0.0.0", 42), line("[::]", 42), line("127.0.0.1", "garbage"),
    line("127.0.0.1", 42) + line("127.0.0.1", 43)]) {
    assert.throws(() => listenerPid(output, "127.0.0.1", 41999), { code: "SERVER_PORT_UNOWNED" });
  }
});

function readinessFixture(options = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, killed: false });
  let current = true, stopping = false, ownershipReads = 0, nextTimer = 0;
  const requests = [], timers = new Map();
  const settings = { url, child, isCurrent: () => current, isStopping: () => stopping,
    findListener: async () => { ownershipReads++; return 42; },
    httpGet: (_url, response) => {
      const request = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
      requests.push({ request, response }); return request;
    },
    timers: { setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) },
    ...options,
  };
  const wait = () => waitForOwnedServer(settings);
  const respond = (statusCode = 200, index = requests.length - 1) => requests[index].response({ statusCode, destroy() {} });
  const fire = delay => {
    const found = [...timers].find(([, row]) => row.delay === delay); assert.ok(found, `Expected ${delay}ms timer`);
    timers.delete(found[0]); found[1].fn();
  };
  return { child, settings, wait, respond, fire, requests, timers, ownershipReads: () => ownershipReads,
    replace: () => { current = false; }, quit: () => { stopping = true; } };
}

test("readiness accepts only the live owned child and disposes request/timers/listeners", async () => {
  const h = readinessFixture(); const ready = h.wait(); h.respond(); await ready;
  assert.equal(h.ownershipReads(), 1); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].request.destroyed, true); assert.equal(h.timers.size, 0);
  assert.equal(h.child.listenerCount("exit"), 0); assert.equal(h.child.listenerCount("error"), 0);
});

for (const status of [302, 404, 500, undefined]) {
  test(`HTTP ${status} cannot make a server trusted`, async () => {
    const h = readinessFixture(); const rejected = assert.rejects(h.wait(), { code: "SERVER_RESPONSE_INVALID" });
    h.requests[0].response({ statusCode: status, destroy() {} }); await rejected;
    assert.equal(h.ownershipReads(), 0); assert.equal(h.timers.size, 0);
  });
}

test("a listening foreign process never becomes trusted despite its HTTP 200 response", async () => {
  for (const owner of [41, null]) {
    const h = readinessFixture({ findListener: async () => owner });
    const rejected = assert.rejects(h.wait(), { code: "SERVER_PORT_UNOWNED" }); h.respond(); await rejected;
  }
});

test("production never accepts a missing, exited, killed or replaced child", async () => {
  for (const mode of ["missing", "exited", "killed", "replaced", "quitting"]) {
    const h = readinessFixture();
    if (mode === "missing") h.settings.child = null;
    if (mode === "exited") h.child.exitCode = 1;
    if (mode === "killed") h.child.killed = true;
    if (mode === "replaced") h.replace();
    if (mode === "quitting") h.quit();
    await assert.rejects(h.wait(), { code: "SERVER_PROCESS_EXITED" });
    assert.equal(h.requests.length, 0);
  }
});

test("exit or replacement during ownership inspection cannot accept an old response", async () => {
  for (const mode of ["exit", "replacement"]) {
    let complete;
    const h = readinessFixture({ findListener: () => new Promise(resolve => { complete = resolve; }) });
    const rejected = assert.rejects(h.wait(), { code: "SERVER_PROCESS_EXITED" }); h.respond(); await flush();
    if (mode === "exit") { h.child.exitCode = 1; h.child.emit("exit", 1); } else h.replace();
    complete(42); await rejected; assert.equal(h.timers.size, 0);
  }
});

test("a hung HTTP response and a hung ownership check both have bounded deadlines", async () => {
  const h = readinessFixture(); const timeout = assert.rejects(h.wait(), { code: "SERVER_REQUEST_TIMEOUT" });
  h.fire(5000); await timeout; assert.equal(h.requests[0].request.destroyed, true);
  const slow = readinessFixture({ findListener: () => new Promise(() => {}) });
  const deadline = assert.rejects(slow.wait(), { code: "SERVER_STARTUP_TIMEOUT" }); slow.respond(); await flush();
  slow.fire(30000); await deadline; assert.equal(slow.timers.size, 0);
});

test("connection refusal retries without losing the startup deadline", async () => {
  const h = readinessFixture(); const ready = h.wait();
  h.requests[0].request.emit("error", Object.assign(Error("not listening yet"), { code: "ECONNREFUSED" }));
  h.fire(400); assert.equal(h.requests.length, 2); h.respond(); await ready;
  assert.equal(h.timers.size, 0);
});

test("a late response from a failed request cannot authenticate a newer request", async () => {
  const h = readinessFixture(); let accepted = false;
  const ready = h.wait().then(() => { accepted = true; });
  h.requests[0].request.emit("error", Object.assign(Error("reset"), { code: "ECONNRESET" }));
  h.fire(400); h.respond(200, 0); await flush();
  assert.equal(accepted, false); assert.equal(h.ownershipReads(), 0);
  h.respond(); await ready; assert.equal(accepted, true);
});

test("the separately started development server uses explicit bounded development readiness", async () => {
  const h = readinessFixture({ findListener: async () => { throw Error("Development has no owned child"); } });
  const ready = waitForDevelopmentServer(h.settings); h.respond(); await ready;
  const invalid = readinessFixture({ url: "https://example.invalid" });
  await assert.rejects(invalid.wait(), { code: "SERVER_ORIGIN_INVALID" });
  assert.equal(invalid.requests.length, 0);
});

test("only an explicitly allowed high loopback preview port can differ from production",async()=>{
  for(const port of [49152,53000,65535]){
    const denied=readinessFixture({url:`http://127.0.0.1:${port}`});
    await assert.rejects(denied.wait(),{code:'SERVER_ORIGIN_INVALID'});assert.equal(denied.requests.length,0);
    const preview=readinessFixture({url:`http://127.0.0.1:${port}`,allowPreviewPort:true});
    const ready=preview.wait();preview.respond();await ready;assert.equal(preview.ownershipReads(),1);
  }
  for(const address of ['http://localhost:53000','http://0.0.0.0:53000','http://127.0.0.1:49151','https://127.0.0.1:53000',
    'http://user@127.0.0.1:53000','http://user@127.0.0.1:41999']){
    const h=readinessFixture({url:address,allowPreviewPort:true});
    await assert.rejects(h.wait(),{code:'SERVER_ORIGIN_INVALID'});assert.equal(h.requests.length,0);
  }
});
