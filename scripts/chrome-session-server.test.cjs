const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionHandlers } = require('../worker/black_cat_worker/chrome_session_server.cjs');
const editor = 'https://www.etsy.com/your/shops/me/listing-editor/create';

function fixture() {
  const borrowed = [], rejected = [];
  const session = { ready: true, borrow: (...args) => borrowed.push(args) };
  const socket = { end: text => rejected.push(text) };
  const handlers = sessionHandlers({ tokenPath: '/private', ownerPid: 321,
    sockets: { handleUpgrade: (_request, _socket, _head, callback) => callback('worker') },
    getSession: () => session, createSession: () => { throw Error('Must reuse Chrome'); } });
  const request = suffix => ({ headers: {}, url: '/private?editor=' + encodeURIComponent(editor) + suffix });
  return { borrowed, rejected, socket, handlers, request };
}

test('new editor routing reuses the live session and explicitly selects creation', () => {
  const { handlers, socket, request, borrowed } = fixture();
  handlers.upgrade(request('&create=1'), socket, null);
  assert.deepEqual(borrowed, [['worker', editor, { create: true }]]);
});

test('browser origins, wrong tokens and invalid creation modes cannot borrow or create tabs', () => {
  const { handlers, socket, request, borrowed, rejected } = fixture();
  handlers.upgrade({ ...request('&create=1'), headers: { origin: 'https://example.com' } }, socket, null);
  handlers.upgrade({ ...request(''), url: '/wrong?editor=' + encodeURIComponent(editor) }, socket, null);
  handlers.upgrade(request('&create=2'), socket, null);
  assert.equal(rejected.length, 3);
  assert.equal(borrowed.length, 0);
});

test('capability status tells callers this helper can create a fresh editor safely', () => {
  const { handlers } = fixture();
  let result;
  handlers.request({ headers: {}, method: 'GET', url: '/private/status' }, {
    setHeader() {}, end: text => { result = JSON.parse(text); },
  });
  assert.ok(result.capabilities.includes('new-editor-v1'));
  assert.equal(result.ownerPid, 321);
});

test('only authenticated local requests can open an explicit background webpage', async () => {
  const { EventEmitter } = require('node:events');
  const opened = [];
  const handlers = sessionHandlers({ tokenPath: '/private', ownerPid: 321,
    getSession: () => ({ openWindow: async url => { opened.push(url); return true; } }),
    createSession: () => { throw Error('Do not reconnect'); } });
  const request = new EventEmitter();
  Object.assign(request, { method: 'POST', headers: {}, url: '/private/open-window' });
  let body;
  const done = new Promise(resolve => handlers.request(request, { setHeader() {}, end(text) { body = JSON.parse(text); resolve(); } }));
  request.emit('data', JSON.stringify({ url: editor })); request.emit('end');
  await done;
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(opened, [editor]);
  for (const extra of [{ headers: { origin: 'https://example.com' } }, { url: '/wrong/open-window' }]) {
    let code;
    const response = { writeHead(value) { code = value; return this; }, end() {} };
    handlers.request({ headers: {}, method: 'POST', url: '/private/open-window', ...extra }, response);
    assert.equal(code, 403);
  }
  assert.equal(opened.length, 1);
});
