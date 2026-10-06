const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/** Resolve optional vision assets without changing any pinned manifest values. */
function resolveVisionAssetRoot(appRoot, environment = process.env) {
  const override = (environment.BLACKCAT_VISION_ROOT || '').trim();
  if (!override) return path.resolve(appRoot, '.local', 'vision');
  if (!path.isAbsolute(override)) throw Error('BLACKCAT_VISION_ROOT must be an absolute folder.');
  const root = path.resolve(override);
  if (root.toLowerCase() === path.resolve(appRoot).toLowerCase() || root === path.parse(root).root) {
    throw Error('BLACKCAT_VISION_ROOT must be a dedicated asset folder.');
  }
  return root;
}

/** Resolve machine assets separately from the replaceable packaged application. */
function resolveWorkerRuntime({ appRoot, dataRoot, packaged = false, environment = process.env }) {
  const override = (environment.BLACKCAT_RUNTIME_ROOT || '').trim();
  if (override && !path.isAbsolute(override)) throw Error('BLACKCAT_RUNTIME_ROOT must be an absolute folder.');
  if (environment.PLAYWRIGHT_BROWSERS_PATH && !path.isAbsolute(environment.PLAYWRIGHT_BROWSERS_PATH)) throw Error('PLAYWRIGHT_BROWSERS_PATH must be an absolute folder.');
  if (packaged && !override && (!dataRoot || !path.isAbsolute(dataRoot))) throw Error('Packaged worker dataRoot must be an absolute folder.');
  const runtimeRoot = override ? path.resolve(override) : packaged ? path.join(dataRoot, 'runtime') : null;
  const workerRoot = runtimeRoot ? path.join(runtimeRoot, 'worker') : path.join(appRoot, 'worker');
  const managedPythonPath = path.join(workerRoot, '.venv', 'Scripts', 'python.exe');
  return {
    runtimeRoot,
    workerRoot,
    managedPythonPath,
    pythonPath: environment.BLACKCAT_PYTHON || managedPythonPath,
    browsersPath: environment.PLAYWRIGHT_BROWSERS_PATH || (runtimeRoot ? path.join(runtimeRoot, 'playwright') : path.join(appRoot, '.local', 'playwright')),
    receiptPath: runtimeRoot ? path.join(runtimeRoot, 'worker-setup.json') : path.join(appRoot, '.local', 'worker-setup.json'),
  };
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const READY_PREFIX = 'BLACKCAT_WORKER_READY=';
// Imports check native DLLs as well as package presence. No model is constructed,
// browser launched, account opened or network request made by this probe.
const WORKER_PROBE = [
  'import json,os,sys',
  "os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK']='True'",
  'import PIL.Image,numpy,cv2,paddle,paddleocr,qrcode',
  'from pyzbar import pyzbar',
  'from playwright.sync_api import sync_playwright',
  `print('${READY_PREFIX}'+json.dumps({'pythonPath':sys.executable,'pythonVersion':'.'.join(map(str,sys.version_info[:3]))}))`,
].join(';');

/**
 * @param {{pythonPath:string, receiptPath?:string, requireReceipt?:boolean,
 * requirementsPath?:string, browsersPath?:string, timeoutMs?:number,
 * environment?:NodeJS.ProcessEnv, signal?:AbortSignal}} options
 * @param {{run?:typeof execFile, files?:typeof fs}} dependencies
 * @returns {Promise<{ready:boolean, reason:string|null, pythonVersion?:string}>}
 */
async function probeWorkerReadiness(options, dependencies = {}) {
  const files = dependencies.files || fs;
  const run = dependencies.run || execFile;
  const fail = reason => ({ ready: false, reason });
  if (options.signal?.aborted) return fail('probe_cancelled');
  if (!options.pythonPath || !path.isAbsolute(options.pythonPath)) return fail('python_missing');
  try { if (!files.statSync(options.pythonPath).isFile()) return fail('python_missing'); }
  catch { return fail('python_missing'); }

  let receipt;
  if (options.requireReceipt) {
    try {
      if (!options.receiptPath || files.statSync(options.receiptPath).size > 32768) return fail('setup_incomplete');
      receipt = JSON.parse(files.readFileSync(options.receiptPath, 'utf8').replace(/^\uFEFF/, ''));
      if (receipt.version !== 1 || receipt.kind !== 'blackcat-worker-setup' || receipt.ready !== true ||
          !samePath(receipt.pythonPath, options.pythonPath) || typeof receipt.verifiedAt !== 'string' ||
          !Number.isFinite(Date.parse(receipt.verifiedAt))) return fail('setup_incomplete');
      if (options.requirementsPath) {
        const digest = crypto.createHash('sha256').update(files.readFileSync(options.requirementsPath)).digest('hex');
        if (digest !== receipt.requirementsSha256) return fail('setup_outdated');
      }
      if (options.browsersPath && !samePath(receipt.browsersPath, options.browsersPath)) return fail('setup_outdated');
      if (typeof receipt.chromiumPath !== 'string' || !path.isAbsolute(receipt.chromiumPath) ||
          !files.statSync(receipt.chromiumPath).isFile()) return fail('browser_missing');
    } catch { return fail('setup_incomplete'); }
  }
  const requestedTimeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
  const timeout = Math.min(60000, Math.max(1000, requestedTimeout));
  return new Promise(resolve => {
    try {
      run(options.pythonPath, ['-I', '-B', '-c', WORKER_PROBE], {
        windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 256 * 1024, signal: options.signal,
        env: { ...(options.environment || process.env), PYTHONPATH: '', PYTHONHOME: '',
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True', PYTHONIOENCODING: 'utf-8',
          ...(options.browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: options.browsersPath } : {}) },
      }, (error, stdout) => {
        if (options.signal?.aborted || error?.code === 'ABORT_ERR') { resolve(fail('probe_cancelled')); return; }
        if (error) { resolve(fail(error.killed || error.code === 'ETIMEDOUT' ? 'probe_timeout' : 'dependencies_unavailable')); return; }
        try {
          const line = String(stdout).split(/\r?\n/).filter(value => value.startsWith(READY_PREFIX)).at(-1);
          const value = JSON.parse(line.slice(READY_PREFIX.length));
          if (!samePath(value.pythonPath, options.pythonPath) || !/^3\.\d+\.\d+$/.test(value.pythonVersion) ||
              receipt && receipt.pythonVersion !== value.pythonVersion) throw Error('Worker identity did not match.');
          resolve({ ready: true, reason: null, pythonVersion: value.pythonVersion });
        } catch { resolve(fail('probe_invalid')); }
      });
    } catch { resolve(fail(options.signal?.aborted ? 'probe_cancelled' : 'dependencies_unavailable')); }
  });
}

module.exports = { resolveWorkerRuntime, probeWorkerReadiness, resolveVisionAssetRoot };
