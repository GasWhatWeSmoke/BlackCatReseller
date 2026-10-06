import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertEmptyTemplate, buildTemplate } from './build-template.mjs';

const SCHEMA = 'datasource db {\n provider = "sqlite"\n url = env("DATABASE_URL")\n}\nmodel Item {\n id Int @id\n name String\n}\nmodel AppSettings {\n id Int @id\n data String\n}\n';
const SQL = 'CREATE TABLE Item(id INTEGER PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE AppSettings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);';

function database(file, sql = SQL) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-template-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blackcat-template-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const folder of ['config', 'prisma', 'node_modules/prisma/build', 'node_modules/@prisma/engines']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), SCHEMA);
  fs.writeFileSync(path.join(root, 'node_modules/prisma/build/index.js'), 'inert CLI');
  fs.writeFileSync(path.join(root, 'node_modules/@prisma/engines', process.platform === 'win32' ? 'schema-engine-windows.exe' : 'schema-engine-debian-openssl-3.0.x'), 'inert engine');
  const template = path.join(root, 'config/template.db'), manifest = path.join(root, 'config/schema-manifest.json');
  database(template);
  fs.writeFileSync(manifest, 'previous manifest');
  const beforeDb = fs.readFileSync(template), beforeManifest = fs.readFileSync(manifest), calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(file, process.execPath);
    assert.notEqual(options.cwd, root);
    assert.equal(path.dirname(options.cwd), path.resolve(os.tmpdir()));
    assert.equal(options.windowsHide, true);
    assert.ok(!options.shell);
    const target = options.env.DATABASE_URL.replace(/^file:/, '');
    assert.equal(path.resolve(target), path.join(options.cwd, 'template.db'));
    assert.equal(options.env.PRISMA_SCHEMA_ENGINE_BINARY.startsWith(root), true);
    if (args[1] === 'db') {
      assert.equal(fs.statSync(target).size, 0, 'Windows Prisma requires the owned empty SQLite file before db push');
      database(target);
    }
    else assert.deepEqual(args.slice(1, 3), ['migrate', 'diff']);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { root, template, manifest, beforeDb, beforeManifest, calls, run };
}

test('fresh isolated template generation checks schema and preserves the source schema', t => {
  const h = fixture(t);
  const result = buildTemplate({ root: h.root, run: h.run });
  assert.equal(result.tableCount, 2);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].args.includes('--skip-generate'));
  assert.ok(h.calls[1].args.includes('--exit-code'));
  assert.equal(fs.existsSync(h.calls[0].options.cwd), false);
  assert.equal(fs.readFileSync(path.join(h.root, 'prisma/schema.prisma'), 'utf8'), SCHEMA);
  const manifest = JSON.parse(fs.readFileSync(h.manifest, 'utf8'));
  assert.deepEqual(manifest.tables, assertEmptyTemplate(h.template, { schemaText: SCHEMA }).tables);
});

test('the installed Prisma CLI builds and compares an owned empty SQLite file', t => {
  const h = fixture(t);
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = path.join(project, 'node_modules/prisma/build/index.js');
  const engine = path.join(project, 'node_modules/@prisma/engines', process.platform === 'win32' ? 'schema-engine-windows.exe' : 'schema-engine-debian-openssl-3.0.x');
  const run = (file, args, options) => spawnSync(file, [cli, ...args.slice(1)], {
    ...options, env: { ...options.env, PRISMA_SCHEMA_ENGINE_BINARY: engine },
  });
  const result = buildTemplate({ root: h.root, run });
  assert.equal(result.tableCount, 2);
  assertEmptyTemplate(h.template, { schemaText: SCHEMA });
});

test('existing settings or historical table data prevents any generation and replacement', t => {
  const h = fixture(t);
  const db = new DatabaseSync(h.template);
  db.exec("INSERT INTO AppSettings VALUES(1,'private settings')"); db.close();
  const before = fs.readFileSync(h.template);
  assert.throws(() => buildTemplate({ root: h.root, run: h.run }), /contains data in table AppSettings/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(fs.readFileSync(h.template), before);
  assert.deepEqual(fs.readFileSync(h.manifest), h.beforeManifest);
});

test('an unchanged schema preserves the exact tracked manifest bytes on repeat builds', t => {
  const h = fixture(t);
  buildTemplate({ root: h.root, run: h.run });
  const manifest = JSON.parse(fs.readFileSync(h.manifest, 'utf8'));
  manifest._doc = 'Keep existing reviewed metadata and formatting';
  const original = Buffer.from(JSON.stringify(manifest, null, 4) + '\r\n');
  fs.writeFileSync(h.manifest, original);
  buildTemplate({ root: h.root, run: h.run });
  assert.deepEqual(fs.readFileSync(h.manifest), original);
});

test('newly generated rows and schema differences cannot replace an existing seed', t => {
  for (const mode of ['rows', 'missing-column', 'diff-error']) {
    const h = fixture(t);
    const run = (file, args, options) => {
      const result = h.run(file, args, options);
      if (args[1] === 'db' && mode !== 'diff-error') {
        const db = new DatabaseSync(options.env.DATABASE_URL.replace(/^file:/, ''));
        db.exec(mode === 'rows' ? "INSERT INTO AppSettings VALUES(1,'private')" : 'ALTER TABLE Item DROP COLUMN name');
        db.close();
      }
      return mode === 'diff-error' && args[1] === 'migrate' ? { status: 2 } : result;
    };
    assert.throws(() => buildTemplate({ root: h.root, run }), /contains data|schema differs|Prisma migrate diff failed/);
    assert.deepEqual(fs.readFileSync(h.template), h.beforeDb);
    assert.deepEqual(fs.readFileSync(h.manifest), h.beforeManifest);
  }
});

test('failed paired replacement restores both existing template artifacts', t => {
  const h = fixture(t);
  let copies = 0;
  const replaceFile = (from, to) => {
    copies++;
    if (copies === 2) throw Error('injected manifest replacement failure');
    fs.copyFileSync(from, to);
  };
  assert.throws(() => buildTemplate({ root: h.root, run: h.run, replaceFile }), /injected manifest/);
  assert.deepEqual(fs.readFileSync(h.template), h.beforeDb);
  assert.deepEqual(fs.readFileSync(h.manifest), h.beforeManifest);
});

test('concurrent writes are preserved and stop replacement after generation', t => {
  const h = fixture(t);
  const run = (file, args, options) => {
    const result = h.run(file, args, options);
    if (args[1] === 'migrate') {
      const db = new DatabaseSync(h.template);
      db.exec("INSERT INTO AppSettings VALUES(1,'new data')"); db.close();
    }
    return result;
  };
  assert.throws(() => buildTemplate({ root: h.root, run }), /contains data/);
  const db = new DatabaseSync(h.template, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AppSettings').get().n, 1); db.close();
  assert.deepEqual(fs.readFileSync(h.manifest), h.beforeManifest);
});

test('every table is checked, including quoted identifiers and unknown legacy tables', t => {
  const h = fixture(t);
  const db = new DatabaseSync(h.template);
  db.exec('CREATE TABLE "legacy""private" (data TEXT); INSERT INTO "legacy""private" VALUES (\'private\')'); db.close();
  assert.throws(() => assertEmptyTemplate(h.template), /legacy"private/);
});
