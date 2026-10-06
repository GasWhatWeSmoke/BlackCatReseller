const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { probeWorkerReadiness } = require('./runtimePaths');

function createWorkerSetup({ getContext, launch = spawn, verify = probeWorkerReadiness, stopTree } = {}) {
  let state = { state: 'idle', message: 'Install the photo tools once on this computer.' };
  let child = null, generation = 0, verification = null, stopping = false;
  const status = () => ({ ...state });
  const stop = async () => {
    const owned = child;
    stopping = true; generation++; child = null;
    verification?.abort(); verification = null;
    state = { state: 'failed', message: 'Setup was interrupted. Start setup again to finish or repair it.' };
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
    if (stopTree) return stopTree(owned);
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10000 }, () => resolve()));
  };
  const start = () => {
    if (stopping) return { ok: false, error: 'Black Cat is closing. Reopen it before starting worker setup.' };
    if (state.state === 'running') return { ok: true };
    let context, log;
    try {
      context = getContext();
      const script = path.join(context.appRoot, 'worker', 'setup.ps1');
      if (!fs.statSync(script).isFile()) throw Error('The photo setup script is missing. Reinstall the complete download.');
      fs.mkdirSync(path.join(context.dataRoot, 'logs'), { recursive: true });
      log = fs.createWriteStream(path.join(context.dataRoot, 'logs', 'worker-setup.log'), { flags: 'a' });
      log.on('error', () => {});
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
      if (context.runtime.runtimeRoot) args.push('-RuntimeRoot', context.runtime.runtimeRoot);
      state = { state: 'running', message: 'Downloading and installing photo tools. Keep Black Cat open; first setup can take several minutes.' };
      const attempt = ++generation;
      const owned = launch('powershell.exe', args, { cwd: context.appRoot, env: context.environment,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child = owned;
      for (const stream of [owned.stdout, owned.stderr]) stream?.on('data', data => { if (!log.destroyed) log.write(data); });
      const fail = () => { if (attempt === generation) { child = null; state = { state: 'failed', message: 'Photo setup did not finish. Check worker-setup.log in your data folder, then retry setup.' }; } log.end(); };
      owned.once('error', fail);
      owned.once('close', async (code, signal) => {
        if (attempt !== generation) { log.end(); return; }
        child = null;
        if (code !== 0 || signal) { fail(); return; }
        state = { state: 'running', message: 'Checking the installed photo tools…' };
        const controller = new AbortController(); verification = controller;
        try {
          const result = await verify({ pythonPath: context.runtime.managedPythonPath,
            receiptPath: context.runtime.receiptPath, requireReceipt: true,
            requirementsPath: path.join(context.appRoot, 'worker', 'requirements.txt'),
            browsersPath: context.runtime.browsersPath, environment: context.environment, signal: controller.signal });
          if (attempt !== generation) return;
          state = result.ready ? { state: 'complete', message: 'Photo tools are installed and verified. Re-check setup to continue.' }
            : { state: 'failed', message: 'The installed photo tools did not pass their check. Retry setup to repair them.' };
        } catch { fail(); }
        finally { if (verification === controller) verification = null; log.end(); }
      });
      return { ok: true };
    } catch (error) {
      log?.end(); child = null;
      state = { state: 'failed', message: error instanceof Error ? error.message : 'Photo setup could not start.' };
      return { ok: false, error: state.message };
    }
  };
  return { start, status, stop };
}

module.exports = { createWorkerSetup };
