const { sellerEditor } = require('./chrome_transport.cjs');

// Separate routing from connection ownership so app updates can retain Chrome's
// already-approved socket. Every request still requires the private local token.
function sessionHandlers({ tokenPath, ownerPid, sockets, getSession, createSession, isPaused = () => false }) {
  return {
    request(request, response) {
      if (!request.headers.origin && request.url === tokenPath + '/open-window' && request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; if (body.length > 8192) request.destroy(); });
        request.on('end', async () => {
          try {
            if (isPaused()) throw Error('Chrome disconnected');
            const { url } = JSON.parse(body);
            if (typeof url !== 'string' || url.length > 4096) throw new Error('Invalid URL');
            const ok = await (getSession() || createSession()).openWindow(url);
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ ok }));
          } catch { response.writeHead(409).end(); }
        });
        return;
      }
      if (request.headers.origin || request.url !== tokenPath + '/status' || request.method !== 'GET') {
        response.writeHead(403).end(); return;
      }
      const session = getSession();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ pid: process.pid, ownerPid, connected: session?.ready ?? false,
        paused: isPaused(),
        failed: session?.failed ?? false, busy: !!session?.active, cleanupSlow: session?.cleanupSlow ?? false,
        windowError: session?.windowError ?? null,
        capabilities: ['new-editor-v1', 'ebay-editor-v1', 'seller-tools-v1', 'mercari-tools-v1', 'work-window-v1', 'background-link-v1'] }));
    },
    upgrade(request, socket, head) {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const session = getSession();
        if (request.headers.origin || url.pathname !== tokenPath || session?.active || session?.failed || isPaused()) throw new Error('Unavailable');
        const editorUrl = sellerEditor(url.searchParams.get('editor'));
        if (url.searchParams.has('create') && url.searchParams.get('create') !== '1') throw new Error('Invalid mode');
        const create = url.searchParams.get('create') === '1';
        if (create && new URL(editorUrl).search) throw new Error('Existing draft');
        sockets.handleUpgrade(request, socket, head, client => {
          try { (getSession() || createSession()).borrow(client, editorUrl, { create }); }
          catch { client.close(); }
        });
      } catch { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); }
    },
  };
}

module.exports = { sessionHandlers };
