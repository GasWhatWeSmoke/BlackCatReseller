// One Chrome connection per running Black Cat app; individual workers borrow it.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('next/dist/compiled/ws');
const { ChromeSession } = require('./chrome_session.cjs');
const { sessionHandlers } = require('./chrome_session_server.cjs');
const { chromeControl } = require('./chrome_control.cjs');

async function main() {
  const [receiptPath, owner] = process.argv.slice(2);
  const ownerPid = Number(owner);
  if (!path.isAbsolute(receiptPath || '') || !Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid app owner');
  process.kill(ownerPid, 0);
  const tokenPath = '/' + crypto.randomBytes(24).toString('hex');
  let session = null;
  const server = http.createServer();
  const sockets = new WebSocket.Server({ noServer: true });
  const createSession = () => {
    if (control.isPaused()) throw Error('Chrome is disconnected. Use Connect Chrome in Settings.');
    if (session) return session;
    let port, route;
    try {
      [port, route] = fs.readFileSync(path.join(process.env.LOCALAPPDATA,
        'Google/Chrome/User Data/DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      if (!/^\d+$/.test(port) || +port < 1 || +port > 65535 ||
          !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/.test(route)) throw Error();
    } catch { throw Error('Open your selling Chrome and enable remote debugging at chrome://inspect/#remote-debugging, then connect again.'); }
    return session = new ChromeSession(new WebSocket('ws://127.0.0.1:' + port + route), {
      workWindow: () => {
        const file = path.join(path.dirname(receiptPath), 'crawler-display.json');
        if (!fs.existsSync(file)) throw new Error('Second-monitor placement is unavailable; reopen Black Cat');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.secondary !== true) throw new Error('Connect the second monitor before opening Black Cat webpages');
        const bounds = value.bounds;
        if (value.version !== 1 || !bounds || Object.keys(bounds).sort().join(',') !== 'height,left,top,width' ||
            !Object.values(bounds).every(Number.isInteger) || bounds.width < 640 || bounds.width > 16384 ||
            bounds.height < 480 || bounds.height > 16384 || Math.abs(bounds.left) > 100000 || Math.abs(bounds.top) > 100000) {
          throw new Error('Invalid marketplace browser display configuration');
        }
        return bounds;
      },
    });
  };
  const control = chromeControl({ directory: path.dirname(receiptPath), ownerPid,
    getSession: () => session, createSession, clearSession: () => { session = null; } });
  const handlers = sessionHandlers({ tokenPath, ownerPid, sockets, getSession: () => session,
    createSession, isPaused: control.isPaused,
  });
  server.on('request', handlers.request);
  server.on('upgrade', handlers.upgrade);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const receipt = { version: 1, pid: process.pid, ownerPid,
    endpoint: 'ws://127.0.0.1:' + server.address().port + tokenPath };
  const temporary = receiptPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  fs.renameSync(temporary, receiptPath);
  control.tick();
  const controlTimer = setInterval(() => control.tick(), 500);
  const close = () => {
    session?.close(); sockets.close(); server.close(); clearInterval(watchdog); clearInterval(controlTimer);
    // Retain a stopped receipt so retries cannot create a new approval loop.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  const watchdog = setInterval(() => { try { process.kill(ownerPid, 0); } catch { close(); } }, 3000);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

main().catch(() => { process.stderr.write('Native Chrome session unavailable\n'); process.exitCode = 1; });
