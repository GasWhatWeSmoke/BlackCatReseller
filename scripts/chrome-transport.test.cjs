const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SellerTransport, sellerEditor } = require('../worker/black_cat_worker/chrome_transport.cjs');
const editor = 'https://www.etsy.com/your/shops/me/listing-editor/create';

function fixture() {
  const socket = new EventEmitter();
  const sent = [], received = [];
  socket.send = raw => sent.push(JSON.parse(raw));
  socket.close = () => socket.emit('close');
  const transport = new SellerTransport(socket, editor);
  transport.onmessage = value => received.push(value);
  const attach = (sessionId, url, parent) => transport.receive({ method: 'Target.attachedToTarget',
    ...(parent ? { sessionId: parent } : {}), params: { sessionId, targetInfo: { type: 'page', url } } });
  return { transport, sent, received, attach };
}

test('unrelated and extension targets never reach page initialization and are detached without pausing', () => {
  const { transport, sent, received, attach } = fixture();
  transport.send({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
  assert.equal(sent[0].params.waitForDebuggerOnStart, false);
  attach('unrelated', 'https://example.com/');
  attach('extension', 'chrome-extension://example/popup.html');
  assert.equal(received.length, 0);
  assert.deepEqual(sent.slice(1).map(m => m.method), ['Target.detachFromTarget', 'Target.detachFromTarget']);
  transport.receive({ sessionId: 'unrelated', method: 'Runtime.consoleAPICalled', params: {} });
  assert.equal(received.length, 0);
  attach('seller', editor + '#details');
  attach('frame', 'https://static.etsy.com/frame', 'seller');
  transport.send({ id: 2, sessionId: 'frame', method: 'Runtime.enable' });
  assert.equal(received.length, 2);
  assert.equal(sent.at(-1).sessionId, 'frame');
});

test('borrowed browser and user tabs cannot be closed or replaced through root target commands', async () => {
  const { transport, sent, received } = fixture();
  for (const method of ['Browser.close', 'Target.closeTarget', 'Target.createTarget', 'Target.disposeBrowserContext']) {
    transport.send({ id: 10, method });
  }
  transport.send({ id: 11, sessionId: 'unrelated', method: 'Runtime.evaluate' });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(sent.length, 0);
  assert.equal(received.length, 5);
  assert.ok(received.every(m => m.error));
});

test('only exact supported seller editor URLs are accepted', () => {
  assert.equal(sellerEditor(editor), editor);
  assert.equal(sellerEditor(editor + '#shipping'), editor);
  assert.equal(sellerEditor('https://www.ebay.com/lstng?draftId=123'), 'https://www.ebay.com/lstng?draftId=123');
  assert.equal(sellerEditor('https://www.ebay.com/sl/sell'), 'https://www.ebay.com/sl/sell');
  for (const url of ['https://www.etsy.com/signin', 'https://www.etsy.com.evil.test/your/shops/me/listing-editor/create',
    'http://www.etsy.com/your/shops/me/listing-editor/create', 'https://user:secret@www.ebay.com/lstng',
    'https://www.ebay.com:123/lstng']) assert.throws(() => sellerEditor(url));
});

test('owned seller tools use only fixed inventory and order entry pages', () => {
  for (const url of ['https://www.ebay.com/sh/lst/active', 'https://www.ebay.com/sh/ord',
    'https://www.etsy.com/your/shops/me/tools/listings', 'https://www.etsy.com/your/orders/sold']) assert.equal(sellerEditor(url), url);
  for (const url of ['https://www.ebay.com/sh/ord/details', 'https://www.etsy.com/your/purchases',
    'https://www.ebay.com/sh/ord.evil', 'https://www.etsy.com/your/orders/sold/anything']) assert.throws(() => sellerEditor(url));
});

test('Mercari tools cannot attach to purchases, arbitrary items or non-US hosts', () => {
  for (const url of ['https://www.mercari.com/sell/', 'https://www.mercari.com/mypage/listings/active/']) assert.equal(sellerEditor(url), url);
  for (const url of ['https://www.mercari.com/mypage/purchases/', 'https://www.mercari.com/us/item/m12345678901/', 'https://jp.mercari.com/sell/']) assert.throws(() => sellerEditor(url));
});
