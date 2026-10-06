const { EventEmitter } = require('node:events');
const { SellerTransport, sellerEditor } = require('./chrome_transport.cjs');

// One upstream Chrome connection survives all of this app's Python workers.
class ChromeSession {
  constructor(upstream, { workWindow = null } = {}) {
    this.upstream = upstream;
    this.workWindow = workWindow;
    this.active = null;
    this.ready = false;
    this.failed = false;
    this.cleanupSlow = false;
    this.windowError = null;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    upstream.on('open', () => {
      this.ready = true;
      for (const message of this.queue.splice(0)) upstream.send(JSON.stringify(message));
    });
    upstream.on('message', raw => this.receive(JSON.parse(raw)));
    upstream.on('error', () => this.fail());
    upstream.on('close', () => this.fail());
  }

  fail() {
    this.failed = true;
    this.ready = false;
    this.cleanupSlow = false;
    const client = this.active?.client;
    this.active = null;
    client?.close();
    this.pending.clear();
    this.queue.length = 0;
  }

  send(message, callback) {
    const id = this.nextId++;
    this.pending.set(id, callback);
    const wire = { ...message, id };
    if (this.ready) this.upstream.send(JSON.stringify(wire));
    else this.queue.push(wire);
  }

  receive(message) {
    if (message.id !== undefined) {
      const callback = this.pending.get(message.id);
      this.pending.delete(message.id);
      callback?.(message);
    } else if (this.active && !this.active.releasing) {
      this.active.facade.emit('message', JSON.stringify(message));
    }
  }

  borrow(client, editorUrl, { create = false } = {}) {
    if (this.active || this.failed) throw new Error('Chrome session is unavailable or busy');
    editorUrl = sellerEditor(editorUrl);
    if (create && new URL(editorUrl).search) throw new Error('New editors cannot reference an existing draft');
    const bounds = create ? this.workWindow?.() : null;
    const facade = new EventEmitter();
    const lease = { client, facade, releasing: false, creating: create, targetId: null, incoming: [], transport: null };
    facade.send = raw => {
      const message = JSON.parse(raw);
      this.send(message, result => {
        if (this.active === lease && !lease.releasing) facade.emit('message', JSON.stringify({ ...result, id: message.id }));
      });
    };
    facade.close = () => client.close();
    const initialize = () => {
      lease.transport = new SellerTransport(facade, editorUrl, lease.targetId, Boolean(bounds));
      lease.transport.onmessage = message => { if (!lease.releasing) client.send(JSON.stringify(message)); };
      for (const message of lease.incoming.splice(0)) lease.transport.send(message);
    };
    this.active = lease;
    client.on('message', raw => {
      if (lease.releasing) return;
      try {
        const message = JSON.parse(raw);
        if (lease.transport) lease.transport.send(message);
        else if (lease.incoming.length < 32) lease.incoming.push(message);
        else client.close();
      } catch { client.close(); }
    });
    client.on('error', () => client.close());
    client.on('close', () => this.release(lease));
    if (!create) { initialize(); return; }
    // Auto-attach is off between borrowers, so establish ownership from Chrome's
    // response BEFORE Playwright attaches. Existing same-URL tabs are excluded.
    this.send({ method: 'Target.createTarget', params: { url: 'about:blank',
      ...(bounds ? { newWindow: true, background: true, focus: false, ...bounds } : {}) } }, response => {
      lease.creating = false;
      const targetId = response.result?.targetId;
      if (response.error || typeof targetId !== 'string' || !targetId) {
        client.close();
        if (lease.releasing) this.cleanup(lease);
        return;
      }
      lease.targetId = targetId;
      if (lease.releasing) this.cleanup(lease);
      else if (bounds) this.placeWindow(lease, bounds, initialize);
      else initialize();
    });
  }

  placeWindow(lease, bounds, done) {
    // Chrome can inherit a maximized/fullscreen state from its last window.
    // Normalize ONLY the new owned window before exposing it to the crawler.
    const send = (method, params, next) => this.send({ method, params }, result => {
      if (this.active !== lease || lease.releasing) return;
      if (result.error) { this.windowError = { stage: method, code: result.error.code }; lease.client.close(); return; }
      next(result.result);
    });
    send('Browser.getWindowForTarget', { targetId: lease.targetId }, result => {
      const windowId = result?.windowId;
      if (!Number.isInteger(windowId)) { lease.client.close(); return; }
      send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, () => {
        send('Browser.setWindowBounds', { windowId, bounds }, () => {
          send('Browser.getWindowBounds', { windowId }, result => {
            const actual = result?.bounds;
            if (!actual || actual.windowState !== 'normal' ||
                Object.keys(bounds).some(key => actual[key] !== bounds[key])) {
              this.windowError = { stage: 'verify', expected: bounds, actual }; lease.client.close(); return;
            }
            this.windowError = null;
            done();
          });
        });
      });
    });
  }

  openWindow(url) {
    const parsed = new URL(url);
    const setupPage = ['http://127.0.0.1:41999/browser-link', 'chrome://extensions/'].includes(url);
    if ((!setupPage && parsed.protocol !== 'https:') || parsed.username || parsed.password) throw new Error('Invalid webpage URL');
    if (this.active || this.failed) throw new Error('Chrome session is unavailable or busy');
    const bounds = this.workWindow?.();
    if (!bounds) throw new Error('Second monitor unavailable');
    return new Promise(resolve => {
      const client = new EventEmitter();
      const lease = { client, facade: new EventEmitter(), releasing: false, creating: true, targetId: null, incoming: [] };
      const timer = setTimeout(() => client.close(), 30000);
      timer.unref?.();
      client.close = () => { clearTimeout(timer); this.release(lease); resolve(false); };
      this.active = lease;
      // Explicit user-opened links remain open. No page attachment or login
      // inspection is needed; only the owned browser window is positioned.
      this.send({ method: 'Target.createTarget', params: { url: parsed.href,
        newWindow: true, background: true, focus: false, ...bounds } }, response => {
        lease.creating = false;
        const targetId = response.result?.targetId;
        if (response.error || typeof targetId !== 'string' || !targetId) {
          client.close();
          // Cancellation may precede Chrome's reply (for example while an
          // authorization prompt is pending). A late error still releases it.
          if (lease.releasing) this.cleanup(lease);
          return;
        }
        lease.targetId = targetId;
        if (lease.releasing) { this.cleanup(lease); return; }
        this.placeWindow(lease, bounds, () => {
          clearTimeout(timer);
          this.active = null;
          resolve(true);
        });
      });
    });
  }

  release(lease) {
    if (this.active !== lease || lease.releasing) return;
    lease.releasing = true;
    lease.incoming.length = 0;
    // A cancelled creation still needs its response to identify and close ONLY
    // the tab we created. Never find a replacement target by its URL.
    if (lease.creating) return;
    this.cleanup(lease);
  }

  cleanup(lease) {
    if (this.active !== lease || lease.cleaning) return;
    lease.cleaning = true;
    // Keep the SAME approval request open even if its first worker times out.
    this.queue.length = 0;
    this.pending.clear();
    if (!this.ready) { this.active = null; return; }
    // A slow renderer is not a disconnected Chrome session. Keep waiting on
    // this exact cleanup command, including its callback, without reconnecting.
    const timeout = setTimeout(() => {
      if (this.active === lease && !this.failed) this.cleanupSlow = true;
    }, 5000);
    timeout.unref?.();
    const detach = () => this.send({ method: 'Target.setAutoAttach', params: {
        autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
      } }, response => {
        clearTimeout(timeout);
        this.cleanupSlow = false;
        if (response.error) { this.fail(); return; }
        if (this.active === lease) this.active = null;
      });
    if (!lease.targetId) { detach(); return; }
    this.send({ method: 'Target.closeTarget', params: { targetId: lease.targetId } }, response => {
      if (!response.error && response.result?.success === true) { detach(); return; }
      // The user may already have closed this owned tab. Confirm absence before
      // releasing the queue; an error alone does not prove it is gone.
      this.send({ method: 'Target.getTargets' }, check => {
        if (check.error || !Array.isArray(check.result?.targetInfos) ||
            check.result.targetInfos.some(target => target.targetId === lease.targetId)) {
          clearTimeout(timeout); this.fail(); return;
        }
        detach();
      });
    });
  }

  close() { this.fail(); this.upstream.close(); }
}

module.exports = { ChromeSession };
