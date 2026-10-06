const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChromeControl } = require('./chromeControl');
const { chromeControl } = require('../worker/black_cat_worker/chrome_control.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-chrome-controls-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  let session = null, starts = 0, closes = 0;
  const helper = chromeControl({ directory, ownerPid: 321, pid: 654, getSession: () => session,
    clearSession: () => { session = null; }, createSession: () => session ??= {
      ready: false, failed: false, active: null, number: ++starts, close() { closes++; },
    } });
  helper.tick();
  const native = createChromeControl({ root: directory, dataRoot: directory, ownerPid: 321,
    launch: () => { throw Error('Must reuse the existing helper'); } });
  const timer = setInterval(helper.tick, 20); t.after(() => clearInterval(timer));
  return { directory, native, helper, session: () => session, starts: () => starts, closes: () => closes };
}

test('connect awaits browser approval, reuses pending connection, and disconnect pauses without killing Chrome', async t => {
  const f = fixture(t);
  assert.equal((await f.native.command('connect')).approvalPending, true);
  await f.native.command('connect'); assert.equal(f.starts(), 1);
  f.session().ready = true; f.helper.tick(); assert.equal(f.native.status().connected, true);
  const ended = await f.native.command('disconnect');
  assert.equal(ended.connected, false); assert.equal(ended.paused, true);
  assert.equal(f.closes(), 1); assert.equal(f.helper.isPaused(), true);
  await f.native.command('connect'); assert.equal(f.starts(), 2); assert.equal(f.helper.isPaused(), false);
});

test('active work cannot be interrupted or reconnected by app controls', async t => {
  const f = fixture(t); await f.native.command('connect'); f.session().active = { item: 'owned' };
  for (const action of ['disconnect', 'connect']) await assert.rejects(f.native.command(action), /task is active/);
  assert.equal(f.closes(), 0); assert.equal(f.helper.isPaused(), false);
});

test('stale and foreign helper receipts never claim a current connection', t => {
  const f = fixture(t), target = path.join(f.directory, 'native-chrome-control-status.json');
  const original = JSON.parse(fs.readFileSync(target));
  for (const patch of [{ ownerPid: 123 }, { at: Date.now() - 6000 }, { at: Date.now() + 10000 }]) {
    fs.writeFileSync(target, JSON.stringify({ ...original, connected: true, ...patch }));
    assert.equal(f.native.status().available, false); assert.equal(f.native.status().connected, false);
  }
});

test('commands for a different helper or expired commands cannot affect Chrome', t => {
  const f = fixture(t), target = path.join(f.directory, 'native-chrome-control-command.json');
  for (const patch of [{ ownerPid: 111 }, { pid: 111 }, { at: Date.now() - 16000 }]) {
    fs.writeFileSync(target, JSON.stringify({ version: 1, ownerPid: 321, pid: 654, id: 'foreign', action: 'connect', at: Date.now(), ...patch }));
    f.helper.tick(); assert.equal(f.starts(), 0);
  }
});

test('only an explicit reconnect replaces a failed browser socket', async t => {
  const f = fixture(t); await f.native.command('connect');
  f.session().failed = true;
  for (let i = 0; i < 3; i++) f.helper.tick();
  assert.equal(f.starts(), 1); assert.equal(f.native.status().failed, true);
  await f.native.command('connect');
  assert.equal(f.starts(), 2); assert.equal(f.closes(), 1);
});

test('status-file contention preserves the helper and acknowledged commands recover without reconnecting', async t => {
  const f = fixture(t); await f.native.command('connect');
  f.session().ready = true; f.helper.tick();
  const statusPath = path.join(f.directory, 'native-chrome-control-status.json');
  const commandPath = path.join(f.directory, 'native-chrome-control-command.json');
  const before = fs.readFileSync(statusPath, 'utf8');
  for (const method of ['writeFileSync', 'renameSync']) {
    const original = fs[method];
    const mocked = t.mock.method(fs, method, function (file, ...args) {
      if (file === statusPath + '.654.tmp') throw Object.assign(Error('fixture file busy'), { code: 'EPERM' });
      return original.call(fs, file, ...args);
    });
    try {
      for (let i = 0; i < 3; i++) assert.doesNotThrow(() => f.helper.tick());
      assert.equal(fs.readFileSync(statusPath, 'utf8'), before);
      assert.equal(f.starts(), 1); assert.equal(f.closes(), 0);
    } finally { mocked.mock.restore(); }
  }
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === statusPath) throw Object.assign(Error('fixture file busy'), { code: 'EPERM' });
    return rename.call(fs, from, to);
  });
  fs.writeFileSync(commandPath, JSON.stringify({ version: 1, ownerPid: 321, pid: 654,
    id: 'disconnect-once', action: 'disconnect', at: Date.now() }));
  try {
    for (let i = 0; i < 3; i++) assert.doesNotThrow(() => f.helper.tick());
    assert.equal(f.helper.isPaused(), true); assert.equal(f.closes(), 1);
    assert.equal(fs.readFileSync(statusPath, 'utf8'), before);
  } finally { mocked.mock.restore(); }
  f.helper.tick();
  assert.equal(f.native.status().commandId, 'disconnect-once');
  assert.equal(f.native.status().paused, true);
  assert.equal(f.starts(), 1); assert.equal(f.closes(), 1);
});

test('unknown actions and an unobservable disconnect never start a helper or claim success', async t => {
  const f = fixture(t);
  await assert.rejects(f.native.command('erase'), /Unknown Chrome action/);
  fs.unlinkSync(path.join(f.directory, 'native-chrome-control-status.json'));
  await assert.rejects(f.native.command('disconnect'), /cannot be confirmed/);
  assert.equal(f.starts(), 0);
});
