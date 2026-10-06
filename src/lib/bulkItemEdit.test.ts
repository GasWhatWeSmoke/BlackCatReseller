import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyItemChanges } from './itemUpdate.ts';
import { bulkEditReceiptMatches, bulkEditSelection, editSelectedItems, parseBulkEditChanges, type BulkEditSelection } from './bulkItemEdit.ts';
import { createQueuedRun } from './publish/createQueuedRun.ts';

async function fixture(t: TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-bulk-edit-'));
  fs.copyFileSync('config/template.db', path.join(folder, 'fixture.db'));
  const db = new PrismaClient({ datasources: { db: { url: `file:${path.join(folder, 'fixture.db').replaceAll('\\', '/')}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(folder), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('blackcat-bulk-edit-')); fs.rmSync(folder, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: 'BULK-001', status: 'Ready', brand: 'Before', weightOz: 8, listedPrice: 25,
    readyFolderPath: folder, evidenceJson: JSON.stringify({ brand: { value: 'Before', status: 'inferred' } }) } });
  const selection = bulkEditSelection(JSON.parse(JSON.stringify(item)));
  const edit = (changes: object, selected = selection) => applyItemChanges(db, selected.id, { ...changes, bulkEdit: selected });
  return { db, folder, item, selection, edit };
}

test('bulk edits revoke approval and prepared output atomically while preserving photos and evidence', async t => {
  const { db, folder, item, selection, edit } = await fixture(t);
  const photo = path.join(folder, 'original.jpg'); fs.writeFileSync(photo, 'owned original');
  await db.photo.create({ data: { itemId: item.id, originalFilename: 'original.jpg', storedPath: photo, sha256: 'fixture' } });
  const result = await edit({ brand: 'Corrected', size: '', weightOz: 16, itemCost: 0 }); assert.equal(result.status, 200);
  const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.status, 'Photographed'); assert.equal(saved.readyFolderPath, null); assert.equal(saved.brand, 'Corrected');
  assert.equal(saved.size, null); assert.equal(saved.weightOz, 16); assert.equal(saved.itemCost, 0);
  assert.ok(saved.updatedAt > item.updatedAt); assert.equal(JSON.parse(saved.evidenceJson!).brand.previous.value, 'Before');
  assert.equal(await db.photo.count(), 1); assert.equal(fs.readFileSync(photo, 'utf8'), 'owned original');
  assert.equal(bulkEditReceiptMatches(JSON.parse(JSON.stringify(result.body)), selection, { brand: 'Corrected', size: '', weightOz: 16, itemCost: 0 }), true);
  assert.equal((await createQueuedRun(db, [item.id], ['ebay'])).ok, false);
  assert.equal(await db.publishJob.count(), 0);
  assert.equal((await edit({ brand: 'Old selection' })).status, 409);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), saved);
});

test('bulk selection refuses stale or replaced inventory identities before changing any field', async t => {
  const { db, item, edit } = await fixture(t);
  const changed = await db.item.update({ where: { id: item.id }, data: { notes: 'Newer', updatedAt: new Date(item.updatedAt.getTime() + 1000) } });
  assert.equal((await edit({ listedPrice: 1 })).status, 409);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), changed);
  await db.item.delete({ where: { id: item.id } });
  const replacement = await db.item.create({ data: { id: item.id, sku: item.sku, status: 'Ready', createdAt: new Date(item.createdAt.getTime() + 1000), updatedAt: item.updatedAt } });
  assert.equal((await edit({ listedPrice: 1 })).status, 409);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), replacement);
});

test('bulk changes cannot alter sold, archived, legacy-listed, live or uncertain items', async t => {
  const { db, item } = await fixture(t);
  for (const patch of [{ status: 'Sold' }, { status: 'Archived' }, { status: 'Removed' }, { salePrice: 0 },
    { niftyStatus: 'Uploading' }, { niftyStatus: 'Draft' }, { niftyStatus: 'Published' }]) {
    const row = await db.item.update({ where: { id: item.id }, data: { status: 'Ready', salePrice: null, niftyStatus: 'Not Uploaded', ...patch } });
    const result = await applyItemChanges(db, item.id, { brand: 'Must not change', bulkEdit: bulkEditSelection(JSON.parse(JSON.stringify(row))) });
    assert.equal(result.status, 422, JSON.stringify(patch)); assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), row);
  }
  const row = await db.item.update({ where: { id: item.id }, data: { status: 'Ready', salePrice: null, niftyStatus: 'Not Uploaded' } });
  for (const status of ['published', 'sold', 'unknown', 'publishing', 'delist_pending', 'delisting', 'delist_unknown', 'delist_failed']) {
    const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', status } });
    assert.equal((await applyItemChanges(db, item.id, { brand: 'Must not change', bulkEdit: bulkEditSelection(JSON.parse(JSON.stringify(row))) })).status, 422, status);
    assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), row);
    await db.marketplaceListing.delete({ where: { id: listing.id } });
  }
});

test('queued, retrying and publishing work prevents bulk edits even when inventory summary still says Ready', async t => {
  const { db, item, edit } = await fixture(t);
  const run = await db.publishRun.create({ data: { marketplacesJson: '["ebay"]' } });
  const job = await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: 'ebay' } });
  for (const status of ['queued', 'retrying', 'publishing']) {
    await db.publishJob.update({ where: { id: job.id }, data: { status } });
    assert.equal((await edit({ listedPrice: 1 })).status, 422, status);
    assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), item);
  }
  await db.publishJob.update({ where: { id: job.id }, data: { status: 'cancelled' } });
  assert.equal((await edit({ listedPrice: 1 })).status, 200);
});

test('failed bulk writes roll back values, approval and prepared-output ownership together', async t => {
  const { db, item, edit } = await fixture(t);
  await db.$executeRawUnsafe("CREATE TRIGGER fixture_bulk_stop BEFORE UPDATE ON Item BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.equal((await edit({ brand: 'Changed', weightOz: 16 })).status, 500);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), item);
});

test('bulk input rejects extra fields, invalid money/weight and missing confirmation before mutation', async t => {
  const { db, item, selection, edit } = await fixture(t);
  for (const changes of [{}, { status: 'Ready' }, { sku: 'RENAME' }, { salePrice: 5 }, { expectedValues: {} },
    { weightOz: 0 }, { weightOz: 1.5 }, { itemCost: -1 }, { listedPrice: 'NaN' }, { brand: null }, { notes: 'x'.repeat(2001) }]) {
    assert.equal((await edit(changes)).status, 422, JSON.stringify(changes));
    assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), item);
  }
  assert.equal((await applyItemChanges(db, item.id, { brand: 'Changed', bulkEdit: { id: item.id } })).status, 422);
  assert.equal((await applyItemChanges(db, item.id, { brand: 'Changed', bulkEdit: { ...selection, id: item.id + 1 } })).status, 422);
  assert.deepEqual(parseBulkEditChanges({ weightOz: '', itemCost: '0', brand: ' Changed ' }), { weightOz: null, itemCost: 0, brand: 'Changed' });
});

const selected = (id: number): BulkEditSelection => ({ id, sku: String(id), createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
test('100-item bulk coordinator records individual blocks and never replays an unknown write', async () => {
  const calls: number[] = []; const selection = Array.from({ length: 100 }, (_, i) => selected(i + 1));
  const results = await editSelectedItems(selection, { weightOz: 16 }, async item => {
    calls.push(item.id); if (item.id === 4) throw Error('Lost reply');
    return { kind: item.id === 2 ? 'blocked' : 'saved', message: 'Fixture' };
  }, { stopped: () => false, progress: () => {} });
  assert.deepEqual(calls, [1, 2, 3, 4]); assert.deepEqual(results.map(row => row.kind), ['saved', 'blocked', 'saved', 'unknown']);
  const all = await editSelectedItems(selection, { itemCost: 0 }, async () => ({ kind: 'saved', message: 'Saved' }), { stopped: () => false, progress: () => {} });
  assert.equal(all.length, 100);
});

test('stop, invalid complete selections and failed result storage prevent later writes', async () => {
  let calls = 0, stopped = false;
  const edit = async () => { calls++; return { kind: 'saved' as const, message: 'Saved' }; };
  const results = await editSelectedItems([selected(1), selected(2)], { brand: 'Changed' }, edit, { stopped: () => stopped, progress: () => { stopped = true; } });
  assert.equal(results.length, 1); assert.equal(calls, 1);
  for (const selection of [[], [selected(1), selected(1)], [selected(1), { ...selected(2), createdAt: '' }], Array.from({ length: 101 }, (_, i) => selected(i + 1))])
    await assert.rejects(editSelectedItems(selection, { brand: 'Changed' }, edit, { stopped: () => false, progress: () => {} }));
  assert.equal(calls, 1);
  await assert.rejects(editSelectedItems([selected(1), selected(2)], { brand: 'Changed' }, edit, { stopped: () => false, progress: () => { throw Error('Storage unavailable'); } }), /Storage unavailable/);
  assert.equal(calls, 2);
});

test('a success-looking bulk receipt must confirm identity, revision, fields and revoked approval', () => {
  const expected = selected(1); const valid = { previousUpdatedAt: expected.updatedAt, item: { ...expected, updatedAt: '2026-09-01T00:00:00.001Z', brand: 'Changed', status: 'Photographed', readyFolderPath: null } };
  assert.equal(bulkEditReceiptMatches(valid, expected, { brand: 'Changed' }), true);
  for (const patch of [{ id: 2 }, { sku: 'Other' }, { createdAt: 'Other' }, { updatedAt: expected.updatedAt }, { brand: 'Unchanged' }, { status: 'Ready' }, { readyFolderPath: 'old' }])
    assert.equal(bulkEditReceiptMatches({ ...valid, item: { ...valid.item, ...patch } }, expected, { brand: 'Changed' }), false);
  assert.equal(bulkEditReceiptMatches({ ...valid, previousUpdatedAt: 'Other' }, expected, { brand: 'Changed' }), false);
});

test('100 real inventory edits preserve blocked rows and return only successful edits to Review', async t => {
  const { db, item } = await fixture(t);
  await db.item.createMany({ data: Array.from({ length: 99 }, (_, i) => ({ sku: `BULK-${String(i + 2).padStart(3, '0')}`, status: 'Ready', listedPrice: 25 })) });
  const before = await db.item.findMany({ orderBy: { id: 'asc' } });
  const selection = before.map(row => bulkEditSelection(JSON.parse(JSON.stringify(row))));
  const run = await db.publishRun.create({ data: { marketplacesJson: '["ebay"]' } });
  await db.publishJob.create({ data: { runId: run.id, itemId: before[2].id, marketplace: 'ebay' } });
  await db.marketplaceListing.create({ data: { itemId: before[3].id, marketplace: 'depop', status: 'unknown' } });
  const newer = await db.item.update({ where: { id: before[4].id }, data: { notes: 'Newer edit', updatedAt: new Date(before[4].updatedAt.getTime() + 1000) } });
  const started = performance.now();
  const results = await editSelectedItems(selection, { brand: 'Batch correction', listedPrice: 30 }, async (row, changes) => {
    const reply = await applyItemChanges(db, row.id, { ...changes, bulkEdit: row });
    if (reply.status >= 500) return { kind: 'unknown', message: 'Unexpected save failure' };
    if (reply.status !== 200) return { kind: 'blocked', message: 'error' in reply.body ? reply.body.error : 'Blocked' };
    assert.equal(bulkEditReceiptMatches(JSON.parse(JSON.stringify(reply.body)), row, changes), true);
    return { kind: 'saved', message: 'Saved' };
  }, { stopped: () => false, progress: () => {} });
  assert.equal(results.filter(row => row.kind === 'saved').length, 97);
  assert.equal(results.filter(row => row.kind === 'blocked').length, 3);
  assert.equal(results.filter(row => row.kind === 'unknown').length, 0);
  const after = await db.item.findMany({ orderBy: { id: 'asc' } });
  for (let index = 0; index < 100; index++) {
    if ([2, 3, 4].includes(index)) assert.deepEqual(after[index], index === 4 ? newer : before[index]);
    else { assert.equal(after[index].brand, 'Batch correction'); assert.equal(after[index].listedPrice, 30); assert.equal(after[index].status, 'Photographed'); assert.equal(after[index].readyFolderPath, null); }
  }
  assert.equal(await db.publishJob.count(), 1); assert.equal(await db.marketplaceListing.count(), 1);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, 'Photographed');
  t.diagnostic(`100-item local edit: ${Math.round(performance.now() - started)}ms; 97 saved, 3 protected; no marketplace action`);
});
