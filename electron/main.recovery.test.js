"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const startupGuard = require("./startupGuard");
const { resolveWorkerRuntime } = require("./runtimePaths");

const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const STABLE = 5 * 60 * 1000;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ spawnFailure = false, preparationStatus = 0, listenerOwner, exitAfterReadiness = false } = {}) {
  let now = 0, nextTimer = 0, reloads = 0, readyCallback;
  const children = [], requests = [], timers = new Map(), logs = [], openFiles = new Set(), navigations = [];
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, getPath: () => "C:/fixture-home",
    whenReady: () => ({ then(callback) { readyCallback = callback; } }), quit() {} });
  const modules = {
    electron: { app, ipcMain: { handle() {} } },
    "node:path": path,
    "node:perf_hooks": { performance: { now: () => now } },
    "node:fs": { mkdirSync() {}, existsSync: () => true, openSync: () => { openFiles.add(17); return 17; }, closeSync: id => openFiles.delete(id),
      appendFileSync: (_path, text) => logs.push(text) },
    "node:http": { get: (_url, callback) => { const request = Object.assign(new EventEmitter(), { destroy() {} }); requests.push({ callback, request }); return request; } },
    "node:child_process": { spawnSync: () => ({ status: preparationStatus, stdout: "", stderr: "" }), spawn: () => {
      if (spawnFailure) throw Error("Simulated spawn failure");
      const child = new EventEmitter();
      Object.assign(child, { pid: 1000 + children.length, exitCode: null, signalCode: null, kill() { this.exitCode = 0; this.emit("exit", 0, null); } });
      children.push(child); return child;
    } },
    "./localVisionServer": { start: async () => {}, stop: async () => {} }, "./openEtsyChrome": {},
    "./crawlerDisplay": { watchCrawlerDisplay() {} }, "./saleMonitorWindow": { writeSaleMonitorWindow() {} }, "./nativeBoundary": {}, "./chromeControl": {},
    "./runtimePaths": { resolveWorkerRuntime: options => resolveWorkerRuntime({ ...options, environment: options.environment || {} }) },
    "./workerSetup": { createWorkerSetup: () => ({ start: () => ({ ok: true }), status: () => ({ state: "idle" }), stop: async () => {} }) },
  };
  const setTimer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, dueAt: now + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  modules["./startupGuard"] = {
    prepareDatabase: options => startupGuard.prepareDatabase({ ...options, fsImpl: modules["node:fs"], spawnSyncImpl: modules["node:child_process"].spawnSync }),
    waitForOwnedServer: options => startupGuard.waitForOwnedServer({ ...options, httpGet: modules["node:http"].get,
      findListener: async () => listenerOwner ?? options.child.pid, timers: { setTimeout: setTimer, clearTimeout: clearTimer } })
      .then(() => { if (exitAfterReadiness) options.child.exitCode = 1; }),
    waitForDevelopmentServer: options => startupGuard.waitForDevelopmentServer({ ...options, httpGet: modules["node:http"].get,
      timers: { setTimeout: setTimer, clearTimeout: clearTimer } }),
  };
  const context = vm.createContext({ __dirname, console: { log() {} },
    process: { env: {}, pid: 123, execPath: "C:/fixture-electron.exe", platform: "win32", on() {} },
    require: name => { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]; },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    fixtureWindow: { reload: () => { reloads++; }, isDestroyed: () => false, loadURL: url => navigations.push(url) },
  });
  vm.runInContext(source, context);
  vm.runInContext("win = fixtureWindow", context);
  const run = text => vm.runInContext(text, context);
  function crash() { const child = children.at(-1); child.exitCode = 1; child.emit("exit", 1, null); }
  function restart() {
    const entry = [...timers].find(([, timer]) => timer.delay === 800);
    assert.ok(entry, "An eligible failure must schedule a restart");
    timers.delete(entry[0]); now += 800; entry[1].callback();
  }
  function respond(index = requests.length - 1, statusCode = 200) {
    requests[index].callback({ statusCode, destroy() {} });
  }
  function elapse(milliseconds) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.dueAt <= target).sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].dueAt; next[1].callback();
    }
    now = target;
  }
  return { app, children, requests, timers, logs, openFiles, navigations, run, crash, restart, respond, elapse,
    boot: () => { run("createWindow = () => { win = fixtureWindow; }; createTray = () => {};"); return readyCallback(); },
    start: () => run("startServerIfNeeded()"), ready: async () => { const ready = run("waitForServer(URL)"); respond(); await ready; },
    advance: ms => { now += ms; }, reloads: () => reloads };
}

test("separate failures after stable operation do not exhaust the desktop's lifetime recovery", async () => {
  const h = fixture(); h.start(); await h.ready();
  for (let episode = 0; episode < 8; episode++) {
    h.advance(STABLE); h.crash(); h.restart(); h.respond(); await flush();
  }
  assert.equal(h.children.length, 9);
  assert.equal(h.reloads(), 8);
  assert.equal(h.requests.length, 9, "Recovery reuses startup readiness without adding health probes");
  assert.ok(!h.logs.some(line => line.includes("giving up")));
});

for (const mode of ["rapid", "never ready", "error page", "late readiness"]) {
  test(`${mode} failures still stop after five restart attempts`, async () => {
    const h = fixture(); h.start();
    for (let attempt = 0; attempt < 6; attempt++) {
      if (mode === "late readiness") { h.advance(STABLE * 2); await h.ready(); h.advance(STABLE - 1); }
      else if (mode === "error page") { h.run("waitForServer(URL)").catch(() => {}); h.respond(undefined, 500); await flush(); h.advance(STABLE * 2); }
      else if (mode === "never ready") h.advance(STABLE * 2);
      else await h.ready();
      h.crash(); if (attempt < 5) h.restart();
    }
    assert.equal(h.children.length, 6);
    assert.equal(h.timers.size, 0);
    assert.ok(h.logs.some(line => line.includes("giving up")));
  });
}

test("late readiness from a replaced process cannot reload the current window or reset its recovery", async () => {
  const h = fixture(); h.start(); h.crash(); h.restart();
  h.crash(); h.restart();
  h.respond(0); await flush();
  assert.equal(h.reloads(), 0, "Readiness belongs to the process that was awaited");
  h.advance(STABLE);
  for (let attempt = 2; attempt < 6; attempt++) { h.crash(); if (attempt < 5) h.restart(); }
  assert.equal(h.children.length, 6); assert.equal(h.timers.size, 0);
});

test("repeated readiness reports do not postpone the stable interval", async () => {
  const h = fixture(); h.start();
  for (let attempt = 0; attempt < 5; attempt++) { h.crash(); h.restart(); }
  h.respond(); await flush(); h.advance(STABLE - 1); await h.ready(); h.advance(1);
  h.crash(); h.restart();
  assert.equal(h.children.length, 7);
});

test("quitting cancels restart and ignores in-flight readiness", async () => {
  const h = fixture(); h.start(); h.crash(); h.restart();
  h.crash();
  let prevented = false; h.app.emit("before-quit", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.timers.size, 0);
  h.respond(); await flush();
  assert.equal(h.reloads(), 0); assert.equal(h.children.length, 2);
  h.start(); assert.equal(h.children.length, 2);
});

test("each spawn releases the parent's inherited log descriptor, including a thrown spawn", () => {
  for (const spawnFailure of [false, true]) {
    const h = fixture({ spawnFailure });
    if (spawnFailure) assert.throws(h.start, /Simulated spawn failure/); else h.start();
    assert.equal(h.openFiles.size, 0);
  }
});

test("failed database preparation blocks the desktop server before it can start", () => {
  const h = fixture({ preparationStatus: 2 });
  assert.throws(h.start, { code: "DATABASE_PREPARATION_FAILED" });
  assert.equal(h.children.length, 0); assert.equal(h.openFiles.size, 0);
});

test("a foreign listener's HTTP 200 response cannot mark the desktop server stable", async () => {
  const h = fixture({ listenerOwner: 9876 }); h.start();
  const rejected = assert.rejects(h.run("waitForServer(URL)"), { code: "SERVER_PORT_UNOWNED" });
  h.respond(); await rejected;
  assert.equal(h.run("serverReadyAt"), null); assert.equal(h.reloads(), 0);
});

test("a failed HTTP response is surfaced without marking the desktop server stable", async () => {
  const h = fixture(); h.start();
  const rejected = assert.rejects(h.run("waitForServer(URL)"), { code: "SERVER_RESPONSE_INVALID" });
  h.respond(undefined, 500); await rejected;
  assert.equal(h.run("serverReadyAt"), null); assert.equal(h.reloads(), 0);
});

test("successful recovery leaves the startup error page and returns to the owned application",async()=>{
  const h=fixture();h.start();await h.ready();h.crash();h.restart();
  h.respond(undefined,500);await flush();
  assert.equal(h.navigations.length,1);assert.ok(h.navigations[0].startsWith('data:text/html'));
  h.crash();h.restart();h.respond();await flush();
  assert.equal(h.navigations.at(-1),'http://127.0.0.1:41999');
  assert.equal(h.reloads(),0,'Recovery must navigate away from the data error page instead of reloading it');
  h.advance(STABLE);h.crash();h.restart();h.respond();await flush();
  assert.equal(h.reloads(),1,'Subsequent normal recovery keeps the already-loaded application');
});

test("a stale failed readiness attempt cannot replace a recovered app with an error page",async()=>{
  const h=fixture();h.start();h.crash();h.restart();h.crash();h.restart();
  h.respond();await flush();
  assert.equal(h.navigations.length,0);assert.equal(h.reloads(),1);
  h.respond(0,500);await flush();
  assert.equal(h.navigations.length,0);assert.equal(h.reloads(),1);
});

test("desktop startup displays a local failure screen when database preparation fails",async()=>{
  const h=fixture({preparationStatus:2});await h.boot();
  assert.equal(h.children.length,0);assert.equal(h.requests.length,0);
  assert.equal(h.navigations.length,1);assert.ok(h.navigations[0].startsWith('data:text/html'));
  assert.match(decodeURIComponent(h.navigations[0]),/Black Cat could not start/);
});

test("desktop startup never loads the fixed origin after an invalid server response",async()=>{
  const h=fixture();const started=h.boot();h.respond(undefined,500);await started;
  assert.ok(h.navigations.length>0);assert.ok(h.navigations.every(address=>address.startsWith('data:text/html')));
});

test("a child exiting after readiness resolves cannot receive the initial trusted navigation",async()=>{
  const h=fixture({exitAfterReadiness:true});const started=h.boot();h.respond();await started;
  assert.equal(h.children[0].exitCode,1);assert.deepEqual(h.navigations,[]);assert.equal(h.run('serverReadyAt'),null);
});

test("cold startup can finish its first owned HTTP response after five seconds within the startup budget",async()=>{
  const h=fixture();const started=h.boot();
  h.elapse(7500);h.respond();await started;
  assert.deepEqual(h.navigations,['http://127.0.0.1:41999']);
  assert.equal(h.run('serverReadyAt'),7500);assert.equal(h.timers.size,0);
});

test("a cold HTTP response still cannot exceed the overall startup budget",async()=>{
  const h=fixture();const started=h.boot();h.elapse(30000);await started;
  assert.equal(h.navigations.length,1);assert.ok(h.navigations[0].startsWith('data:text/html'));
  assert.equal(h.run('serverReadyAt'),null);assert.equal(h.timers.size,0);
});
