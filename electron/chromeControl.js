const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Native IPC and owner-bound local files only. Never expose the private browser
// endpoint to the renderer or disconnect by killing Chrome or personal tabs.
function createChromeControl({ root, dataRoot, ownerPid, environment = process.env, launch = spawn }) {
  const statusPath = path.join(dataRoot, 'native-chrome-control-status.json');
  const commandPath = path.join(dataRoot, 'native-chrome-control-command.json');
  let commanding = false;
  function status() {
    try {
      const value = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (value.version !== 1 || value.ownerPid !== ownerPid || !Number.isInteger(value.pid) ||
          !Number.isFinite(value.at) || Date.now() - value.at > 5000 || value.at > Date.now() + 1000) throw Error();
      return value;
    } catch { return { available: false, connected: false, busy: false, paused: false }; }
  }
  async function boot() {
    const python = [environment.BLACKCAT_PYTHON, path.join(root, 'worker/.venv/Scripts/python.exe'),
      path.join(root, 'worker/python/python/python.exe')].filter(Boolean).find(file => fs.existsSync(file));
    if (!python) throw Error('Black Cat’s Python worker is unavailable.');
    await new Promise((resolve, reject) => {
      const child = launch(python, ['-m', 'black_cat_worker.chrome_session'], {
        cwd: path.join(root, 'worker'), stdio: 'ignore', windowsHide: true,
        env: { ...environment, PYTHONPATH: '', BLACKCAT_DATA_ROOT: dataRoot, BLACKCAT_CHROME_OWNER_PID: String(ownerPid) },
      });
      const timer = setTimeout(() => { child.kill(); reject(Error('Chrome helper did not respond.')); }, 45000);
      child.once('error', () => { clearTimeout(timer); reject(Error('Could not start the Chrome helper.')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Could not start the Chrome helper. Restart Black Cat if its helper has stopped.')); });
    });
  }
  async function command(action) {
    if (!['connect', 'disconnect'].includes(action)) throw Error('Unknown Chrome action.');
    if (commanding) throw Error('A Chrome connection action is already running.');
    commanding = true;
    try {
      let current = status();
      if (!current.available) {
        if (action === 'disconnect') throw Error('Chrome connection status is unavailable; disconnection cannot be confirmed.');
        await boot();
        for (let i = 0; i < 20 && !(current = status()).available; i++) await delay(100);
        if (!current.available) throw Error('The Chrome helper needs the updated app. Restart Black Cat.');
      }
      const id = crypto.randomUUID();
      const temporary = commandPath + '.' + id + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, id, ownerPid, pid: current.pid, action, at: Date.now() }));
      fs.renameSync(temporary, commandPath);
      for (let i = 0; i < 100; i++) {
        await delay(100);
        current = status();
        if (current.available && current.commandId === id) {
          if (current.error) throw Error(current.error);
          return current;
        }
      }
      throw Error('Chrome has not confirmed the action. Refresh its status before trying again.');
    } finally { commanding = false; }
  }
  return { status, command };
}

module.exports = { createChromeControl };
