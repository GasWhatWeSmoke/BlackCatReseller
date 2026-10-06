// Regenerate only the distributable, empty schema seed. Never use a saved DB URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(value).digest('hex');

export function assertEmptyTemplate(filename, { schemaText } = {}) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Template must be a private regular file, not a linked database.');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(filename + suffix)) throw Error('Template has SQLite companion files; close its owner before release.');
  }
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw Error('Template failed SQLite integrity validation.');
    const rows = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (!rows.length) throw Error('Template contains no schema.');
    const tables = {};
    for (const { name, sql } of rows) {
      if (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n !== 0) {
        throw Error(`Template contains data in table ${name}; refusing to replace or distribute it.`);
      }
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => ({
        name: c.name, type: c.type, notnull: c.notnull === 1, dflt: c.dflt_value == null ? null : String(c.dflt_value), pk: c.pk > 0,
      }));
      tables[name] = { sql, columns };
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").all().length) throw Error('Template contains unexpected triggers or views.');
    if (schemaText !== undefined) assertSchemaColumns(tables, schemaText);
    const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(row => ({ name: row.name, sql: row.sql }));
    return { tables, indexes };
  } finally { db.close(); }
}

export function assertSchemaColumns(tables, schemaText) {
  const blocks = [...schemaText.replaceAll('\r\n', '\n').matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  if (!blocks.length) throw Error('No Prisma models found for template verification.');
  const models = new Set(blocks.map(match => match[1]));
  const expectedTables = [];
  for (const [, model, body] of blocks) {
    const mappedTable = /@@map\("([^"]+)"\)/.exec(body)?.[1] || model;
    expectedTables.push(mappedTable);
    const expected = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (!field) throw Error(`Unsupported field in Prisma model ${model}.`);
      if (field[3] || models.has(field[2])) continue;
      expected.push(/@map\("([^"]+)"\)/.exec(line)?.[1] || field[1]);
    }
    const actual = tables[mappedTable]?.columns.map(column => column.name).sort();
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected.sort())) throw Error(`Template schema differs from Prisma model ${model}.`);
  }
  if (JSON.stringify(Object.keys(tables).sort()) !== JSON.stringify(expectedTables.sort())) throw Error('Template table set differs from the Prisma schema.');
}

function snapshot(filename) {
  if (!fs.existsSync(filename)) return null;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Generated template artifacts must be regular, unlinked files.');
  return fs.readFileSync(filename);
}

function assertUnchanged(filename, before) {
  const current = snapshot(filename);
  if ((before === null) !== (current === null) || before !== null && digest(before) !== digest(current)) {
    throw Error('Template artifacts changed during generation; refusing to overwrite them.');
  }
}

export function buildTemplate({ root = ROOT, run = spawnSync, replaceFile = fs.copyFileSync } = {}) {
  root = fs.realpathSync(root);
  const config = path.join(root, 'config');
  if (fs.lstatSync(config).isSymbolicLink()) throw Error('Template config folder must not be a link.');
  const destination = path.join(config, 'template.db');
  const manifestPath = path.join(config, 'schema-manifest.json');
  if (fs.existsSync(destination)) assertEmptyTemplate(destination);
  const beforeDb = snapshot(destination), beforeManifest = snapshot(manifestPath);
  const schemaText = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
  const prisma = path.join(root, 'node_modules/prisma/build/index.js');
  const engine = path.join(root, 'node_modules/@prisma/engines', process.platform === 'win32' ? 'schema-engine-windows.exe' : 'schema-engine-debian-openssl-3.0.x');
  if (!fs.existsSync(prisma) || !fs.existsSync(engine)) throw Error('Installed Prisma CLI/schema engine is missing; install project dependencies before generating a template.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-template-'));
  try {
    const schemaPath = path.join(temporary, 'schema.prisma'), database = path.join(temporary, 'template.db');
    fs.writeFileSync(schemaPath, schemaText);
    // The pinned Windows schema engine cannot introspect a nonexistent SQLite
    // path. Create only this exclusively owned empty file before db push.
    fs.writeFileSync(database, '', { flag: 'wx' });
    const url = 'file:' + database.replaceAll('\\', '/');
    const environment = { ...process.env, DATABASE_URL: url, PRISMA_SCHEMA_ENGINE_BINARY: engine,
      PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' };
    for (const args of [
      ['db', 'push', '--schema', schemaPath, '--skip-generate'],
      ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', schemaPath, '--exit-code'],
    ]) {
      const result = run(process.execPath, [prisma, ...args], {
        cwd: temporary, env: environment, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw Error(`Isolated Prisma ${args.slice(0, 2).join(' ')} failed (${result.status ?? 'launch error'}). ${String(result.stderr || '').slice(-1000)}`);
    }
    const schema = assertEmptyTemplate(database, { schemaText });
    const manifest = { _doc: 'Generated by scripts/build-template.mjs from the isolated empty Prisma schema seed. Runtime schema-sync performs additive reconciliation only.',
      tableCount: Object.keys(schema.tables).length, ...schema };
    const generatedManifest = path.join(temporary, 'schema-manifest.json');
    let manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n');
    if (beforeManifest) {
      try {
        const previous = JSON.parse(beforeManifest.toString('utf8'));
        if (previous.tableCount === manifest.tableCount && isDeepStrictEqual(previous.tables, schema.tables) && isDeepStrictEqual(previous.indexes, schema.indexes)) manifestBytes = beforeManifest;
      } catch { /* A malformed generated manifest is replaced only after validating the empty DB. */ }
    }
    fs.writeFileSync(generatedManifest, manifestBytes);
    if (fs.existsSync(destination)) assertEmptyTemplate(destination);
    assertUnchanged(destination, beforeDb);
    assertUnchanged(manifestPath, beforeManifest);
    try {
      replaceFile(database, destination);
      replaceFile(generatedManifest, manifestPath);
      assertEmptyTemplate(destination, { schemaText });
      if (digest(fs.readFileSync(manifestPath)) !== digest(fs.readFileSync(generatedManifest))) throw Error('Generated schema manifest did not match after replacement.');
    } catch (error) {
      for (const [filename, before] of [[destination, beforeDb], [manifestPath, beforeManifest]]) {
        if (before === null) { if (fs.existsSync(filename)) fs.unlinkSync(filename); }
        else fs.writeFileSync(filename, before);
      }
      throw error;
    }
    return { templatePath: destination, manifestPath, tableCount: manifest.tableCount };
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('blackcat-template-')) throw Error('Unsafe temporary cleanup path.');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = buildTemplate(); console.log(`Verified empty template and schema manifest: ${result.tableCount} tables.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
