import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseNames, releaseProcessConflicts, assertBuildIdle, release } from './release.mjs';

test('release filenames are versioned and reject shell/path metacharacters', () => {
  assert.deepEqual(releaseNames('1.2.3-beta.1'), { installer: 'BlackCatReseller-v1.2.3-beta.1-Setup.exe', zip: 'BlackCatReseller-v1.2.3-beta.1-win-x64.zip' });
  for (const version of ['../1.2.3', "1.2.3';whoami", '1.2.3$(whoami)', '1.2', '1.2.3/evil']) assert.throws(() => releaseNames(version), /semantic version/);
});

test('only processes using the build checkout block a release; the live sibling remains independent', () => {
  const root = path.resolve('fixtures/isolated checkout'), sibling = root + '-sibling';
  const processes = [
    { ProcessId: 1, ExecutablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), CommandLine: 'electron .' },
    { ProcessId: 2, ExecutablePath: 'C:\\Node\\node.exe', CommandLine: `node "${path.join(root, 'node_modules/next/dist/bin/next')}" start` },
    { ProcessId: 3, ExecutablePath: path.join(sibling, 'node_modules/electron/dist/electron.exe'), CommandLine: 'electron .' },
    { ProcessId: 4, ExecutablePath: 'C:\\Node\\node.exe', CommandLine: `node "${path.join(sibling, 'server.js')}"` },
    { ProcessId: 5, ExecutablePath: 'C:\\Node\\node.exe', CommandLine: `node "${path.join(root, 'scripts/release.mjs')}"` },
  ];
  assert.deepEqual(releaseProcessConflicts(root, processes, 5), [1, 2]);
});

test('release guard checks inspection and native-engine locks without global port ownership', () => {
  const calls = [], root = path.resolve('fixture-release');
  const run = (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout: '[]' }; };
  assert.doesNotThrow(() => assertBuildIdle(root, run));
  assert.equal(calls.length, 2);
  assert.equal(calls.some(call => call.args.join(' ').includes('41999')), false);
  assert.equal(calls[1].options.env.BLACKCAT_RELEASE_ROOT, root);
  assert.ok(calls.every(call => call.options.windowsHide === true && !call.options.shell));
  assert.throws(() => assertBuildIdle(root, () => ({ status: 1 })), /Cannot inspect/);
  let call = 0;
  assert.throws(() => assertBuildIdle(root, () => ++call === 1 ? { status: 0, stdout: '[]' } : { status: 1 }), /locked or unwritable/);
});

test('release orchestration builds only with isolated preview data and never publishes or installs', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-release-test-space '$-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-release-test-space '$-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const version = '1.2.3-beta.1';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version, build: { appId: 'com.blackcat.agent' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'inert lock');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `## [${version}]\nLocal beta\n`);
  const templatePath = path.join(root, 'inert-template.db'); fs.writeFileSync(templatePath, 'inert template');
  const calls = [], guards = [], privacy = { templateRows: 0, templateTables: 2, buildId: 'fixture' };
  let output;
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.windowsHide, true);
    assert.ok(!options.shell);
    assert.equal(options.env.BLACKCAT_PREVIEW, '1');
    const buildDb = options.env.DATABASE_URL.replace(/^file:/, '');
    assert.equal(fs.readFileSync(buildDb, 'utf8'), 'inert template');
    assert.ok(!path.resolve(buildDb).startsWith(root));
    if (args[0]?.endsWith('electron-builder\\cli.js')) {
      assert.deepEqual(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 2), ['--publish', 'never']);
      assert.ok(args.includes('nsis'));
      output = args.find(arg => arg.startsWith('-c.directories.output=')).slice('-c.directories.output='.length);
      fs.mkdirSync(path.join(output, 'win-unpacked'));
      fs.writeFileSync(path.join(output, releaseNames(version).installer), 'inert installer');
    }
    if (file === 'powershell.exe') {
      assert.ok(args.at(-1).includes('CreateFromDirectory'));
      assert.ok(!args.at(-1).includes(root));
      fs.writeFileSync(options.env.BLACKCAT_RELEASE_ZIP, 'inert zip');
    }
    return { status: 0, stdout: file === 'git' && args[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : '' };
  };
  const result = release({ root, run, buildSeed: () => ({ templatePath }), guard: ownedRoot => guards.push(ownedRoot),
    verifyApp: (directory, options) => { assert.equal(directory, path.join(output, 'win-unpacked')); assert.equal(options.sourceRoot, root); return privacy; } });
  assert.equal(guards.length, 3);
  assert.equal(path.dirname(result.directory), path.join(root, 'dist'));
  assert.equal(result.manifest.distribution, 'manual-download');
  assert.equal(result.manifest.appId, 'com.blackcat.agent');
  assert.equal(result.manifest.artifacts.length, 2);
  assert.equal(fs.existsSync(calls[0].options.env.DATABASE_URL.replace(/^file:/, '')), false);
  assert.equal(calls.some(call => /Setup\.exe$/i.test(call.file)), false);
});
