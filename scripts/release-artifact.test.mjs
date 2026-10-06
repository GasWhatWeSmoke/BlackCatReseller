import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertEmptyTemplate } from './build-template.mjs';
import { privacyIssue, verifyReleaseApp, writeReleaseManifest, sha256File, isNextModuleIdentifier, inspectReleaseText } from './release-artifact.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-release-artifact-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blackcat-release-artifact-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, content = 'inert fixture') => {
    const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content);
  };
  for (const name of ['READ ME FIRST - Setup.md', 'Setup Black Cat Agent.cmd', 'BETA-TEN-ITEMS.md', 'BETA-TEN-LABELS.html', 'Setup Optional Local AI.cmd', 'Black Cat Reseller.exe',
    'resources/app/next.config.mjs', 'resources/app/build/icon.png', 'resources/app/build/tray.png', 'resources/app/.next/BUILD_ID',
    'resources/app/electron/main.js', 'resources/app/worker/setup.ps1', 'resources/app/worker/requirements.txt',
    'resources/app/worker/black_cat_worker/__main__.py', 'resources/app/worker/black_cat_worker/__init__.py',
    'resources/app/worker/black_cat_worker/process.py', 'resources/app/worker/black_cat_worker/export.py',
    'resources/app/LICENSE.txt', 'resources/app/THIRD_PARTY_NOTICES.txt', 'resources/app/public/beta-labels.html',
    'resources/app/node_modules/.prisma/client/query_engine-windows.dll.node']) write(name);
  write('resources/app/package.json', JSON.stringify({ version: '1.2.3-beta.1' }));
  write('resources/app/prisma/schema.prisma', 'model Item {\n id Int @id\n}\nmodel AppSettings {\n id Int @id\n data String\n}\n');
  fs.mkdirSync(path.join(root, 'resources/app/config'), { recursive: true });
  const template = path.join(root, 'resources/app/config/template.db');
  const db = new DatabaseSync(template); db.exec('CREATE TABLE Item(id INTEGER PRIMARY KEY); CREATE TABLE AppSettings(id INTEGER PRIMARY KEY,data TEXT)'); db.close();
  const schema = assertEmptyTemplate(template);
  write('resources/app/config/schema-manifest.json', JSON.stringify({ tableCount: 2, ...schema }));
  return { root, write, template };
}

test('a clean unpacked payload verifies root guides and runtime PNGs without a build-only ICO', t => {
  const h = fixture(t), result = verifyReleaseApp(h.root, { expectedVersion: '1.2.3-beta.1' });
  assert.equal(result.templateRows, 0);
  assert.equal(result.templateTables, 2);
  assert.equal(fs.existsSync(path.join(h.root, 'resources/app/build/icon.ico')), false);
  assert.equal(result.templateSha256, sha256File(h.template));
});

test('the optional AI launcher and both identical label copies are required', t => {
  const h = fixture(t);
  fs.unlinkSync(path.join(h.root, 'Setup Optional Local AI.cmd'));
  assert.throws(() => verifyReleaseApp(h.root), /missing required content: Setup Optional Local AI.cmd/);
  h.write('Setup Optional Local AI.cmd');
  fs.unlinkSync(path.join(h.root, 'resources/app/public/beta-labels.html'));
  assert.throws(() => verifyReleaseApp(h.root), /missing required content: resources\/app\/public\/beta-labels.html/);
  h.write('resources/app/public/beta-labels.html', 'different labels');
  assert.throws(() => verifyReleaseApp(h.root), /root and in-app beta labels differ/);
});

test('privacy policy rejects data, sessions, credentials, caches and development tools', () => {
  for (const name of ['resources/app/config/private.json', 'resources/app/config/private.db', 'resources/app/config/template.db-wal',
    'resources/app/.env', 'resources/app/worker/.env.local', 'resources/app/worker/black_cat_worker/cookies.json',
    'resources/app/electron/auth.json', 'resources/app/var/logs/server.log', 'resources/app/data/history.json',
    'resources/app/.local/vision/api-key.txt', 'resources/app/worker/.venv/Scripts/python.exe',
    'resources/app/.next/cache/build.pack', 'resources/app/node_modules/.cache/private.bin',
    'resources/app/scripts/reset.mjs', 'resources/app/worker/black_cat_worker/scrub_props.py', 'resources/app/src/local.ts',
    'resources/app/HANDOFF.md', 'HANDOFF.md', 'resources/app/worker/photos.jpg', 'resources/app/public/customer.jpg']) {
    assert.ok(privacyIssue(name), name);
  }
  for (const name of ['resources/app/config/template.db', 'resources/app/config/defaults.json',
    'resources/app/node_modules/.prisma/client/query_engine-windows.dll.node', 'resources/app/build/icon.png', 'READ ME FIRST - Setup.md']) assert.equal(privacyIssue(name), null, name);
});

test('a single settings row or stale schema manifest blocks distribution', t => {
  const h = fixture(t);
  const db = new DatabaseSync(h.template); db.exec("INSERT INTO AppSettings VALUES(1,'private')"); db.close();
  assert.throws(() => verifyReleaseApp(h.root), /contains data in table AppSettings/);
  const clean = new DatabaseSync(h.template); clean.exec('DELETE FROM AppSettings'); clean.close();
  h.write('resources/app/config/schema-manifest.json', JSON.stringify({ tableCount: 1, tables: {}, indexes: [] }));
  assert.throws(() => verifyReleaseApp(h.root), /manifest does not match/);
});

test('artifact scanning fails on extra private files and embedded developer paths without printing their contents', t => {
  const h = fixture(t);
  h.write('resources/app/worker/black_cat_worker/session.json', 'private session content');
  assert.throws(() => verifyReleaseApp(h.root), error => /credentials or browser session/.test(error.message) && !error.message.includes('private session content'));
  fs.unlinkSync(path.join(h.root, 'resources/app/worker/black_cat_worker/session.json'));
  h.write('resources/app/.next/server/chunk.js', 'const path="C:\\Users\\PrivateOwner\\AppData";');
  assert.throws(() => verifyReleaseApp(h.root, { forbiddenText: ['C:\\Users\\PrivateOwner'] }), error => /developer machine path/.test(error.message) && !error.message.includes('PrivateOwner'));
});

test('only quoted Next server module identifiers can retain a build-root path', () => {
  const root = 'E:\\Projects\\source';
  for (const suffix of ['\\src\\app\\page.tsx', '\\node_modules\\next\\dist\\client\\global-error.js', '\\src\\app\\globals.css']) {
    const text = JSON.stringify(root + suffix);
    const encoded = JSON.stringify(root).slice(1, -1);
    assert.equal(isNextModuleIdentifier('resources/app/.next/server/app/page.js', text, 1, encoded.length), true);
  }
  for (const [relative, suffix] of [
    ['resources/app/worker/local.py', '\\src\\app\\page.tsx'],
    ['resources/app/.next/server/app/page.js', '\\var\\private.json'],
    ['resources/app/.next/server/app/page.js', '\\src\\..\\private.js'],
    ['resources/app/.next/server/app/page.js', '\\src\\.env'],
    ['resources/app/.next/server/app/page.json', '\\src\\app\\page.tsx'],
  ]) {
    const text = JSON.stringify(root + suffix), encoded = JSON.stringify(root).slice(1, -1);
    assert.equal(isNextModuleIdentifier(relative, text, 1, encoded.length), false);
  }
});

test('only three exact Next required-server-files metadata values may retain the build root', () => {
  const relative = 'resources/app/.next/required-server-files.json', sourceRoot = path.resolve('fixture-build-root');
  const metadata = { appDir: sourceRoot, config: { outputFileTracingRoot: sourceRoot, turbopack: { root: sourceRoot } } };
  const original = JSON.stringify(metadata);
  assert.deepEqual(inspectReleaseText(relative, original, { sourceRoot }), {
    moduleIdentifiers: 0, metadataKeys: ['appDir', 'config.outputFileTracingRoot', 'config.turbopack.root'], cssEntryIdentifiers: 0, prismaKeys: [],
  });
  assert.equal(JSON.stringify(metadata), original);
  for (const value of [
    { ...metadata, unexpected: sourceRoot },
    { ...metadata, appDir: path.join(sourceRoot, 'private') },
    { ...metadata, config: { ...metadata.config, secret: path.join(sourceRoot, 'var/history.db') } },
    { ...metadata, config: [{ outputFileTracingRoot: sourceRoot }] },
  ]) assert.throws(() => inspectReleaseText(relative, JSON.stringify(value), { sourceRoot }), /outside a Next module identifier/);
  assert.throws(() => inspectReleaseText('resources/app/.next/other.json', original, { sourceRoot }), /outside a Next module identifier/);
  const duplicate = '{"appDir":' + JSON.stringify(path.join(sourceRoot, 'private')) + ',"appDir":' + JSON.stringify(sourceRoot) + '}';
  assert.throws(() => inspectReleaseText(relative, duplicate, { sourceRoot }), /ambiguous duplicate/);
});

test('Next metadata allowance never permits user-home or explicitly private paths', () => {
  const relative = 'resources/app/.next/required-server-files.json', sourceRoot = path.resolve('fixture-build-root');
  assert.throws(() => inspectReleaseText(relative, JSON.stringify({ appDir: os.homedir() }), { sourceRoot: os.homedir() }), /developer machine path/);
  assert.throws(() => inspectReleaseText(relative, JSON.stringify({ appDir: sourceRoot, private: path.join(os.homedir(), 'private') }), { sourceRoot }), /developer machine path/);
  assert.throws(() => inspectReleaseText(relative, JSON.stringify({ appDir: sourceRoot }), { sourceRoot, forbiddenText: [sourceRoot] }), /developer machine path/);
  const escapedHome = JSON.stringify({ appDir: sourceRoot, private: os.homedir() }).replace(/Users/g, '\\u0055sers');
  assert.throws(() => inspectReleaseText(relative, escapedHome, { sourceRoot }), /developer machine path/);
});

test('extensionless CSS entry IDs are limited to the generated manifest field and static CSS records', () => {
  const relative = 'resources/app/.next/server/app/page_client-reference-manifest.js', sourceRoot = path.resolve('fixture-build-root');
  const entry = path.join(sourceRoot, 'src/app/page');
  const wrap = value => 'globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/page"]=' + JSON.stringify(value);
  const valid = { entryCSSFiles: { [entry]: [{ inlined: false, path: 'static/css/abcdef.css' }] } };
  assert.deepEqual(inspectReleaseText(relative, wrap(valid), { sourceRoot }), { moduleIdentifiers: 0, metadataKeys: [], cssEntryIdentifiers: 1, prismaKeys: [] });
  for (const value of [
    { unexpected: { [entry]: [] } },
    { entryCSSFiles: { [path.join(sourceRoot, 'var/history')]: [] } },
    { entryCSSFiles: { [entry]: [sourceRoot] } },
    { entryCSSFiles: { [entry]: [{ inlined: false, path: 'static/css/../private.css' }] } },
    { entryCSSFiles: { [entry]: [{ inlined: true, content: sourceRoot }] } },
    { ...valid, unexpected: sourceRoot },
  ]) assert.throws(() => inspectReleaseText(relative, wrap(value), { sourceRoot }), /outside a Next module identifier/);
  assert.throws(() => inspectReleaseText('resources/app/.next/server/app/page.js', wrap(valid), { sourceRoot }), /outside a Next module identifier/);
  assert.throws(() => inspectReleaseText(relative, wrap({ ...valid, private: os.homedir() }), { sourceRoot }), /developer machine path/);
});

test('Prisma generated clients permit only their two exact build-time generator paths', () => {
  const sourceRoot = path.resolve('fixture-build-root');
  const config = { generator: { provider: { value: 'prisma-client-js' }, output: { value: path.join(sourceRoot, 'node_modules/@prisma/client'), fromEnvVar: null }, sourceFilePath: path.join(sourceRoot, 'prisma/schema.prisma') } };
  const wrap = value => 'const config = ' + JSON.stringify(value, null, 2) + '\nconfig.dirname = __dirname;\n';
  for (const name of ['edge', 'index', 'wasm']) {
    assert.deepEqual(inspectReleaseText(`resources/app/node_modules/.prisma/client/${name}.js`, wrap(config), { sourceRoot }), {
      moduleIdentifiers: 0, metadataKeys: [], cssEntryIdentifiers: 0, prismaKeys: ['generator.output.value', 'generator.sourceFilePath'],
    });
  }
  const relative = 'resources/app/node_modules/.prisma/client/index.js';
  for (const value of [
    { ...config, unexpected: sourceRoot },
    { generator: { ...config.generator, sourceFilePath: path.join(sourceRoot, 'var/history.db') } },
    { generator: { ...config.generator, output: { value: path.join(sourceRoot, 'private'), fromEnvVar: null } } },
    { generator: { ...config.generator, output: { ...config.generator.output, fromEnvVar: 'PRIVATE_OVERRIDE' } } },
  ]) assert.throws(() => inspectReleaseText(relative, wrap(value), { sourceRoot }), /outside a Next module identifier/);
  assert.throws(() => inspectReleaseText(relative, wrap(config) + 'const other=' + JSON.stringify(sourceRoot), { sourceRoot }), /outside a Next module identifier/);
  assert.throws(() => inspectReleaseText('resources/app/node_modules/.prisma/client/other.js', wrap(config), { sourceRoot }), /outside a Next module identifier/);
  assert.throws(() => inspectReleaseText(relative, wrap({ ...config, private: os.homedir() }), { sourceRoot }), /developer machine path/);
  const duplicate = wrap(config).replace('"sourceFilePath":', '"sourceFilePath":' + JSON.stringify(path.join(sourceRoot, 'private')) + ',"sourceFilePath":');
  assert.throws(() => inspectReleaseText(relative, duplicate, { sourceRoot }), /ambiguous duplicate Prisma-generator metadata/);
  const homeConfig = { generator: { ...config.generator, output: { value: path.join(os.homedir(), 'node_modules/@prisma/client'), fromEnvVar: null }, sourceFilePath: path.join(os.homedir(), 'prisma/schema.prisma') } };
  assert.throws(() => inspectReleaseText(relative, wrap(homeConfig), { sourceRoot: os.homedir() }), /developer machine path/);
});

test('missing packaged native Prisma engine cannot pass via a source-machine fallback', t => {
  const h = fixture(t);
  fs.unlinkSync(path.join(h.root, 'resources/app/node_modules/.prisma/client/query_engine-windows.dll.node'));
  assert.throws(() => verifyReleaseApp(h.root), /missing required content: resources\/app\/node_modules\/\.prisma\/client\/query_engine-windows.dll.node/);
});

test('release manifest binds stable app ID, version and every downloadable hash', t => {
  const h = fixture(t), version = '1.2.3-beta.1';
  const names = [`BlackCatReseller-v${version}-Setup.exe`, `BlackCatReseller-v${version}-win-x64.zip`];
  for (const name of names) h.write(name, 'inert release artifact ' + name);
  const options = { version, appId: 'com.blackcat.agent', sourceCommit: 'a'.repeat(40), sourceDirty: false, lockSha256: 'b'.repeat(64),
    privacy: verifyReleaseApp(h.root), filenames: names };
  const manifest = writeReleaseManifest(h.root, options);
  assert.equal(manifest.appId, 'com.blackcat.agent');
  assert.equal(manifest.sourceDirty, false);
  for (const artifact of manifest.artifacts) assert.equal(artifact.sha256, sha256File(path.join(h.root, artifact.name)));
  assert.equal(fs.readFileSync(path.join(h.root, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 3);
  assert.throws(() => writeReleaseManifest(h.root, { ...options, appId: 'other.app' }), /must remain/);
  assert.throws(() => writeReleaseManifest(h.root, { ...options, filenames: ['../outside.exe'] }), /versioned filenames/);
});
