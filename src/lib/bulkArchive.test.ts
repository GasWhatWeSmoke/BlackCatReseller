import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyItemChanges } from './itemUpdate.ts';
import { browserInventoryOperations } from './inventoryClient.ts';
import { archiveSelection, archiveSavedItem, archiveSelectedItems, parseArchiveReceipt, type ArchiveSelection } from './bulkArchive.ts';

const snapshot = (row: unknown) => archiveSelection(JSON.parse(JSON.stringify(row)));
async function fixture(t: TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-bulk-archive-')), file = path.join(folder, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}?connection_limit=1` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(folder), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('blackcat-bulk-archive-')); fs.rmSync(folder, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: 'ARCHIVE-1', status: 'Ready', brand: 'Saved brand', notes: 'Keep these notes', listedPrice: 25, itemCost: 6,
    readyFolderPath: path.join(folder, 'prepared'), aiFields: '[]', evidenceJson: '{"brand":{"status":"confirmed"}}' } });
  return { db, item, folder, change: (selection: ArchiveSelection, action: 'archive' | 'restore') => applyItemChanges(db, selection.id, { bulkArchive: { action, selection } }) };
}

test('archive preserves item details and original files; restore revokes readiness without approving or publishing', async t => {
  const { db, item, folder, change } = await fixture(t);
  const original = path.join(folder, 'original.jpg'); fs.writeFileSync(original, 'unchanged original bytes');
  const photo = await db.photo.create({ data: { itemId: item.id, originalFilename: 'original.jpg', storedPath: original, sha256: 'a'.repeat(64), rotation: 90 } });
  const ended = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', status: 'ended', title: 'Past listing' } });
  const selected = snapshot(item), response = await change(selected, 'archive');
  assert.equal(response.status, 200);
  const receipt = archiveSavedItem(JSON.parse(JSON.stringify(response.body)), selected, 'archive'); assert.ok(receipt);
  const archived = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(archived.status, 'Archived');
  for (const [key, value] of Object.entries(item)) if (!['status', 'updatedAt'].includes(key)) assert.deepEqual(archived[key as keyof typeof archived], value, key);
  const restoredResponse = await change(receipt, 'restore'); assert.equal(restoredResponse.status, 200);
  assert.ok(archiveSavedItem(JSON.parse(JSON.stringify(restoredResponse.body)), receipt, 'restore'));
  const restored = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(restored.status, 'Photographed'); assert.equal(restored.readyFolderPath, null);
  for (const [key, value] of Object.entries(item)) if (!['status', 'updatedAt', 'readyFolderPath'].includes(key)) assert.deepEqual(restored[key as keyof typeof restored], value, key);
  assert.deepEqual(await db.photo.findUnique({ where: { id: photo.id } }), photo);
  assert.deepEqual(await db.marketplaceListing.findUnique({ where: { id: ended.id } }), ended);
  assert.equal(fs.readFileSync(original, 'utf8'), 'unchanged original bytes'); assert.equal(await db.publishJob.count(), 0);
});

test('archive checks the confirmed revision and creation identity, including a duplicate concurrent attempt', async t => {
  const { db, item, change } = await fixture(t), selected = snapshot(item);
  const results = await Promise.all([change(selected, 'archive'), change(selected, 'archive')]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  let current = await db.item.findUniqueOrThrow({ where: { id: item.id } }); const archivedSelection = snapshot(current);
  current = await db.item.update({ where: { id: item.id }, data: { notes: 'Changed after confirmation', updatedAt: new Date(current.updatedAt.getTime() + 10) } });
  assert.equal((await change(archivedSelection, 'restore')).status, 409);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), current);
  await db.item.delete({ where: { id: item.id } });
  const replacement = await db.item.create({ data: { id: item.id, sku: item.sku, createdAt: new Date(item.createdAt.getTime() + 1000) } });
  assert.equal((await change(selected, 'archive')).status, 409);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), replacement);
});

test('restore repeats marketplace, publishing and sale-history guards rather than trusting the stored receipt', async t => {
  const { db, item, change } = await fixture(t);
  assert.equal((await change(snapshot(item), 'archive')).status, 200);
  let archived = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', status: 'unknown' } });
  assert.equal((await change(snapshot(archived), 'restore')).status, 422);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), archived);
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'ended' } });
  const run = await db.publishRun.create({ data: { status: 'running', marketplacesJson: '["ebay"]', totalJobs: 1 } });
  const job = await db.publishJob.create({ data: { itemId: item.id, runId: run.id, marketplace: 'ebay', status: 'queued' } });
  assert.equal((await change(snapshot(archived), 'restore')).status, 422);
  await db.publishJob.update({ where: { id: job.id }, data: { status: 'cancelled' } });
  for (const data of [{ niftyStatus: 'Published' }, { niftyStatus: 'Not Uploaded', salePrice: 0 }]) {
    archived = await db.item.update({ where: { id: item.id }, data });
    assert.equal((await change(snapshot(archived), 'restore')).status, 422);
    assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), archived);
  }
});

test('archive commands reject mixed edits, malformed actions, wrong IDs and sold history before mutation', async t => {
  const { db, item, change } = await fixture(t), selection = snapshot(item);
  for (const body of [{ bulkArchive: { action: 'archive', selection }, notes: 'Injected' }, { bulkArchive: { action: 'delete', selection } },
    { bulkArchive: { action: 'archive', selection: { ...selection, id: item.id + 1 } } }, { bulkArchive: { action: 'archive', selection: { ...selection, updatedAt: 'bad date' } } }]) {
    assert.equal((await applyItemChanges(db, item.id, body)).status, 422);
    assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item);
  }
  const sold = await db.item.update({ where: { id: item.id }, data: { status: 'Sold', salePrice: 0 } });
  assert.equal((await change(snapshot(sold), 'archive')).status, 422);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), sold);
});

const selected: ArchiveSelection = { id: 1, sku: 'ONE', status: 'Ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };
const saved = { ...selected, status: 'Archived', updatedAt: '2026-01-02T00:00:00.001Z' };
test('the browser confirms exact archive receipts and treats mismatched success as unknown', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let reply: unknown = { previousUpdatedAt: selected.updatedAt, item: saved }, code = 200;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, 'PATCH'); assert.ok(init.signal);
    assert.deepEqual(JSON.parse(String(init.body)), { bulkArchive: { action: 'archive', selection: selected } });
    return Response.json(reply, { status: code });
  };
  assert.equal((await browserInventoryOperations.archive!(selected, 'archive')).kind, 'saved');
  for (const item of [{ ...saved, id: 2 }, { ...saved, status: 'Ready' }, { ...saved, updatedAt: selected.updatedAt }]) {
    reply = { previousUpdatedAt: selected.updatedAt, item }; assert.equal((await browserInventoryOperations.archive!(selected, 'archive')).kind, 'unknown');
  }
  code = 409; reply = { error: 'Changed after confirmation' };
  assert.equal((await browserInventoryOperations.archive!(selected, 'archive')).kind, 'blocked');
});

test('unknown responses, operator stop and report-storage failure prevent further batch writes', async () => {
  const rows = [selected, { ...selected, id: 2, sku: 'TWO' }, { ...selected, id: 3, sku: 'THREE' }];
  let calls = 0;
  const results = await archiveSelectedItems(rows, 'archive', async item => {
    calls++; if (calls === 2) throw Error('lost response');
    return { kind: 'saved', message: 'Archived', item: { ...saved, id: item.id, sku: item.sku } };
  }, { stopped: () => false, progress: () => {} });
  assert.equal(calls, 2); assert.deepEqual(results.map(row => row.kind), ['saved', 'unknown']);
  calls = 0; let stop = false;
  await archiveSelectedItems(rows, 'archive', async item => { calls++; return { kind: 'saved', message: 'Archived', item: { ...saved, id: item.id, sku: item.sku } }; }, { stopped: () => stop, progress: () => { stop = true; } });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(archiveSelectedItems(rows, 'archive', async item => { calls++; return { kind: 'saved', message: 'Archived', item: { ...saved, id: item.id, sku: item.sku } }; }, { stopped: () => false, progress: () => { throw Error('storage full'); } }), /storage full/);
  assert.equal(calls, 1);
  await assert.rejects(archiveSelectedItems([selected, selected], 'archive', async () => { throw Error('must not run'); }, { stopped: () => false, progress: () => {} }), /distinct/);
});

test('recovered reports reject false saved results and outcomes after an unknown result', () => {
  const valid = { at: selected.updatedAt, action: 'archive', selection: [selected], results: [{ id: 1, sku: 'ONE', kind: 'saved', message: 'Archived', item: saved }], complete: true };
  assert.equal(parseArchiveReceipt(valid).results[0].item?.updatedAt, saved.updatedAt);
  assert.throws(() => parseArchiveReceipt({ ...valid, results: [{ ...valid.results[0], item: { ...saved, createdAt: saved.updatedAt } }] }));
  assert.throws(() => parseArchiveReceipt({ ...valid, selection: [selected, { ...selected, id: 2, sku: 'TWO' }], results: [
    { id: 1, sku: 'ONE', kind: 'unknown', message: 'Lost' }, { id: 2, sku: 'TWO', kind: 'blocked', message: 'Later attempt' }] }));
});
