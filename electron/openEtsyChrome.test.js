const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { openEtsyChrome, openEbayChrome, openMercariChrome } = require("./openEtsyChrome");

const display = { secondary: true, bounds: { left: 167, top: -1244, width: 1600, height: 1000 } };
const windowArgs = ['-m', 'black_cat_worker.open_browser_link', '--url'];

test("Etsy sign-in routes only the fixed seller URL through the background Chrome broker", async () => {
  let launched;
  const result = await openEtsyChrome({ display, environment: { PROGRAMFILES: "C:\\Apps" }, exists: () => true,
    launch: (...args) => {
      launched = args;
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit("exit", 0)); return child;
    } });
  assert.equal(result, true);
  assert.equal(launched[0], path.join(__dirname, '..', 'worker', '.venv', 'Scripts', 'python.exe'));
  assert.equal(launched[2].windowsHide, true);
  assert.ok(launched[2].env.BLACKCAT_CHROME_OWNER_PID);
  assert.deepEqual(launched[1], [...windowArgs, "https://www.etsy.com/your/shops/me/dashboard"]);
});

test("missing worker never falls back to another browser or a separate seller profile", async () => {
  assert.equal(await openEtsyChrome({ display, environment: {}, exists: () => false, launch: () => { throw Error("Must not launch"); } }), false);
});

test("eBay uses the fixed Seller Hub URL in the same normal Chrome path", async () => {
  let url;
  assert.equal(await openEbayChrome({ display, environment: { PROGRAMFILES: "C:\\Apps" }, exists: () => true,
    launch: (_exe, args) => {
      url = args.at(-1); const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit("exit", 0)); return child;
    } }), true);
  assert.equal(url, "https://www.ebay.com/sh/ovw");
});

test("Mercari opens the fixed US seller inventory in normal Chrome", async () => {
  let args;
  assert.equal(await openMercariChrome({ display, environment: { PROGRAMFILES: "C:\\Apps" }, exists: () => true,
    launch: (_exe, value) => { args = value; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('exit', 0)); return child; } }), true);
  assert.deepEqual(args, [...windowArgs, 'https://www.mercari.com/mypage/listings/active/']);
});

test('no second monitor never launches Chrome or falls back to a personal tab', async () => {
  for (const placement of [undefined, { secondary: false, bounds: null }]) {
    let launched = false;
    assert.equal(await openEbayChrome({ display: placement, launch: () => { launched = true; } }), false);
    assert.equal(launched, false);
  }
});
