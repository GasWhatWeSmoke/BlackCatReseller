import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupWorkerReadiness } from './workerRuntime.ts';

test('setup readiness caches imports briefly and invalidates when the interpreter changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-worker-readiness-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const pythonWorkerPath = path.join(root, 'custom-python.exe'); fs.writeFileSync(pythonWorkerPath, 'one');
  let calls = 0, now = 1000;
  const dependencies = { now: () => now, probe: async () => { calls++; return { ready: true, reason: null }; }, environment: { NODE_ENV: 'test' as const } };
  const settings = { dataRoot: root, pythonWorkerPath };
  await setupWorkerReadiness(settings, dependencies); await setupWorkerReadiness(settings, dependencies);
  assert.equal(calls, 1);
  fs.writeFileSync(pythonWorkerPath, 'changed'); await setupWorkerReadiness(settings, dependencies); assert.equal(calls, 2);
  now += 61000; await setupWorkerReadiness(settings, dependencies); assert.equal(calls, 3);
});

test('missing dependencies never become green and failed checks retry quickly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-worker-failed-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0, now = 0;
  const dependencies = { now: () => now, probe: async () => { calls++; return { ready: false, reason: 'dependencies_unavailable' }; }, environment: { NODE_ENV: 'test' as const } };
  const settings = { dataRoot: root, pythonWorkerPath: path.join(root, 'python.exe') };
  assert.equal((await setupWorkerReadiness(settings, dependencies)).ready, false);
  now = 3001; assert.equal((await setupWorkerReadiness(settings, dependencies)).ready, false); assert.equal(calls, 2);
});
