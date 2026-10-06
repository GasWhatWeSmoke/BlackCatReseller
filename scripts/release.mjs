// Local Windows release: isolated build data, verified installer + portable ZIP.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTemplate } from './build-template.mjs';
import { verifyReleaseApp, writeReleaseManifest, sha256File } from './release-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function releaseNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) throw Error('Release needs a filename-safe semantic version.');
  return { installer: `BlackCatReseller-v${version}-Setup.exe`, zip: `BlackCatReseller-v${version}-win-x64.zip` };
}

export function releaseProcessConflicts(root, processes, ownPid = process.pid) {
  const normalized = path.resolve(root).replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  const prefix = normalized + '\\';
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactArgument = new RegExp(`(?:^|[\\s"'])${escaped}(?:[\\\\\\s"']|$)`, 'i');
  return processes.filter(value => {
    if (value.ProcessId === ownPid) return false;
    const executable = String(value.ExecutablePath || '').replaceAll('/', '\\').toLowerCase();
    const command = String(value.CommandLine || '').replaceAll('/', '\\');
    return executable.startsWith(prefix) || exactArgument.test(command);
  }).map(value => value.ProcessId);
}

export function assertBuildIdle(root, run = spawnSync) {
  for (const folder of ['.next', 'build', 'config']) {
    const candidate = path.join(root, folder);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw Error(`Release refuses a linked build directory: ${folder}`);
  }
  const query = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe' OR Name='llama-server.exe' OR Name='Black Cat Reseller.exe'\" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw Error('Cannot inspect release-worktree processes; no build started.');
  const parsed = JSON.parse(result.stdout || '[]'), processes = parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  if (processes.some(value => !Number.isSafeInteger(value.ProcessId) || !value.ExecutablePath && !value.CommandLine)) throw Error('A relevant process could not be identified; no build started.');
  const conflicts = releaseProcessConflicts(root, processes);
  if (conflicts.length) throw Error(`This build checkout is in use by process ${conflicts.join(', ')}. Close its app normally before building; other checkouts can remain open.`);
  const lockProbe = "$ErrorActionPreference='Stop'; $client=Join-Path $env:BLACKCAT_RELEASE_ROOT 'node_modules\\.prisma\\client'; if(Test-Path -LiteralPath $client){ foreach($file in @(Get-ChildItem -LiteralPath $client -Filter '*.dll.node' -File)){ $handle=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $handle.Dispose() } }";
  const locks = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lockProbe], {
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    env: { ...process.env, BLACKCAT_RELEASE_ROOT: path.resolve(root) },
  });
  if (locks.error || locks.status !== 0) throw Error('This checkout has a locked or unwritable Prisma engine; close its owner normally before release.');
}

export function release({ root = ROOT, run = spawnSync, buildSeed = buildTemplate, verifyApp = verifyReleaseApp, guard = assertBuildIdle } = {}) {
  if (process.platform !== 'win32') throw Error('Run this Windows release on Windows.');
  root = fs.realpathSync(root);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = metadata.version, names = releaseNames(version);
  if (metadata.build?.appId !== 'com.blackcat.agent') throw Error('Keep the existing application ID com.blackcat.agent for Windows updates.');
  if (!fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(`## [${version}]`)) throw Error(`Add the CHANGELOG.md section for ${version} before releasing.`);
  guard(root, run);
  const seed = buildSeed({ root, run });
  const dist = path.join(root, 'dist');
  if (fs.existsSync(dist) && fs.lstatSync(dist).isSymbolicLink()) throw Error('Release output must not be a linked directory.');
  fs.mkdirSync(dist, { recursive: true });
  const output = fs.mkdtempSync(path.join(dist, `release-v${version}-`));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-release-build-'));
  try {
    const database = path.join(temporary, 'build.db');
    fs.copyFileSync(seed.templatePath, database);
    const environment = { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'file:' + database.replaceAll('\\', '/'),
      BLACKCAT_DATA_ROOT: path.join(temporary, 'var'), BLACKCAT_PREVIEW: '1', NEXT_DISTDIR: '.next',
      BLACKCAT_RUNTIME_ROOT: path.join(temporary, 'runtime'), BLACKCAT_VISION_ROOT: path.join(temporary, 'runtime/vision'),
      CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NEXT_TELEMETRY_DISABLED: '1', ELECTRON_BUILDER_DISABLE_BUILD_CACHE: '1' };
    delete environment.ELECTRON_RUN_AS_NODE;
    const execute = (filename, args, extra = {}) => {
      const result = run(filename, args, { cwd: root, env: environment, windowsHide: true, stdio: 'inherit', ...extra });
      if (result.error || result.status !== 0) throw Error(`Release command failed (${result.status ?? 'launch error'}): ${path.basename(filename)} ${args[0] || ''}`);
      return result;
    };
    guard(root, run);
    for (const [script, args] of [
      ['scripts/build-icons.mjs', []],
      ['node_modules/prisma/build/index.js', ['generate', '--schema', path.join(root, 'prisma/schema.prisma')]],
      ['node_modules/next/dist/bin/next', ['build']],
    ]) execute(process.execPath, [path.join(root, script), ...args]);
    guard(root, run);
    execute(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never',
      `-c.directories.output=${output}`, `-c.artifactName=${names.installer}`]);
    const unpacked = path.join(output, 'win-unpacked');
    const privacy = verifyApp(unpacked, { expectedVersion: version, sourceRoot: root });
    const zipCommand = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:BLACKCAT_RELEASE_INPUT,$env:BLACKCAT_RELEASE_ZIP,[IO.Compression.CompressionLevel]::Optimal,$false)";
    execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', zipCommand], {
      env: { ...environment, BLACKCAT_RELEASE_INPUT: unpacked, BLACKCAT_RELEASE_ZIP: path.join(output, names.zip) },
    });
    const git = args => {
      const result = execute('git', args, { encoding: 'utf8', stdio: 'pipe' });
      return String(result.stdout || '').trim();
    };
    const manifest = writeReleaseManifest(output, { version, appId: metadata.build.appId,
      sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain']),
      lockSha256: sha256File(path.join(root, 'package-lock.json')), privacy, filenames: [names.installer, names.zip] });
    return { directory: output, manifest };
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('blackcat-release-build-')) throw Error('Unsafe release temporary cleanup path.');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = release(); console.log(`Verified local Windows release: ${result.directory}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
