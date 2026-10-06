import runtime from '../../electron/runtimePaths.js';
import fs from 'node:fs';
import path from 'node:path';

// Shared with the packaged desktop. The dependency check is inline Python in
// this shipped helper, so it never depends on a development script or system Python.
export const resolveWorkerRuntime = runtime.resolveWorkerRuntime;
export const probeWorkerReadiness = runtime.probeWorkerReadiness;

export function workerRuntimePaths(dataRoot: string, environment: NodeJS.ProcessEnv = process.env) {
  return resolveWorkerRuntime({ appRoot: process.cwd(), dataRoot, environment });
}

type Readiness = { ready: boolean; reason: string | null; pythonVersion?: string };
const checks = new Map<string, { fingerprint: string; expires: number; result: Promise<Readiness> }>();
const stamp = (file: string) => { try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}`; } catch { return 'missing'; } };

/** Re-check changed installations immediately without importing OCR on every UI poll. */
export async function setupWorkerReadiness(settings: { dataRoot: string; pythonWorkerPath: string },
  dependencies: { probe?: typeof probeWorkerReadiness; now?: () => number; environment?: NodeJS.ProcessEnv } = {}): Promise<Readiness> {
  const environment = dependencies.environment || process.env;
  const paths = workerRuntimePaths(settings.dataRoot, environment);
  const requirementsPath = path.join(process.cwd(), 'worker', 'requirements.txt');
  const managed = path.resolve(settings.pythonWorkerPath || '.').toLowerCase() === path.resolve(paths.managedPythonPath).toLowerCase();
  const key = `${settings.pythonWorkerPath}\n${paths.receiptPath}\n${paths.browsersPath}`;
  const fingerprint = [stamp(settings.pythonWorkerPath), stamp(paths.receiptPath), stamp(requirementsPath)].join('|');
  const now = (dependencies.now || Date.now)();
  const previous = checks.get(key);
  if (previous && previous.fingerprint === fingerprint && previous.expires > now) return previous.result;
  const result: Promise<Readiness> = (dependencies.probe || probeWorkerReadiness)({ pythonPath: settings.pythonWorkerPath,
    receiptPath: paths.receiptPath, requireReceipt: !!paths.runtimeRoot && managed,
    requirementsPath, browsersPath: paths.browsersPath, environment });
  const entry = { fingerprint, expires: now + 60000, result };
  if (checks.size > 24) checks.clear();
  checks.set(key, entry);
  const checked = await result;
  if (!checked.ready) entry.expires = now + 3000;
  return checked;
}
