const fs = require('node:fs');
const path = require('node:path');

function chromeControl({ directory, ownerPid, pid = process.pid, getSession, createSession, clearSession }) {
  const commandPath = path.join(directory, 'native-chrome-control-command.json');
  const statusPath = path.join(directory, 'native-chrome-control-status.json');
  let paused = false, commandId = null, error = null;
  function tick() {
    try {
      const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
      if (command.version === 1 && command.ownerPid === ownerPid && command.pid === pid &&
          typeof command.id === 'string' && command.id.length <= 64 && command.id !== commandId &&
          Number.isFinite(command.at) && Date.now() - command.at < 15000 && command.at <= Date.now() + 1000) {
        commandId = command.id; error = null;
        try {
          const session = getSession();
          if (!['connect', 'disconnect'].includes(command.action)) throw Error('Unknown Chrome action.');
          if (session?.active) throw Error('A browser task is active. Let it finish before changing the Chrome connection.');
          if (command.action === 'disconnect') {
            paused = true;
            session?.close(); clearSession();
          } else {
            paused = false;
            if (session?.failed) { session.close(); clearSession(); }
            createSession();
          }
        } catch (failure) { error = failure.message; }
      }
    } catch { /* No command until the desktop app writes a complete file. */ }
    const session = getSession();
    const value = { version: 1, ownerPid, pid, at: Date.now(), available: true, commandId, error,
      connected: !!session?.ready, busy: !!session?.active, paused, failed: !!session?.failed,
      approvalPending: !!session && !session.ready && !session.failed };
    const temporary = statusPath + '.' + pid + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, statusPath);
    } catch {
      // Windows readers can briefly lock either file. Keep the approved socket
      // and command acknowledgement in memory; the next tick republishes them.
      // The desktop treats a stale status as unavailable until writing recovers.
    }
    return value;
  }
  return { tick, isPaused: () => paused };
}

module.exports = { chromeControl };
