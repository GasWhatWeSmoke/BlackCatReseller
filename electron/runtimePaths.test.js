const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { resolveWorkerRuntime, probeWorkerReadiness, resolveVisionAssetRoot } = require('./runtimePaths');

test('vision uses a dedicated stable override without changing the source default', () => {
  const appRoot = path.resolve('app'), override = path.resolve('profile/runtime/vision');
  assert.equal(resolveVisionAssetRoot(appRoot, {}), path.join(appRoot, '.local/vision'));
  assert.equal(resolveVisionAssetRoot(appRoot, { BLACKCAT_VISION_ROOT: override }), override);
  assert.equal(resolveVisionAssetRoot(path.resolve('updated-app'), { BLACKCAT_VISION_ROOT: override }), override);
  for (const invalid of ['../relative', appRoot, path.parse(appRoot).root]) {
    assert.throws(() => resolveVisionAssetRoot(appRoot, { BLACKCAT_VISION_ROOT: invalid }), /absolute|dedicated/);
  }
});

test('source runtimes retain their existing interpreter and browser locations', () => {
  const appRoot = path.resolve('source');
  const value = resolveWorkerRuntime({ appRoot, dataRoot: path.resolve('private-data'), environment: {} });
  assert.equal(value.runtimeRoot, null);
  assert.equal(value.pythonPath, path.join(appRoot, 'worker/.venv/Scripts/python.exe'));
  assert.equal(value.browsersPath, path.join(appRoot, '.local/playwright'));
  assert.equal(value.receiptPath, path.join(appRoot, '.local/worker-setup.json'));
});

test('packaged runtime assets survive changing the installation folder', () => {
  const dataRoot = path.resolve('profile/Black Cat/var');
  const first = resolveWorkerRuntime({ appRoot: path.resolve('Program Files/old/resources/app'), dataRoot, packaged: true, environment: {} });
  const update = resolveWorkerRuntime({ appRoot: path.resolve('Program Files/new/resources/app'), dataRoot, packaged: true, environment: {} });
  assert.deepEqual(first, update);
  assert.equal(first.runtimeRoot, path.join(dataRoot, 'runtime'));
  assert.equal(first.workerRoot, path.join(dataRoot, 'runtime/worker'));
  assert.equal(first.pythonPath, path.join(dataRoot, 'runtime/worker/.venv/Scripts/python.exe'));
  assert.equal(first.browsersPath, path.join(dataRoot, 'runtime/playwright'));
});

test('explicit runtime and interpreter choices remain distinct from managed defaults', () => {
  const root = path.resolve('custom runtime'), custom = path.resolve('custom python/python.exe');
  const value = resolveWorkerRuntime({ appRoot: path.resolve('source'), packaged: true,
    environment: { BLACKCAT_RUNTIME_ROOT: root, BLACKCAT_PYTHON: custom, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'custom-browsers') } });
  assert.equal(value.runtimeRoot, root);
  assert.equal(value.pythonPath, custom);
  assert.equal(value.managedPythonPath, path.join(root, 'worker/.venv/Scripts/python.exe'));
  assert.equal(value.browsersPath, path.join(root, 'custom-browsers'));
  assert.throws(() => resolveWorkerRuntime({ appRoot: 'source', environment: { BLACKCAT_RUNTIME_ROOT: '../relative' } }), /absolute/);
  assert.throws(() => resolveWorkerRuntime({ appRoot: 'source', dataRoot: 'relative', packaged: true, environment: {} }), /absolute/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-worker-readiness-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blackcat-worker-readiness-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pythonPath = path.join(root, 'python.exe'), receiptPath = path.join(root, 'worker-setup.json');
  const requirementsPath = path.join(root, 'requirements.txt'), browsersPath = path.join(root, 'playwright');
  const chromiumPath = path.join(browsersPath, 'chromium/chrome.exe');
  fs.mkdirSync(path.dirname(chromiumPath), { recursive: true });
  fs.writeFileSync(pythonPath, 'inert interpreter fixture');
  fs.writeFileSync(chromiumPath, 'inert browser fixture');
  fs.writeFileSync(requirementsPath, 'Pillow>=10.0\n');
  const receipt = { version: 1, kind: 'blackcat-worker-setup', ready: true, pythonPath, pythonVersion: '3.11.11',
    chromiumPath, browsersPath, requirementsSha256: crypto.createHash('sha256').update(fs.readFileSync(requirementsPath)).digest('hex'),
    verifiedAt: '2026-10-02T12:00:00.000Z' };
  const write = patch => fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, ...patch }));
  write({});
  const options = { pythonPath, receiptPath, requirementsPath, browsersPath, requireReceipt: true };
  const calls = [];
  const run = (file, args, childOptions, callback) => {
    calls.push({ file, args, childOptions });
    callback(null, 'some import output\nBLACKCAT_WORKER_READY=' + JSON.stringify({ pythonPath, pythonVersion: '3.11.11' }) + '\n');
  };
  return { root, options, receipt, write, run, calls };
}

test('an existing python.exe without successful setup never passes managed readiness', async t => {
  const h = fixture(t);
  fs.unlinkSync(h.options.receiptPath);
  assert.deepEqual(await probeWorkerReadiness(h.options, { run: h.run }), { ready: false, reason: 'setup_incomplete' });
  assert.equal(h.calls.length, 0);
});

test('successful receipt still requires bounded imports from the selected interpreter', async t => {
  const h = fixture(t);
  const result = await probeWorkerReadiness({ ...h.options, timeoutMs: 999999, environment: { PYTHONPATH: 'foreign', PYTHONHOME: 'foreign' } }, { run: h.run });
  assert.deepEqual(result, { ready: true, reason: null, pythonVersion: '3.11.11' });
  const call = h.calls[0];
  assert.equal(call.file, h.options.pythonPath);
  assert.deepEqual(call.args.slice(0, 3), ['-I', '-B', '-c']);
  assert.match(call.args[3], /import PIL.Image,numpy,cv2,paddle,paddleocr/);
  assert.match(call.args[3], /from pyzbar import pyzbar/);
  assert.doesNotMatch(call.args[3], /PaddleOCR\(|\.launch\(/);
  assert.equal(call.childOptions.timeout, 60000);
  assert.equal(call.childOptions.windowsHide, true);
  assert.equal(call.childOptions.env.PYTHONPATH, '');
  assert.equal(call.childOptions.env.PYTHONHOME, '');
  assert.equal(call.childOptions.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK, 'True');
});

test('outdated, copied, incomplete and missing-browser receipts fail without executing Python', async t => {
  const h = fixture(t);
  for (const [patch, reason] of [
    [{ requirementsSha256: '0'.repeat(64) }, 'setup_outdated'],
    [{ pythonPath: path.join(h.root, 'another-python.exe') }, 'setup_incomplete'],
    [{ ready: false }, 'setup_incomplete'],
    [{ browsersPath: path.join(h.root, 'other-browsers') }, 'setup_outdated'],
    [{ chromiumPath: 'relative-browser.exe' }, 'browser_missing'],
  ]) {
    h.write(patch);
    assert.deepEqual(await probeWorkerReadiness(h.options, { run: h.run }), { ready: false, reason });
  }
  assert.equal(h.calls.length, 0);
});

test('custom interpreters can be verified without adopting a managed receipt', async t => {
  const h = fixture(t);
  fs.unlinkSync(h.options.receiptPath);
  assert.equal((await probeWorkerReadiness({ pythonPath: h.options.pythonPath }, { run: h.run })).ready, true);
  assert.equal(h.calls.length, 1);
});

test('import failures, timeouts and wrong interpreter replies cannot become ready', async t => {
  const h = fixture(t);
  const cases = [
    [{ code: 1 }, '', 'dependencies_unavailable'],
    [{ killed: true }, '', 'probe_timeout'],
    [null, 'no completion receipt', 'probe_invalid'],
    [null, 'BLACKCAT_WORKER_READY=' + JSON.stringify({ pythonPath: h.options.pythonPath, pythonVersion: '3.12.0' }), 'probe_invalid'],
    [null, 'BLACKCAT_WORKER_READY=' + JSON.stringify({ pythonPath: path.join(h.root, 'foreign.exe'), pythonVersion: '3.11.11' }), 'probe_invalid'],
  ];
  for (const [error, output, reason] of cases) {
    const run = (_file, _args, _options, callback) => callback(error, output);
    assert.deepEqual(await probeWorkerReadiness(h.options, { run }), { ready: false, reason });
  }
});

test('an already cancelled readiness check cannot launch its interpreter',async t=>{
  const h=fixture(t),controller=new AbortController();controller.abort();
  assert.deepEqual(await probeWorkerReadiness({...h.options,signal:controller.signal},{run:h.run}),{ready:false,reason:'probe_cancelled'});
  assert.equal(h.calls.length,0);
});

test('readiness passes cancellation to execFile and rejects a late successful import receipt',async t=>{
  const h=fixture(t),controller=new AbortController();let complete,forwarded;
  const result=probeWorkerReadiness({...h.options,signal:controller.signal},{run:(_file,_args,options,callback)=>{forwarded=options.signal;complete=callback;}});
  assert.equal(forwarded,controller.signal);
  controller.abort();assert.equal(forwarded.aborted,true);
  complete(null,'BLACKCAT_WORKER_READY='+JSON.stringify({pythonPath:h.options.pythonPath,pythonVersion:'3.11.11'}));
  assert.deepEqual(await result,{ready:false,reason:'probe_cancelled'});
});
