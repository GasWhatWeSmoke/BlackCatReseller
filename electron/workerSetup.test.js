const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWorkerSetup } = require('./workerSetup');

function fixture(t, verify = async () => ({ ready: true })) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-worker-control-'));
  const appRoot = path.join(base, 'App with spaces'), dataRoot = path.join(base, 'user data');
  fs.mkdirSync(path.join(appRoot, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'worker', 'setup.ps1'), '# inert fixture');
  const children = [], calls = [], stopped = [];
  const runtime = { runtimeRoot: path.join(dataRoot, 'runtime'), managedPythonPath: path.join(dataRoot, 'runtime/worker/.venv/Scripts/python.exe'), receiptPath: path.join(dataRoot, 'runtime/worker-setup.json'), browsersPath: path.join(dataRoot, 'runtime/playwright') };
  const controller = createWorkerSetup({ getContext: () => ({ appRoot, dataRoot, runtime, environment: { FIXTURE: 'yes' } }), verify,
    stopTree: async child => { stopped.push(child.pid); }, launch: (...args) => {
      calls.push(args); const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, pid: 400 + children.length });
      children.push(child); return child;
    } });
  t.after(async () => { for (const child of children) child.emit('close', 1, null); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(path.dirname(base), os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
  return { controller, children, calls, stopped, appRoot, runtime };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('worker setup uses fixed argv paths, hides its window and confirms completion only after verification', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  assert.deepEqual(f.controller.start(), { ok: true }); assert.deepEqual(f.controller.start(), { ok: true });
  assert.equal(f.calls.length, 1); assert.equal(f.controller.status().state, 'running');
  assert.equal(f.calls[0][0], 'powershell.exe');
  assert.deepEqual(f.calls[0][1].slice(-4), ['-File', path.join(f.appRoot, 'worker/setup.ps1'), '-RuntimeRoot', f.runtime.runtimeRoot]);
  assert.equal(f.calls[0][2].windowsHide, true); assert.equal(f.calls[0][2].shell, undefined);
  f.children[0].emit('close', 0, null); await turn();
  assert.equal(f.controller.status().state, 'running');
  finish({ ready: true }); await turn(); assert.equal(f.controller.status().state, 'complete');
});

test('failed setup and failed dependency verification remain retryable failures', async t => {
  let probes = 0; const f = fixture(t, async () => { probes++; return { ready: false, reason: 'dependencies_unavailable' }; });
  f.controller.start(); f.children[0].emit('close', 1, null); await turn();
  assert.equal(probes, 0); assert.equal(f.controller.status().state, 'failed');
  f.controller.start(); f.children[1].emit('close', 0, null); await turn();
  assert.equal(probes, 1); assert.equal(f.controller.status().state, 'failed');
});

test('shutdown stops only the owned setup tree and ignores its later successful reply', async t => {
  let probes = 0; const f = fixture(t, async () => { probes++; return { ready: true }; });
  f.controller.start(); await f.controller.stop(); f.children[0].emit('close', 0, null); await turn();
  assert.deepEqual(f.stopped, [400]); assert.equal(probes, 0); assert.equal(f.controller.status().state, 'failed');
});

test('shutdown aborts dependency verification and ignores completion after its setup process exited',async t=>{
  let finish,signal;
  const f=fixture(t,options=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});});
  f.controller.start();f.children[0].emit('close',0,null);await turn();
  assert.equal(f.controller.status().state,'running');
  assert.ok(signal,'The verifier must receive a cancellation signal');assert.equal(signal.aborted,false);
  await f.controller.stop();
  assert.equal(signal.aborted,true);assert.deepEqual(f.stopped,[],'The exited setup process must not be terminated by PID');
  assert.equal(f.controller.status().state,'failed');
  finish({ready:true});await turn();assert.equal(f.controller.status().state,'failed');
  assert.equal(f.controller.start().ok,false);assert.equal(f.calls.length,1);
});

test('shutdown before setup starts still prevents a subsequent installation',async t=>{
  const f=fixture(t);await f.controller.stop();await f.controller.stop();
  assert.equal(f.controller.start().ok,false);assert.equal(f.calls.length,0);assert.deepEqual(f.stopped,[]);
});
