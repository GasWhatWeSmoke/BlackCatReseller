const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { isAppUrl, assertNativeCaller, guardNavigation, copyManagedImage } = require("./nativeBoundary");
const { resolveWorkerRuntime } = require("./runtimePaths");

const origin = "http://127.0.0.1:41999";
function caller() {
  const mainFrame = { url: `${origin}/review` };
  const webContents = { mainFrame, isDestroyed: () => false };
  return { window: { webContents, isDestroyed: () => false }, event: { sender: webContents, senderFrame: mainFrame } };
}

test("native trust requires the owned main frame and exact local origin", () => {
  const { window, event } = caller();
  assert.doesNotThrow(() => assertNativeCaller(event, window, origin));
  for (const url of ["https://untrusted.invalid", "http://127.0.0.1:419990", "http://localhost:41999",
    "http://127.0.0.1:41999.evil.invalid", "http://127.0.0.1:41999@evil.invalid", "http://user@127.0.0.1:41999",
    "file:///photo.jpg", "data:text/html,hello", "about:blank", "garbage"]) {
    assert.equal(isAppUrl(url, origin), false, url);
    event.senderFrame.url = url;
    assert.throws(() => assertNativeCaller(event, window, origin));
  }
  event.senderFrame.url = `${origin}/inventory?search=SKU#photo`;
  for (const changed of [{ ...event, sender: {} }, { ...event, senderFrame: null },
    { ...event, senderFrame: { url: event.senderFrame.url } }]) {
    assert.throws(() => assertNativeCaller(changed, window, origin));
  }
  assert.throws(() => assertNativeCaller(event, null, origin));
  window.isDestroyed = () => true;
  assert.throws(() => assertNativeCaller(event, window, origin));
});

test("navigation and redirects stay in the local app", () => {
  const contents = new EventEmitter();
  guardNavigation(contents, origin);
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
    for (const url of [`${origin}/inventory`, "https://untrusted.invalid", "file:///photo.jpg", "data:text/html,hello"]) {
      let blocked = false;
      contents.emit(name, { url, preventDefault() { blocked = true; } });
      assert.equal(blocked, !url.startsWith(origin), `${name}: ${url}`);
    }
  }
});

test("every registered native handler rejects another window, child frame, or remote page before side effects", async () => {
  const handlers = new Map(); let effects = 0;
  const effect = () => { effects++; return true; };
  const electron = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => "unused" },
    dialog: { showOpenDialog: async () => { effect(); return { canceled: true }; } },
    Notification: class { show() { effect(); } },
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
    clipboard: { writeImage: effect }, nativeImage: { createFromBuffer: effect },
  };
  const context = vm.createContext({
    require: name => name === "electron" ? electron : name === "./openEtsyChrome" ? {
      openEtsyChrome: effect, openEbayChrome: effect, openMercariChrome: effect, openSellerChrome: effect,
    } : name === "./crawlerDisplay" ? { crawlerDisplay: () => ({}) } :
      name === "./runtimePaths" ? { resolveWorkerRuntime: options => resolveWorkerRuntime({ ...options, environment: options.environment || {} }) } :
      name === "./workerSetup" ? { createWorkerSetup: () => ({ start: effect, status: effect, stop: async () => {} }) } :
      name.startsWith("./") && name !== "./nativeBoundary" ? {} : require(name),
    __dirname, process, console, fetch,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"), context);
  const { window, event } = caller();
  window.blur = effect; window.focus = effect; window.webContents.focus = effect;
  context.testWindow = window;
  vm.runInContext("win = testWindow", context);
  assert.equal(handlers.size, 17);
  assert.ok(handlers.has("setup-worker")); assert.ok(handlers.has("worker-setup-status"));
  for (const [name, handler] of handlers) {
    for (const badEvent of [{ ...event, sender: {} }, { ...event, senderFrame: { url: `${origin}/child` } }]) {
      await assert.rejects(async () => handler(badEvent, { title: "Test", body: "Test" }), /Native actions/);
    }
    event.senderFrame.url = "https://untrusted.invalid";
    await assert.rejects(async () => handler(event, "https://example.com"), /Native actions/, name);
    event.senderFrame.url = origin;
  }
  assert.equal(effects, 0);
  await handlers.get("pick-folder")(event);
  await handlers.get("pick-file")(event);
  await handlers.get("notify")(event, { title: "Test", body: "Test" });
  for (const name of ["open-external", "open-etsy-seller", "open-ebay-seller", "open-mercari-seller", "refocus"]) {
    assert.equal(await handlers.get(name)(event, "https://example.com"), true);
  }
  assert.equal(effects, 10);
  assert.equal(await handlers.get("setup-worker")(event), true);
  assert.equal(await handlers.get("worker-setup-status")(event), true);
  assert.equal(effects, 12);
});

test("clipboard reads only the photo API and rejects forbidden paths, redirects, and failed responses", async t => {
  let redirected = 0, writes = 0, reads = 0;
  const server = http.createServer((req, res) => {
    reads++;
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/redirected") { redirected++; res.end("image"); return; }
    assert.equal(url.pathname, "/api/photo");
    const p = url.searchParams.get("path");
    if (p === "forbidden.jpg") res.writeHead(403).end();
    else if (p === "redirect.jpg") res.writeHead(302, { Location: "/redirected" }).end();
    else if (p === "error.jpg") res.writeHead(500).end();
    else res.end("fixture image bytes");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const options = { origin: `http://127.0.0.1:${server.address().port}`, checkCaller() {},
    nativeImage: { createFromBuffer: bytes => { assert.equal(bytes.toString(), "fixture image bytes"); return { isEmpty: () => false }; } },
    clipboard: { writeImage: () => { writes++; } } };
  assert.equal(await copyManagedImage("C:\\photos\\a & b.jpg", options), true);
  for (const p of ["forbidden.jpg", "redirect.jpg", "error.jpg", "file.txt", null]) {
    assert.equal(await copyManagedImage(p, options), false);
  }
  assert.equal(writes, 1); assert.equal(reads, 4); assert.equal(redirected, 0);
});

test("clipboard stays untouched after navigation during an image read or invalid image bytes", async () => {
  const { window, event } = caller(); let writes = 0;
  const options = { origin, checkCaller: () => assertNativeCaller(event, window, origin),
    request: async () => ({ ok: true, arrayBuffer: async () => { event.senderFrame.url = "https://untrusted.invalid"; return new ArrayBuffer(1); } }),
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) }, clipboard: { writeImage() { writes++; } } };
  assert.equal(await copyManagedImage("valid.jpg", options), false);
  event.senderFrame.url = origin;
  options.nativeImage.createFromBuffer = () => ({ isEmpty: () => true });
  assert.equal(await copyManagedImage("invalid.jpg", options), false);
  assert.equal(writes, 0);
});

test("an isolated preview rejects native setup, browser, clipboard and focus actions even from its owned frame",async()=>{
  const handlers=new Map();let effects=0;
  const effect=()=>{effects++;return true;};
  const electron={ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    app:{requestSingleInstanceLock:()=>false,quit(){},getPath:()=> 'C:/fixture-home',setPath(){}},
    clipboard:{writeImage:effect},Notification:class{show(){effect();}}};
  const context=vm.createContext({__dirname,console,
    process:{env:{BLACKCAT_PREVIEW:'1',BLACKCAT_PREVIEW_PORT:'53000',BLACKCAT_DATA_ROOT:'C:/fixture-preview/var',DATABASE_URL:'file:C:/fixture-preview/preview.db'}},
    require:name=>name==='electron'?electron:name==='./workerSetup'?{createWorkerSetup:()=>({start:effect,status:()=>({state:'idle'}),stop:async()=>{}})}:
      name==='./nativeBoundary'?require(name):name.startsWith('./')?{}:require(name)});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),context);
  const {window,event}=caller();event.senderFrame.url='http://127.0.0.1:53000/setup';
  context.fixtureWindow=window;vm.runInContext('win = fixtureWindow',context);
  for(const name of ['setup-worker','open-external','open-etsy-seller','open-ebay-seller','open-mercari-seller','chrome-connect','chrome-disconnect',
    'open-chrome-widget','open-chrome-extensions','copy-image','notify','refocus']){
    await assert.rejects(async()=>handlers.get(name)(event,'https://example.invalid'),/isolated preview/);
  }
  assert.equal(effects,0);
  assert.deepEqual(await handlers.get('worker-setup-status')(event),{state:'idle'});
});
