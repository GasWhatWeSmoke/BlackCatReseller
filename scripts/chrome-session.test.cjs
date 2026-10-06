const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChromeSession } = require('../worker/black_cat_worker/chrome_session.cjs');
const editor = 'https://www.etsy.com/your/shops/me/listing-editor/create';

function socket() {
  const value = new EventEmitter();
  value.sent = [];
  value.closes = 0;
  value.send = raw => value.sent.push(JSON.parse(raw));
  value.close = () => { value.closes++; value.emit('close'); };
  return value;
}

function placeOwnedWindow(upstream, bounds) {
  let command = upstream.sent.at(-1);
  assert.equal(command.method, 'Browser.getWindowForTarget');
  upstream.emit('message', JSON.stringify({ id: command.id, result: { windowId: 7 } }));
  command = upstream.sent.at(-1);
  assert.deepEqual(command, { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { windowState: 'normal' } }, id: command.id });
  upstream.emit('message', JSON.stringify({ id: command.id, result: {} }));
  command = upstream.sent.at(-1);
  assert.deepEqual(command.params, { windowId: 7, bounds });
  upstream.emit('message', JSON.stringify({ id: command.id, result: {} }));
  command = upstream.sent.at(-1);
  assert.equal(command.method, 'Browser.getWindowBounds');
  upstream.emit('message', JSON.stringify({ id: command.id, result: { bounds: { ...bounds, windowState: 'normal' } } }));
}

test('work editors open a separate background window on the chosen monitor without activating user tabs', () => {
  const upstream = socket();
  const bounds = { left: -1800, top: 32, width: 1400, height: 900 };
  const session = new ChromeSession(upstream, { workWindow: () => bounds });
  upstream.emit('open');
  const client = socket(); session.borrow(client, editor, { create: true });
  const create = upstream.sent.at(-1);
  assert.deepEqual(create.params, { url: 'about:blank', newWindow: true, background: true, focus: false, ...bounds });
  upstream.emit('message', JSON.stringify({ id: create.id, result: { targetId: 'work-only' } }));
  placeOwnedWindow(upstream, bounds);
  client.close();
  assert.deepEqual(upstream.sent.at(-1).params, { targetId: 'work-only' });
  assert.equal(upstream.sent.some(message => message.method === 'Target.activateTarget'), false);
  session.close();
});

test('invalid display configuration cannot leave a stuck browser lease or create a normal user tab', () => {
  const upstream = socket();
  const session = new ChromeSession(upstream, { workWindow: () => { throw Error('Invalid display'); } });
  upstream.emit('open');
  assert.throws(() => session.borrow(socket(), editor, { create: true }), /Invalid display/);
  assert.equal(session.active, null);
  assert.equal(upstream.sent.length, 0);
  session.close();
});

test('only a broker-created work page receives virtual focus through its existing attachment', () => {
  const upstream = socket(), client = socket();
  const session = new ChromeSession(upstream, { workWindow: () => ({ left: 0, top: -1000, width: 1400, height: 900 }) });
  upstream.emit('open'); session.borrow(client, editor, { create: true });
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { targetId: 'owned' } }));
  placeOwnedWindow(upstream, { left: 0, top: -1000, width: 1400, height: 900 });
  for (const targetId of ['personal-same-url', 'owned']) {
    upstream.emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
      sessionId: targetId + '-session', targetInfo: { targetId, type: 'page', url: editor },
    } }));
  }
  upstream.emit('message', JSON.stringify({ method: 'Target.attachedToTarget', sessionId: 'owned-session', params: {
    sessionId: 'frame-session', targetInfo: { targetId: 'frame', type: 'iframe', url: 'https://static.etsy.com/' },
  } }));
  const focus = upstream.sent.filter(message => message.method === 'Emulation.setFocusEmulationEnabled');
  assert.equal(focus.length, 1);
  assert.equal(focus[0].sessionId, 'owned-session');
  assert.deepEqual(focus[0].params, { enabled: true });
  assert.equal(upstream.sent.some(message => ['Target.attachToTarget', 'Target.activateTarget', 'Page.bringToFront'].includes(message.method)), false);
  assert.deepEqual(client.sent.filter(message => message.method === 'Target.attachedToTarget').map(message => message.params.sessionId), ['owned-session', 'frame-session']);
  session.close();
});

test('borrowing an existing seller tab never changes its focus even with a work display configured', () => {
  const upstream = socket(), client = socket();
  const session = new ChromeSession(upstream, { workWindow: () => ({ left: 0, top: 0, width: 1400, height: 900 }) });
  upstream.emit('open'); session.borrow(client, editor);
  upstream.emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
    sessionId: 'borrowed-session', targetInfo: { targetId: 'personal-existing', type: 'page', url: editor },
  } }));
  assert.equal(upstream.sent.some(message => message.method === 'Emulation.setFocusEmulationEnabled'), false);
  assert.equal(client.sent[0].params.sessionId, 'borrowed-session');
  session.close();
});

test('successive crawler workers reuse one Chrome socket and release attachments between borrowers', () => {
  const upstream = socket(), session = new ChromeSession(upstream);
  upstream.emit('open');
  const wireIds = new Set();
  for (let index = 0; index < 20; index++) {
    const client = socket();
    session.borrow(client, editor);
    client.emit('message', JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    const command = upstream.sent.at(-1);
    assert.ok(!wireIds.has(command.id));
    wireIds.add(command.id);
    upstream.emit('message', JSON.stringify({ id: command.id, result: { product: 'Chrome/fixture' } }));
    assert.equal(client.sent.at(-1).id, 1);
    client.close();
    assert.throws(() => session.borrow(socket(), editor), /busy/);
    const detach = upstream.sent.at(-1);
    assert.equal(detach.method, 'Target.setAutoAttach');
    assert.equal(detach.params.autoAttach, false);
    upstream.emit('message', JSON.stringify({ id: detach.id, result: {} }));
    assert.equal(session.active, null);
  }
  assert.equal(upstream.closes, 0);
  assert.equal(session.ready, true);
  session.close();
  assert.equal(upstream.closes, 1);
});

test('a worker timeout leaves the same pending Chrome approval connection alive', () => {
  const upstream = socket(), session = new ChromeSession(upstream);
  const first = socket();
  session.borrow(first, editor);
  first.emit('message', JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  first.close();
  assert.equal(upstream.closes, 0);
  assert.equal(session.queue.length, 0);
  const second = socket();
  session.borrow(second, editor);
  second.emit('message', JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  upstream.emit('open');
  assert.equal(upstream.sent.length, 1);
  const command = upstream.sent[0];
  upstream.emit('message', JSON.stringify({ id: command.id, result: {} }));
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 1);
  session.close();
});

test('lost Chrome connection blocks new borrowers instead of reconnecting silently', () => {
  const upstream = socket(), session = new ChromeSession(upstream);
  upstream.emit('open');
  upstream.emit('close');
  assert.equal(session.failed, true);
  assert.throws(() => session.borrow(socket(), editor), /unavailable/);
  assert.equal(upstream.sent.length, 0);
});

test('slow cleanup keeps its callback and accepts a late response on the same connection', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const upstream = socket(), session = new ChromeSession(upstream), client = socket();
  upstream.emit('open');
  session.borrow(client, editor);
  client.close();
  const cleanup = upstream.sent.at(-1);
  t.mock.timers.tick(5001);
  assert.equal(session.cleanupSlow, true);
  assert.equal(session.failed, false);
  assert.equal(session.active.releasing, true);
  assert.equal(upstream.closes, 0);
  upstream.emit('message', JSON.stringify({ id: cleanup.id, result: {} }));
  assert.equal(session.cleanupSlow, false);
  assert.equal(session.active, null);
  session.borrow(socket(), editor);
  session.close();
});

test('a new editor is owned by the create response, excludes existing same-URL tabs and closes only its own target', () => {
  const upstream = socket(), session = new ChromeSession(upstream), client = socket();
  upstream.emit('open');
  session.borrow(client, editor, { create: true });
  const create = upstream.sent.at(-1);
  assert.equal(create.method, 'Target.createTarget');
  client.emit('message', JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  assert.equal(upstream.sent.length, 1, 'worker must wait for ownership');
  upstream.emit('message', JSON.stringify({ id: create.id, result: { targetId: 'owned' } }));
  assert.equal(upstream.sent.at(-1).method, 'Browser.getVersion');
  for (const targetId of ['user-existing', 'owned']) {
    upstream.emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
      sessionId: targetId + '-session', targetInfo: { targetId, type: 'page', url: editor },
    } }));
  }
  assert.deepEqual(client.sent.filter(m => m.method === 'Target.attachedToTarget').map(m => m.params.targetInfo.targetId), ['owned']);
  client.close();
  const close = upstream.sent.at(-1);
  assert.deepEqual(close.params, { targetId: 'owned' });
  upstream.emit('message', JSON.stringify({ id: close.id, result: { success: true } }));
  const detach = upstream.sent.at(-1);
  assert.equal(detach.method, 'Target.setAutoAttach');
  upstream.emit('message', JSON.stringify({ id: detach.id, result: {} }));
  assert.equal(session.active, null);
  assert.equal(upstream.closes, 0);
});

test('worker exit during creation preserves the response and cleans up the late-created tab', () => {
  const upstream = socket(), session = new ChromeSession(upstream), client = socket();
  upstream.emit('open');
  session.borrow(client, editor, { create: true });
  const create = upstream.sent.at(-1);
  client.close();
  assert.equal(session.active.creating, true);
  assert.equal(session.pending.size, 1);
  upstream.emit('message', JSON.stringify({ id: create.id, result: { targetId: 'late-owned' } }));
  assert.deepEqual(upstream.sent.at(-1).params, { targetId: 'late-owned' });
  assert.equal(upstream.sent.at(-1).method, 'Target.closeTarget');
  session.close();
});

test('an already closed owned tab needs target-absence proof; old drafts cannot be opened as new', () => {
  const upstream = socket(), session = new ChromeSession(upstream), client = socket();
  upstream.emit('open');
  assert.throws(() => session.borrow(client, 'https://www.ebay.com/lstng?draftId=123', { create: true }), /existing draft/);
  assert.equal(upstream.sent.length, 0);
  session.borrow(client, editor, { create: true });
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { targetId: 'owned' } }));
  client.close();
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { success: false } }));
  assert.equal(upstream.sent.at(-1).method, 'Target.getTargets');
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { targetInfos: [{ targetId: 'user-existing' }] } }));
  assert.equal(upstream.sent.at(-1).method, 'Target.setAutoAttach');
  session.close();
});

test('failed window normalization closes only the owned target before worker initialization', () => {
  const upstream = socket(), client = socket();
  const session = new ChromeSession(upstream, { workWindow: () => ({ left: 0, top: -1000, width: 1400, height: 900 }) });
  upstream.emit('open'); session.borrow(client, editor, { create: true });
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { targetId: 'owned' } }));
  assert.equal(session.active.transport, null);
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, error: { message: 'window unavailable' } }));
  assert.equal(client.closes, 1);
  assert.equal(upstream.sent.at(-1).method, 'Target.closeTarget');
  assert.deepEqual(upstream.sent.at(-1).params, { targetId: 'owned' });
  session.close();
});

test('user webpage links stay open in a verified background window without attaching to login pages', async () => {
  const upstream = socket();
  const bounds = { left: 167, top: -1244, width: 1600, height: 1000 };
  const session = new ChromeSession(upstream, { workWindow: () => bounds });
  upstream.emit('open');
  const opened = session.openWindow('https://www.ebay.com/sh/ovw');
  assert.deepEqual(upstream.sent.at(-1).params, { url: 'https://www.ebay.com/sh/ovw', newWindow: true, background: true, focus: false, ...bounds });
  assert.throws(() => session.openWindow(editor), /busy/);
  upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { targetId: 'user-link' } }));
  placeOwnedWindow(upstream, bounds);
  assert.equal(await opened, true);
  assert.equal(session.active, null);
  assert.equal(upstream.sent.some(message => ['Target.closeTarget', 'Target.attachToTarget', 'Target.activateTarget', 'Page.bringToFront'].includes(message.method)), false);
  session.close();
});

test('invalid webpage URLs and missing second monitor never create a window', () => {
  const upstream = socket(), session = new ChromeSession(upstream);
  upstream.emit('open');
  for (const url of ['file:///private', 'http://example.com', 'https://user:password@example.com']) {
    assert.throws(() => session.openWindow(url), /Invalid webpage/);
  }
  assert.throws(() => session.openWindow(editor), /Second monitor/);
  assert.equal(upstream.sent.length, 0);
  assert.equal(session.active, null);
  session.close();
});

test('only exact local widget and extension setup pages can use the owned background opener', async () => {
  for (const url of ['http://127.0.0.1:41999/browser-link', 'chrome://extensions/']) {
    const upstream = socket(), bounds = { left: 0, top: -1000, width: 1400, height: 900 };
    const session = new ChromeSession(upstream, { workWindow: () => bounds }); upstream.emit('open');
    const opened = session.openWindow(url);
    assert.deepEqual(upstream.sent.at(-1).params, { url, newWindow: true, background: true, focus: false, ...bounds });
    upstream.emit('message', JSON.stringify({ id: upstream.sent.at(-1).id, result: { targetId: 'owned-setup' } }));
    placeOwnedWindow(upstream, bounds); assert.equal(await opened, true); session.close();
  }
  const upstream = socket(), session = new ChromeSession(upstream);
  for (const url of ['http://127.0.0.1:41999/settings', 'http://localhost:41999/browser-link',
    'http://127.0.0.1:41999/browser-link?other=1', 'chrome://settings/', 'chrome://extensions/?other=1']) {
    assert.throws(() => session.openWindow(url), /Invalid webpage/);
  }
  assert.equal(upstream.sent.length, 0); session.close();
});

test('a late failed webpage creation releases a timed-out request without closing an unknown target', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const upstream = socket();
  const session = new ChromeSession(upstream, { workWindow: () => ({ left: 0, top: -1000, width: 1400, height: 900 }) });
  upstream.emit('open');
  const opened = session.openWindow(editor), create = upstream.sent.at(-1);
  t.mock.timers.tick(30001);
  assert.equal(await opened, false);
  assert.equal(session.active.creating, true);
  upstream.emit('message', JSON.stringify({ id: create.id, error: { code: -32000 } }));
  const detach = upstream.sent.at(-1);
  assert.equal(detach.method, 'Target.setAutoAttach');
  assert.equal(upstream.sent.some(message => message.method === 'Target.closeTarget'), false);
  upstream.emit('message', JSON.stringify({ id: detach.id, result: {} }));
  assert.equal(session.active, null);
  session.close();
});
