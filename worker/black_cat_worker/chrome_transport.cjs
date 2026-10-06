// Native CDP transport for one existing seller editor. Never instruments other tabs.
function sellerEditor(value) {
  const url = new URL(value);
  const etsy = url.hostname === 'www.etsy.com' && (/^\/your\/shops\/[^/]+\/listing-editor\/create$/.test(url.pathname) || ['/your/shops/me/tools/listings', '/your/orders/sold'].includes(url.pathname));
  const ebay = url.hostname === 'www.ebay.com' && ['/lstng', '/sl/sell', '/sh/lst/active', '/sh/ord'].includes(url.pathname);
  const mercari = url.hostname === 'www.mercari.com' && ['/sell/', '/mypage/listings/active/'].includes(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!etsy && !ebay && !mercari)) {
    throw new Error('A supported seller editor or inventory entry URL is required');
  }
  url.hash = ''; // Etsy uses fragments to focus editor sections.
  return url.href;
}

class SellerTransport {
  constructor(socket, editorUrl, targetId = null, emulateFocus = false) {
    this.editorUrl = sellerEditor(editorUrl);
    this.targetId = targetId;
    this.emulateFocus = Boolean(emulateFocus && targetId);
    this.socket = socket;
    this.sessions = new Set();
    this.ignored = new Set();
    this.internalId = -1;
    socket.on('message', raw => this.receive(JSON.parse(raw)));
    socket.on('close', () => this.onclose?.());
  }

  send(message) {
    // Borrowed Chrome and its tabs belong to the user. This connector never
    // creates/closes tabs or contexts; callers receive the existing editor only.
    const forbidden = ['Browser.close', 'Target.closeTarget', 'Target.createTarget',
      'Target.createBrowserContext', 'Target.disposeBrowserContext'];
    if (forbidden.includes(message.method) || (message.sessionId && !this.sessions.has(message.sessionId))) {
      queueMicrotask(() => this.onmessage?.({ id: message.id, sessionId: message.sessionId,
        error: { code: -32000, message: 'Command outside the borrowed seller editor' } }));
      return;
    }
    if (!message.sessionId && message.method === 'Target.setAutoAttach') {
      // Other tabs must not be paused while their attachment is discarded.
      message = { ...message, params: { ...message.params, waitForDebuggerOnStart: false } };
    }
    this.socket.send(JSON.stringify(message));
  }

  receive(message) {
    if (message.id < 0) return; // Responses to our detach requests.
    if (message.method === 'Target.attachedToTarget') {
      const { targetInfo, sessionId } = message.params;
      let matchingEditor = false;
      try { matchingEditor = targetInfo.type === 'page' && (this.targetId
        ? targetInfo.targetId === this.targetId : sellerEditor(targetInfo.url) === this.editorUrl); } catch {}
      const allowed = message.sessionId ? this.sessions.has(message.sessionId) : matchingEditor;
      if (!allowed) {
        this.ignored.add(sessionId);
        this.socket.send(JSON.stringify({ id: this.internalId--,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          method: 'Target.detachFromTarget', params: { sessionId } }));
        return;
      }
      this.sessions.add(sessionId);
      if (this.emulateFocus && !message.sessionId && matchingEditor) {
        // Keep only our created work page active while its window is covered.
        // Reuse this attachment; never activate a desktop window or user tab.
        this.socket.send(JSON.stringify({ id: this.internalId--, sessionId,
          method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }));
      }
    }
    if (message.sessionId && !this.sessions.has(message.sessionId)) return;
    if (message.method === 'Target.detachedFromTarget') {
      if (this.ignored.delete(message.params.sessionId)) return;
      this.sessions.delete(message.params.sessionId);
    }
    this.onmessage?.(message);
  }

  close() { this.socket.close(); }
}

module.exports = { SellerTransport, sellerEditor };
