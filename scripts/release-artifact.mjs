import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertEmptyTemplate } from './build-template.mjs';

const STATIC_CONFIG = new Set(['defaults.json', 'normalization.json', 'local-vision.json', 'local-vision-q6-benchmark.json', 'schema-manifest.json', 'template.db']);
const SUPPORT_SCRIPTS = new Set(['init-db.mjs', 'schema-sync.mjs', 'setup-local-vision.ps1', 'setup-local-vision-q6.ps1', 'hardware-report.mjs', 'relocate_sqlite_paths.py']);
const ROOT_GUIDES = ['READ ME FIRST - Setup.md', 'Setup Black Cat Agent.cmd', 'BETA-TEN-ITEMS.md', 'BETA-TEN-LABELS.html', 'Setup Optional Local AI.cmd'];
const APP_FOLDERS = new Set(['electron', 'extensions', '.next', 'build', 'node_modules', 'prisma', 'config', 'scripts', 'worker', 'public']);
const APP_FILES = new Set(['package.json', 'next.config.mjs', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'CHANGELOG.md', 'SETUP_FRIENDS.md', 'BETA-TEN-ITEMS.md']);

function pathSpellings(value) {
  return [...new Set([value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')])];
}

export function isNextModuleIdentifier(relative, text, offset, rootLength) {
  if (!/^resources\/app\/\.next\/server\/.*\.js$/i.test(relative)) return false;
  const quote = text[offset - 1];
  if (quote !== '"' && quote !== "'") return false;
  const end = text.indexOf(quote, offset + rootLength);
  if (end < 0) return false;
  const suffix = text.slice(offset + rootLength, end).replaceAll('\\\\', '\\').replaceAll('\\', '/');
  return /^\/(?:src|node_modules)\/[^"'\r\n<>]*\.(?:[cm]?js|jsx|tsx?|css)(?:\?[^"'\r\n<>]*)?$/i.test(suffix) &&
    !suffix.split('/').includes('..');
}

function decodedRootOccurrences(json, sourceRoot) {
  const needle = sourceRoot.toLowerCase();
  return [...json.matchAll(/"(?:\\.|[^"\\])*"/g)].reduce((count, match) =>
    count + JSON.parse(match[0]).toLowerCase().split(needle).length - 1, 0);
}

function projectNextCssEntries(relative, original, sourceRoot) {
  if (!/^resources\/app\/\.next\/server\/app\/.*_client-reference-manifest\.js$/.test(relative)) return null;
  const input = original.trim();
  const prefix = /^globalThis\.__RSC_MANIFEST=\(globalThis\.__RSC_MANIFEST\|\|\{\}\);globalThis\.__RSC_MANIFEST\[("(?:\\.|[^"\\])*")\]=/.exec(input);
  if (!prefix) return null;
  const route = JSON.parse(prefix[1]), exactRoot = path.resolve(sourceRoot);
  if (!route.startsWith('/') || route.includes('\\') || route.toLowerCase().includes(exactRoot.toLowerCase())) return null;
  const payload = input.slice(prefix[0].length).replace(/;$/, ''), metadata = JSON.parse(payload);
  const normalizedOriginal = JSON.stringify(metadata);
  const entries = metadata?.entryCSSFiles;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  let count = 0;
  for (const [key, records] of Object.entries(entries)) {
    if (!key.startsWith(exactRoot)) continue;
    const suffix = key.slice(exactRoot.length).replaceAll('\\', '/');
    const knownEntry = suffix === '/src/' || /^\/src\/app\/(?:[^/\r\n]+\/)*(?:layout|page|route)$/.test(suffix);
    if (!knownEntry || suffix.split('/').some(part => part === '..' || part === '.' || part === '.env') ||
        !Array.isArray(records) || records.some(record => !record || typeof record !== 'object' || Array.isArray(record) ||
          Object.keys(record).some(name => !['inlined', 'path'].includes(name)) || record.inlined !== false ||
          typeof record.path !== 'string' || !/^static\/css\/[A-Za-z0-9/_-]+\.css$/.test(record.path))) continue;
    delete entries[key];
    entries[`[recognized Next CSS entry ${++count}]`] = records;
  }
  const projected = JSON.stringify(metadata);
  if (decodedRootOccurrences(payload, exactRoot) !== decodedRootOccurrences(projected, exactRoot) + count) {
    throw Error(`Release has ambiguous duplicate CSS-entry metadata: ${relative}`);
  }
  return { projected, count, normalizedOriginal };
}

function projectPrismaGeneratorMetadata(relative, original, sourceRoot) {
  if (!/^resources\/app\/node_modules\/\.prisma\/client\/(?:edge|index|wasm)\.js$/.test(relative)) return null;
  const declarations = [...original.matchAll(/^const config = (?=\{)/gm)];
  if (declarations.length !== 1) return null;
  const start = declarations[0].index + declarations[0][0].length;
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let offset = start; offset < original.length; offset++) {
    const char = original[offset];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = offset + 1; break; }
  }
  if (end < 0) return null;
  const payload = original.slice(start, end), config = JSON.parse(payload);
  if (config?.generator?.provider?.value !== 'prisma-client-js') return null;
  const normalizedOriginal = JSON.stringify(config), exactRoot = path.resolve(sourceRoot), keys = [];
  const expectedOutput = path.join(exactRoot, 'node_modules', '@prisma', 'client');
  const expectedSchema = path.join(exactRoot, 'prisma', 'schema.prisma');
  if (config.generator.output && typeof config.generator.output === 'object' && !Array.isArray(config.generator.output) &&
      config.generator.output.value === expectedOutput && config.generator.output.fromEnvVar === null) {
    config.generator.output.value = '[recognized Prisma generator output]'; keys.push('generator.output.value');
  }
  if (config.generator.sourceFilePath === expectedSchema) {
    config.generator.sourceFilePath = '[recognized Prisma generator schema]'; keys.push('generator.sourceFilePath');
  }
  const projectedConfig = JSON.stringify(config);
  if (decodedRootOccurrences(payload, exactRoot) !== decodedRootOccurrences(projectedConfig, exactRoot) + keys.length) {
    throw Error(`Release has ambiguous duplicate Prisma-generator metadata: ${relative}`);
  }
  return { projected: original.slice(0, start) + projectedConfig + original.slice(end), keys, normalizedOriginal };
}

export function inspectReleaseText(relative, original, { sourceRoot, forbiddenText = [] } = {}) {
  const privateRoots = [...forbiddenText, os.homedir()]
    .filter(value => typeof value === 'string' && value.length > 3).flatMap(pathSpellings);
  const originalLower = original.toLowerCase();
  const assertNoPrivatePath = text => {
    if (privateRoots.some(value => text.toLowerCase().includes(value.toLowerCase()))) throw Error(`Release embeds a developer machine path: ${relative}`);
  };
  assertNoPrivatePath(originalLower);
  let text = originalLower;
  const metadataKeys = [];
  let cssEntryIdentifiers = 0;
  let prismaKeys = [];
  if (sourceRoot && relative === 'resources/app/.next/required-server-files.json') {
    const exactRoot = path.resolve(sourceRoot), metadata = JSON.parse(original);
    assertNoPrivatePath(JSON.stringify(metadata));
    for (const keys of [['appDir'], ['config', 'outputFileTracingRoot'], ['config', 'turbopack', 'root']]) {
      let parent = metadata;
      for (const key of keys.slice(0, -1)) {
        parent = parent && typeof parent === 'object' && !Array.isArray(parent) && Object.hasOwn(parent, key) ? parent[key] : null;
      }
      const key = keys.at(-1);
      if (parent && typeof parent === 'object' && !Array.isArray(parent) && Object.hasOwn(parent, key) && parent[key] === exactRoot) {
        parent[key] = '[recognized Next build root]';
        metadataKeys.push(keys.join('.'));
      }
    }
    // Scan a projection in memory only; never change the compiled artifact.
    const projected = JSON.stringify(metadata);
    if (decodedRootOccurrences(original, exactRoot) !== decodedRootOccurrences(projected, exactRoot) + metadataKeys.length) {
      throw Error(`Release has ambiguous duplicate build-root metadata: ${relative}`);
    }
    text = projected.toLowerCase();
  }
  if (sourceRoot) {
    const cssEntries = projectNextCssEntries(relative, original, sourceRoot);
    if (cssEntries) {
      assertNoPrivatePath(cssEntries.normalizedOriginal);
      text = cssEntries.projected.toLowerCase(); cssEntryIdentifiers = cssEntries.count;
    }
    const prismaMetadata = projectPrismaGeneratorMetadata(relative, original, sourceRoot);
    if (prismaMetadata) {
      assertNoPrivatePath(prismaMetadata.normalizedOriginal);
      text = prismaMetadata.projected.toLowerCase(); prismaKeys = prismaMetadata.keys;
    }
  }
  let moduleIdentifiers = 0;
  for (const sourcePath of sourceRoot ? pathSpellings(path.resolve(sourceRoot)) : []) {
    let offset = text.indexOf(sourcePath.toLowerCase());
    while (offset >= 0) {
      if (!isNextModuleIdentifier(relative, text, offset, sourcePath.length)) throw Error(`Release embeds a developer machine path outside a Next module identifier: ${relative}`);
      moduleIdentifiers++;
      offset = text.indexOf(sourcePath.toLowerCase(), offset + sourcePath.length);
    }
  }
  return { moduleIdentifiers, metadataKeys, cssEntryIdentifiers, prismaKeys };
}

export function privacyIssue(relative) {
  const name = relative.replaceAll('\\', '/');
  const lower = name.toLowerCase();
  const basename = path.posix.basename(lower);
  if (/(?:^|\/)(?:\.git|\.svn|\.hg|\.cache|__pycache__|\.pytest_cache|\.credentials|\.secrets)(?:\/|$)/i.test(name)) return 'private source or cache';
  if (/^\.env(?:\.|$)/i.test(basename) || /^(?:auth|cookies?|session|storage[-_]?state|playwright[-_]?state)\.json$/i.test(basename) || basename === 'api-key.txt') return 'credentials or browser session';
  if (/\.(?:db|sqlite|sqlite3)(?:-wal|-shm|-journal)?$/i.test(name) && lower !== 'resources/app/config/template.db') return 'private database';
  if (/\.(?:gguf|safetensors|pt|pth|pyc|log|bak|pem|key)$/i.test(name)) return 'machine artifact';
  if (/^resources\/app\/(?:data|var|\.local|src|tests)(?:\/|$)/i.test(name) || /^resources\/app\/worker\/(?:\.venv|python|tests)(?:\/|$)/i.test(name)) return 'source or runtime machine directory';
  if (/^resources\/app\/\.next\/(?:cache(?:\/|$)|trace$)/i.test(name)) return 'build cache or trace';
  if (/^resources\/app\/electron\/.*\.test\./i.test(name) || lower === 'resources/app/worker/black_cat_worker/scrub_props.py') return 'development or repair utility';
  if (lower.startsWith('resources/app/') && lower !== 'resources/app/') {
    const appRelative = name.slice('resources/app/'.length), first = appRelative.split('/')[0];
    if (!APP_FOLDERS.has(first) && !APP_FILES.has(appRelative)) return 'unapproved application source';
    if (!name.endsWith('/')) {
      if (first === 'electron' && !/\.[cm]?js$/i.test(appRelative)) return 'unapproved desktop file';
      if (first === 'worker' && !/^worker\/(?:setup\.ps1|requirements\.txt|black_cat_worker\/.*\.(?:py|[cm]?js))$/i.test(appRelative)) return 'unapproved worker file';
      if (first === 'build' && !/^build\/(?:icon\.png|tray\.png|icon\.ico)$/i.test(appRelative)) return 'unapproved build asset';
      if (first === 'public' && appRelative !== 'public/beta-labels.html') return 'unapproved public asset';
      if (first === 'prisma' && !/^prisma\/(?:schema\.prisma|migrations\/(?:migration_lock\.toml|[^/]+\/migration\.sql))$/.test(appRelative)) return 'unapproved schema asset';
      if (first === 'extensions' && !/^extensions\/marketplace-bridge\/(?:manifest\.json|README\.md|app-link\.js|[^/]+\.mjs)$/.test(appRelative)) return 'unapproved browser extension asset';
    }
  }
  if (!name.includes('/') && /\.md$/i.test(name) && !ROOT_GUIDES.includes(name)) return 'unapproved root guide';
  if (lower.startsWith('resources/app/config/') && !STATIC_CONFIG.has(name.slice('resources/app/config/'.length))) return 'unapproved configuration';
  if (lower.startsWith('resources/app/scripts/') && !SUPPORT_SCRIPTS.has(name.slice('resources/app/scripts/'.length))) return 'unapproved support script';
  return null;
}

export function sha256File(filename) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

export function verifyReleaseApp(unpackedRoot, { expectedVersion, sourceRoot, forbiddenText = [] } = {}) {
  const root = path.resolve(unpackedRoot);
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), stat = fs.lstatSync(filename);
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      if (stat.isSymbolicLink()) throw Error(`Release contains a filesystem link: ${relative}`);
      if (entry.isDirectory()) {
        // Directory checks use a trailing separator; static config/script policies apply to files.
        const issue = privacyIssue(relative + '/');
        if (issue && !['unapproved configuration', 'unapproved support script'].includes(issue)) throw Error(`Release privacy check: ${issue}: ${relative}`);
        walk(filename);
      } else if (entry.isFile()) {
        const issue = privacyIssue(relative);
        if (issue) throw Error(`Release privacy check: ${issue}: ${relative}`);
        files.push({ relative, filename, size: stat.size });
      } else throw Error(`Release contains a non-regular entry: ${relative}`);
    }
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('Release root must not be a link.');
  walk(root);
  const required = [...ROOT_GUIDES, 'resources/app/package.json', 'resources/app/next.config.mjs',
    'resources/app/build/icon.png', 'resources/app/build/tray.png', 'resources/app/.next/BUILD_ID',
    'resources/app/electron/main.js', 'resources/app/worker/setup.ps1', 'resources/app/worker/requirements.txt',
    'resources/app/worker/black_cat_worker/__init__.py', 'resources/app/worker/black_cat_worker/process.py',
    'resources/app/worker/black_cat_worker/export.py', 'resources/app/LICENSE.txt', 'resources/app/THIRD_PARTY_NOTICES.txt',
    'resources/app/public/beta-labels.html',
    'resources/app/config/template.db', 'resources/app/config/schema-manifest.json', 'resources/app/prisma/schema.prisma'];
  required.push('resources/app/node_modules/.prisma/client/query_engine-windows.dll.node');
  const names = new Set(files.map(file => file.relative));
  for (const relative of required) {
    const file = files.find(value => value.relative === relative);
    if (!file || file.size === 0) throw Error(`Release is missing required content: ${relative}`);
  }
  const app = path.join(root, 'resources/app');
  if (sha256File(path.join(root, 'BETA-TEN-LABELS.html')) !== sha256File(path.join(app, 'public/beta-labels.html'))) {
    throw Error('The root and in-app beta labels differ.');
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  if (expectedVersion && metadata.version !== expectedVersion) throw Error('Packaged version differs from the release version.');
  const executableName = 'Black Cat Reseller.exe';
  if (!names.has(executableName)) throw Error('Release is missing Black Cat Reseller.exe.');
  const schemaText = fs.readFileSync(path.join(app, 'prisma/schema.prisma'), 'utf8');
  const schema = assertEmptyTemplate(path.join(app, 'config/template.db'), { schemaText });
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'config/schema-manifest.json'), 'utf8'));
  if (manifest.tableCount !== Object.keys(schema.tables).length || !isDeepStrictEqual(manifest.tables, schema.tables) || !isDeepStrictEqual(manifest.indexes, schema.indexes)) {
    throw Error('Packaged schema manifest does not match the empty database.');
  }
  const moduleExceptionFiles = new Set();
  let moduleExceptions = 0;
  const metadataExceptions = [];
  const cssEntryExceptions = [];
  const prismaExceptions = [];
  for (const file of files) {
    if (!/\.(?:json|[cm]?js|py|ps1|cmd|md|txt|html|map)$/i.test(file.relative)) continue;
    if (file.size > 32 * 1024 * 1024) throw Error(`Release text file exceeds the privacy scan limit: ${file.relative}`);
    const inspected = inspectReleaseText(file.relative, fs.readFileSync(file.filename, 'utf8'), { sourceRoot, forbiddenText });
    if (inspected.moduleIdentifiers) { moduleExceptionFiles.add(file.relative); moduleExceptions += inspected.moduleIdentifiers; }
    if (inspected.metadataKeys.length) metadataExceptions.push({ file: file.relative, keys: inspected.metadataKeys });
    if (inspected.cssEntryIdentifiers) cssEntryExceptions.push({ file: file.relative, identifiers: inspected.cssEntryIdentifiers });
    if (inspected.prismaKeys.length) prismaExceptions.push({ file: file.relative, keys: inspected.prismaKeys });
  }
  if (sourceRoot) {
    const copies = [
      ['SETUP_FRIENDS.md', ROOT_GUIDES[0]], ['scripts/Setup Black Cat Agent.cmd', ROOT_GUIDES[1]], ['BETA-TEN-ITEMS.md', ROOT_GUIDES[2]],
      ['public/beta-labels.html', ROOT_GUIDES[3]],
      ['scripts/Setup Optional Local AI.cmd', ROOT_GUIDES[4]], ['public/beta-labels.html', 'resources/app/public/beta-labels.html'],
      ['build/icon.png', 'resources/app/build/icon.png'], ['build/tray.png', 'resources/app/build/tray.png'],
      ['prisma/schema.prisma', 'resources/app/prisma/schema.prisma'],
      ...[...STATIC_CONFIG].map(name => ['config/' + name, 'resources/app/config/' + name]),
    ];
    for (const [source, destination] of copies) {
      if (sha256File(path.join(sourceRoot, source)) !== sha256File(path.join(root, destination))) throw Error(`Release content differs from the reviewed source: ${destination}`);
    }
  }
  return { version: metadata.version, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    templateTables: Object.keys(schema.tables).length, templateRows: 0,
    buildId: fs.readFileSync(path.join(app, '.next/BUILD_ID'), 'utf8').trim(),
    buildModulePathExceptions: { files: moduleExceptionFiles.size, identifiers: moduleExceptions, scope: 'Quoted Next server module identifiers under the build source or dependencies only' },
    buildMetadataPathExceptions: metadataExceptions,
    buildCssEntryPathExceptions: cssEntryExceptions,
    buildPrismaPathExceptions: prismaExceptions,
    templateSha256: sha256File(path.join(app, 'config/template.db')) };
}

export function writeReleaseManifest(directory, { version, appId, sourceCommit, sourceDirty, lockSha256, privacy, filenames }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) throw Error('Release manifest needs a filename-safe semantic version.');
  if (appId !== 'com.blackcat.agent') throw Error('The installed application ID must remain com.blackcat.agent across updates.');
  const artifacts = filenames.map(name => {
    if (path.basename(name) !== name || !name.includes(version)) throw Error('Release artifacts must have versioned filenames in the release folder.');
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw Error(`Release artifact is invalid: ${name}`);
    return { name, bytes: stat.size, sha256: sha256File(filename) };
  });
  const manifest = { schemaVersion: 1, appId, productName: 'Black Cat Reseller', version, platform: 'win32', arch: 'x64',
    generatedAt: new Date().toISOString(), sourceCommit, sourceDirty: !!sourceDirty, packageLockSha256: lockSha256,
    distribution: 'manual-download', privacy, artifacts };
  const filename = `BlackCatReseller-v${version}-release-manifest.json`;
  fs.writeFileSync(path.join(directory, filename), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const sums = [...artifacts, { name: filename, sha256: sha256File(path.join(directory, filename)) }]
    .map(value => `${value.sha256}  ${value.name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums, { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node scripts/release-artifact.mjs <win-unpacked-folder>');
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
    console.log(JSON.stringify(verifyReleaseApp(process.argv[2], { sourceRoot, expectedVersion }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
