// A bounded CDP cleanup connection; this helper owns no browser process.
const WebSocket = require('next/dist/compiled/ws');

function closeOwnedTarget(endpoint, targetId, timeoutMs = 5000) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname) ||
      !/^[A-Za-z0-9-]+$/.test(targetId)) throw Error('Invalid owned Chrome target');
  return new Promise(resolve => {
    const socket = new WebSocket(url.href);
    let finished = false;
    const finish = ok => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId } })));
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw);
        if (message.id === 1) {
          if (!message.error && message.result?.success === true) finish(true);
          else socket.send(JSON.stringify({ id: 2, method: 'Target.getTargets' }));
        } else if (message.id === 2) {
          finish(!message.error && Array.isArray(message.result?.targetInfos) &&
            !message.result.targetInfos.some(target => target.targetId === targetId));
        }
      } catch { finish(false); }
    });
  });
}

module.exports = { closeOwnedTarget };
if (require.main === module) {
  closeOwnedTarget(process.argv[2], process.argv[3]).then(ok => { process.exitCode = ok ? 0 : 1; })
    .catch(() => { process.exitCode = 1; });
}
