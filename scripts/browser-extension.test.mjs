import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createController } from "../extensions/marketplace-bridge/controller.mjs";
import { APP_URL, marketplaceForUrl, safeUrl } from "../extensions/marketplace-bridge/policy.mjs";
import { inspectSellerPage } from "../extensions/marketplace-bridge/inspect.mjs";

const sender = { frameId: 0, url: APP_URL, tab: { url: APP_URL } };
test("extension accepts only the exact local top-level connection page", async () => {
  const handle = createController({});
  for (const source of [undefined, { ...sender, frameId: 1 }, { ...sender, url: 'https://www.ebay.com/' },
    { ...sender, tab: { url: APP_URL + '?fake=1' } }, { ...sender, url: APP_URL.replace('41999', '42000') }]) {
    await assert.rejects(handle({ type: 'ping' }, source), /Only the local/);
  }
  assert.deepEqual((await handle({ type: 'ping' }, sender)).capabilities, ['tabs', 'open', 'inspect']);
  const manifest = JSON.parse(fs.readFileSync(new URL('../extensions/marketplace-bridge/manifest.json', import.meta.url)));
  assert.equal((await handle({ type: 'ping' }, sender)).version, manifest.version);
});
test("information-only extension rejects mutation and arbitrary script commands", async () => {
  const handle = createController({});
  for (const type of ['publish', 'fill', 'click', 'delist', 'evaluate', 'cookies']) {
    await assert.rejects(handle({ type, marketplace: 'ebay', tabId: 1 }, sender), /Unsupported/);
  }
  const manifest = JSON.parse(fs.readFileSync(new URL('../extensions/marketplace-bridge/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions, ['scripting']);
  assert.ok(manifest.host_permissions.every((url) => marketplaceForUrl(url.replace('*', ''))));
});
test("tab inspection verifies platform before and after script execution", async () => {
  let scripts = 0, reads = 0;
  const handle = createController({
    tabs: { get: async () => ({ id: 1, url: ++reads === 1 ? 'https://www.ebay.com/lstng' : 'https://www.ebay.com/signin' }) },
    scripting: { executeScript: async () => { scripts++; return [{ result: { state: 'seller_page' } }]; } },
  });
  await assert.rejects(handle({ type: 'inspect', marketplace: 'etsy', tabId: 1 }, sender), /no longer/);
  assert.equal(scripts, 0);
  reads = 0;
  await assert.rejects(handle({ type: 'inspect', marketplace: 'ebay', tabId: 1 }, sender), /tab changed/);
  assert.equal(scripts, 1);
});
test("only marketplace tabs are exposed and login query parameters are discarded", async () => {
  const handle = createController({ tabs: { query: async () => [
    { id: 1, url: 'https://www.ebay.com/sh/ovw?token=private' },
    { id: 2, url: 'https://mail.google.com/' },
    { id: 3, url: 'https://www.ebay.com.evil.example/' },
  ] } });
  assert.deepEqual(await handle({ type: 'tabs' }, sender), { tabs: [{ id: 1, marketplace: 'ebay', url: 'https://www.ebay.com/sh/ovw' }] });
  assert.equal(safeUrl('https://www.ebay.com/lstng?draftId=123&token=secret'), 'https://www.ebay.com/lstng?draftId=123');
});

test("Etsy's current create editor is inspected while login and order pages stay excluded", () => {
  const field = (type, id, value) => ({ tagName: 'INPUT', type, id, name: id, value, disabled: false,
    getClientRects: () => [{}], getAttribute: () => null, labels: [{ textContent: id }] });
  const title = field('text', 'listing-title-input', 'Reviewed title');
  const secret = field('hidden', 'csrf', 'must not be returned');
  const inspect = (pathname, login = false) => vm.runInNewContext(`(${inspectSellerPage.toString()})()`, {
    location: { hostname: 'www.etsy.com', pathname }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { title: 'Edit', querySelectorAll(selector) {
      if (selector.startsWith('input[type="password"]')) return login ? [field('password', 'password', 'private')] : [];
      if (selector.startsWith('h1,')) return [];
      return [title, secret];
    } },
  });
  for (const pathname of ['/your/shops/me/listing-editor/create', '/your/shops/me/listing-editor/create/', '/your/shops/me/tools/listings/create']) {
    const result = inspect(pathname);
    assert.equal(result.state, 'seller_page');
    assert.equal(result.controls.length, 1);
    assert.equal(result.controls[0].id, 'listing-title-input');
    assert.equal(JSON.stringify(result).includes('must not be returned'), false);
  }
  for (const pathname of ['/your/shops/me/orders', '/your/shops/me/listing-editor/create/orders', '/signin']) {
    assert.equal(inspect(pathname).state, 'needs_operator');
  }
  assert.equal(inspect('/your/shops/me/listing-editor/create', true).state, 'needs_operator');
});

test("form inspection includes grouped native choices without exposing hidden selects", () => {
  const choice = (text, value, group) => ({ textContent: text, value, selected: false, disabled: false,
    parentElement: { tagName: 'OPTGROUP', label: group } });
  const select = { tagName: 'SELECT', type: 'select-one', id: 'when-made-select', name: '', value: '',
    getClientRects: () => [{}], getAttribute: () => null, labels: [{ textContent: 'When was it made?' }],
    options: [choice('2000 - 2006', '2000_2006', 'Vintage')] };
  const hidden = { ...select, id: 'private-select', getClientRects: () => [], options: [choice('private', 'secret', '')] };
  const result = vm.runInNewContext(`(${inspectSellerPage.toString()})()`, {
    location: { hostname: 'www.etsy.com', pathname: '/your/shops/me/listing-editor/create' },
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { title: 'Edit', querySelectorAll(selector) { return selector.startsWith('input[type="password"]') || selector.startsWith('h1,') ? [] : [select, hidden]; } },
  });
  assert.equal(result.controls.length, 2);
  assert.equal(result.controls[1].tag, 'option');
  assert.equal(result.controls[1].id, 'when-made-select');
  assert.equal(result.controls[1].label, 'Vintage');
  assert.equal(result.controls[1].value, '2000_2006');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
