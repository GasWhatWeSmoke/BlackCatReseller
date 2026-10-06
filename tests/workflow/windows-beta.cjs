// Actual packaged Electron acceptance. Invoked only by windows-beta.py's owned job.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const configPath = path.resolve(process.argv[2] || '');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = fs.realpathSync(config.fixtureRoot);
const within = value => { const relative = path.relative(root, path.resolve(value)); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
assert.ok(within(configPath)); assert.ok(within(config.executable)); assert.ok(within(config.output));
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'fixture-owner.json'), 'utf8')).nonce, config.nonce);
const playwright = require(config.playwrightPackage);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const progress = phase => process.stdout.write(JSON.stringify({ phase: config.phase, event: phase }) + '\n');
let app = null;
const proof = { phase: config.phase, version: config.version, launched: false, normalShutdown: false,
  externalRequests: [], mutationRequests: [], browserErrors: [], checks: [], osIsolation: false, installerTest: false };

function guard() {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'fixture-owner.json'), 'utf8')).nonce, config.nonce);
  if (fs.existsSync(path.join(root, 'abort.json'))) throw Error('The fixture foreground/process guard requested shutdown.');
}

// DOM activation exercises the actual React controls without native mouse or focus.
async function click(locator) { guard(); await locator.waitFor({ state: 'visible' }); await locator.evaluate(element => element.click()); }
async function fill(locator, value) {
  guard(); await locator.waitFor({ state: 'visible' });
  await locator.evaluate((element, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  assert.equal(await locator.inputValue(), String(value));
}

async function windowProof() {
  guard();
  const state = await app.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    return { primary: screen.getPrimaryDisplay().id, displays: screen.getAllDisplays().map(display => ({ id: display.id, workArea: display.workArea })),
      windows: windows.map(window => ({ bounds: window.getBounds(), focused: window.isFocused(), maximized: window.isMaximized(), fullScreen: window.isFullScreen(), visible: window.isVisible() })) };
  });
  assert.equal(state.windows.length, 1, 'The fixture must own exactly one desktop window');
  const window = state.windows[0];
  assert.equal(window.focused, false, 'The preview must stay in the background');
  assert.equal(window.maximized, false); assert.equal(window.fullScreen, false);
  assert.ok(state.displays.some(display => display.id !== state.primary && window.bounds.x >= display.workArea.x &&
    window.bounds.y >= display.workArea.y && window.bounds.x + window.bounds.width <= display.workArea.x + display.workArea.width &&
    window.bounds.y + window.bounds.height <= display.workArea.y + display.workArea.height), 'The complete normal-sized window must remain on monitor two');
  return state;
}

async function practice(page) {
  const section = page.locator('#practice');
  await click(section.getByRole('button', { name: 'Start practice', exact: true }));
  await click(section.getByRole('button', { name: 'Finish this practice review', exact: true }));
  await section.getByRole('alert').filter({ hasText: 'Check the sample views' }).waitFor();
  const checked = [];
  for (let index = 1; index <= 10; index++) {
    guard();
    const expected = await section.locator('dl').evaluate(list => Object.fromEntries([...list.querySelectorAll('dt')].map(term => [term.textContent.trim(), term.nextElementSibling.textContent.trim()])));
    await fill(section.getByLabel('Practice item type', { exact: true }), expected['Item type']);
    await fill(section.getByLabel('Practice color', { exact: true }), expected.Color);
    await fill(section.getByLabel('Practice size', { exact: true }), expected.Size);
    await fill(section.getByLabel('Practice price ($)', { exact: true }), expected['Practice price'].replace(/^\$/, ''));
    await click(section.getByRole('checkbox', { name: 'I checked the three sample views and item identity.', exact: true }));
    await click(section.getByRole('checkbox', { name: 'I compared the details and price with the fictional reference.', exact: true }));
    await click(section.getByRole('button', { name: 'Finish this practice review', exact: true }));
    await section.getByText(`${index} of 10 practice items reviewed`, { exact: true }).waitFor();
    checked.push(index);
    if (index < 10) await click(section.getByRole('button', { name: 'Next practice item', exact: true }));
  }
  await section.getByRole('heading', { name: 'All ten practice reviews complete', exact: true }).waitFor();
  assert.equal(checked.length, 10);
  await section.screenshot({ path: path.join(config.output, 'practice-complete.png') });
  proof.practiceReviews = checked.length;
}

(async () => {
  assert.equal(process.platform, 'win32');
  const authorization = path.join(root, 'launch-authorized.json');
  for (let attempt = 0; attempt < 200 && !fs.existsSync(authorization); attempt++) await delay(50);
  assert.equal(JSON.parse(fs.readFileSync(authorization, 'utf8')).nonce, config.nonce, 'The parent must install its process job before launch');
  guard(); progress('launching-owned-preview');
  app = await playwright._electron.launch({ executablePath: config.executable, cwd: path.dirname(config.executable),
    env: config.environment, timeout: 60000, args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability'] });
  proof.launched = true;
  proof.runtime = await app.evaluate(({ app }) => ({ pid: process.pid, executable: process.execPath, appRoot: app.getAppPath(),
    version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, userData: app.getPath('userData'),
    database: process.env.DATABASE_URL, dataRoot: process.env.BLACKCAT_DATA_ROOT, runtimeRoot: process.env.BLACKCAT_RUNTIME_ROOT,
    systemPath: process.env.PATH || process.env.Path || '' }));
  fs.writeFileSync(path.join(config.output, 'owned-runtime.json'), JSON.stringify(proof.runtime, null, 2));
  assert.equal(path.resolve(proof.runtime.executable).toLowerCase(), path.resolve(config.executable).toLowerCase());
  assert.equal(proof.runtime.version, config.version);
  assert.equal(proof.runtime.database, config.environment.DATABASE_URL);
  assert.equal(path.resolve(proof.runtime.userData), path.join(root, 'workspace', 'var', 'desktop-profile'));
  assert.equal(proof.runtime.systemPath, config.environment.PATH);
  if (config.installerGuard) {
    guard();
    assert.ok(within(config.installerGuard.executable)); assert.ok(within(config.installerGuard.marker));
    const result = require('node:child_process').spawnSync(config.installerGuard.executable, ['/S'], {
      windowsHide: true, timeout: 15000, encoding: 'utf8',
    });
    assert.equal(result.status, 10, 'The actual NSIS guard must refuse a running app');
    assert.equal(fs.existsSync(config.installerGuard.marker), false, 'A refused installer must not pass its guard');
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), config.version, 'Refusing setup must leave the app running');
    proof.checks.push('actual-nsis-guard-refused-running-app-without-stopping-it');
  }
  const context = app.context(); context.setDefaultTimeout(20000);
  const observePage = page => page.on('pageerror', error => proof.browserErrors.push(error.message));
  context.pages().forEach(observePage); context.on('page', observePage);
  await context.route('**/*', async route => {
    const request = route.request(), target = new URL(request.url());
    if (!['http:', 'https:'].includes(target.protocol)) { await route.continue(); return; }
    if (target.origin !== config.origin) { proof.externalRequests.push(target.origin + target.pathname); await route.abort(); return; }
    if (!['GET', 'HEAD'].includes(request.method())) { proof.mutationRequests.push({ method: request.method(), path: target.pathname }); await route.abort(); return; }
    await route.continue();
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForURL(address => address.origin === config.origin, { timeout: 60000 });
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).waitFor();
  await page.getByText(`Black Cat · v${config.version} · Beta`, { exact: true }).waitFor();
  proof.window = await windowProof();
  if (config.phase === 'fresh') {
    await click(page.getByRole('link', { name: 'Open the guide', exact: true }));
  } else {
    assert.equal(await page.evaluate(() => localStorage.getItem('blackcat.windows-beta-fixture')), config.nonce, 'The isolated desktop profile must survive restart and artifact relocation');
    await click(page.getByRole('link', { name: 'Inventory', exact: true }));
    for (let index = 1; index <= config.itemCount; index++) {
      await page.getByRole('link', { name: new RegExp(`^Open ${900000 + index}:`) }).waitFor();
    }
    assert.equal(await page.getByRole('link', { name: /^Open 9000\d\d:/ }).count(), config.itemCount);
    await page.screenshot({ path: path.join(config.output, 'persisted-inventory.png') });
    await page.goto(`${config.origin}/setup`);
  }
  await page.getByRole('heading', { name: 'Getting started', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Your first batch, step by step', exact: true }).waitFor();
  await page.getByText('Not verified yet — finish or repair worker setup, then re-check.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Then test ten real garments', exact: true }).waitFor();
  assert.equal(await page.locator('a[href="/beta-labels.html"]').count(), 1);
  await page.screenshot({ path: path.join(config.output, 'getting-started.png') });
  if (config.phase === 'fresh') {
    await practice(page);
    await page.evaluate(value => localStorage.setItem('blackcat.windows-beta-fixture', value), config.nonce);
  } else {
    await page.locator('#practice').getByRole('button', { name: 'Start practice', exact: true }).waitFor();
    proof.practiceResetOnRestart = true;
  }
  proof.finalWindow = await windowProof();
  assert.deepEqual(proof.externalRequests, []); assert.deepEqual(proof.mutationRequests, []); assert.deepEqual(proof.browserErrors, []);
  proof.checks.push('packaged-runtime-without-system-node-python', 'background-secondary-window', 'version', 'getting-started-and-missing-worker-guidance', 'no-browser-network-or-mutations');
  progress('checks-passed');
})().catch(error => { proof.error = error.stack || String(error); process.exitCode = 1; }).finally(async () => {
  if (app) {
    progress('normal-app-quit');
    let timer;
    try {
      await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Normal app shutdown timed out')), 20000); })]);
      proof.normalShutdown = true;
    } catch (error) { proof.shutdownError = error.message; process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
  fs.writeFileSync(path.join(config.output, 'result.json'), JSON.stringify(proof, null, 2));
  progress(proof.error || !proof.normalShutdown ? 'failed' : 'closed');
  if (proof.error || !proof.normalShutdown) setTimeout(() => process.exit(1), 50);
});
