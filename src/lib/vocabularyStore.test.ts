import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { readVocabulary, saveVocabularyEntry } from './vocabularyStore.ts';
import { vocabularyEntry, vocabularyView, vocabularyValues, learnedVocabulary } from './vocabulary.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-vocabulary-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-vocabulary-')); fs.rmSync(root, { recursive: true, force: true }); });
  await db.vocabulary.deleteMany(); return db;
}
test('suggestion reads preserve stored order and safely include prototype-like type names', async t => {
  const db = await fixture(t);
  await db.vocabulary.createMany({ data: [{ type: 'brand', value: 'Second', sortOrder: 9 }, { type: 'brand', value: 'First', sortOrder: 2 }, { type: '__proto__', value: 'Kept', sortOrder: 0 }, { type: 'constructor', value: 'Also kept', sortOrder: 0 }] });
  const result = vocabularyView(JSON.parse(JSON.stringify(await readVocabulary(db))));
  assert.deepEqual(result.vocab.brand, ['First', 'Second']); assert.deepEqual(result.vocab.__proto__, ['Kept']); assert.deepEqual(vocabularyValues({}, '__proto__'), []);
  assert.deepEqual(vocabularyValues(result.vocab, 'constructor'), ['Also kept']); assert.equal(await db.vocabulary.count(), 4);
});
test('suggestion updates are idempotent, append after the highest existing order and identify their receipt', async t => {
  const db = await fixture(t); await db.vocabulary.create({ data: { type: 'brand', value: 'Existing', sortOrder: 50 } });
  const request = vocabularyEntry({ type: 'brand', value: ' New Brand ' });
  const saved = await saveVocabularyEntry(db, request); learnedVocabulary(saved, request); assert.equal(saved.row.sortOrder, 51);
  const again = await saveVocabularyEntry(db, request); assert.equal(again.row.id, saved.row.id); assert.equal(await db.vocabulary.count(), 2);
  assert.throws(() => learnedVocabulary({ ok: true }, request)); assert.throws(() => learnedVocabulary({ ...saved, row: { ...saved.row, value: 'Wrong' } }, request));
  const before = await db.vocabulary.findMany(); await readVocabulary(db); assert.deepEqual(await db.vocabulary.findMany(), before);
});
test('invalid suggestions are rejected before writes and unavailable reads cannot look like an empty dictionary', async t => {
  const db = await fixture(t);
  for (const input of [null, {}, { type: 'brand', value: 1 }, { type: ' ', value: 'X' }, { type: 'brand', value: '' }, { type: 'brand', value: 'x'.repeat(513) }, { type: 'brand', value: 'x\0y' }]) await assert.rejects(saveVocabularyEntry(db, input));
  assert.equal(await db.vocabulary.count(), 0);
  await assert.rejects(readVocabulary({ vocabulary: { findMany: async () => { throw Error('Fixture read unavailable'); } } } as never), /unavailable/);
  for (const input of [null, {}, { vocab: [] }, { vocab: { brand: null } }, { vocab: { brand: [1] } }]) assert.throws(() => vocabularyView(input));
  assert.deepEqual(vocabularyView({ vocab: {} }), { vocab: {} });
});
test('failed suggestion insertion preserves existing values and ordering', async t => {
  const db = await fixture(t); await db.vocabulary.create({ data: { type: 'brand', value: 'Existing', sortOrder: 3 } });
  await db.$executeRawUnsafe("CREATE TRIGGER fixture_stop_vocab BEFORE INSERT ON Vocabulary BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  await assert.rejects(saveVocabularyEntry(db, { type: 'brand', value: 'New' }));
  const rows = await db.vocabulary.findMany(); assert.equal(rows.length, 1); assert.equal(rows[0].sortOrder, 3); assert.equal(rows[0].value, 'Existing');
});
