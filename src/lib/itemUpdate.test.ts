import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyItemChanges } from './itemUpdate.ts';
import { withExpectedItemValues } from './itemEdits.ts';
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-item-update-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-item-update-')); fs.rmSync(root, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: 'EDIT-001', brand: 'Before', size: 'M', itemType: 'T-shirt', color: 'Blue', condition: 'Good', listedPrice: 25, itemCost: 5,
    evidenceJson: JSON.stringify({ brand: { value: 'Before', status: 'inferred', sources: ['fixture'] } }) } });
  const patch = (changes: Record<string, unknown>, before = item) => applyItemChanges(db, item.id, withExpectedItemValues(JSON.parse(JSON.stringify(before)), changes));
  return { db, item, patch };
}
test('item saves preserve explicit text clears, numeric normalization, actual-money flags and original evidence', async t => {
  const { db, item, patch } = await fixture(t);
  const result = await patch({ brand: 'Corrected', size: '', itemType: '', color: ' ', condition: '', keyDetails: '', weightOz: '8.6', listedPrice: '31', itemCost: '0', marketplaceFees: '0', shippingCost: '', shippingCharged: '0' });
  assert.equal(result.status, 200);
  assert.ok('previousUpdatedAt' in result.body); assert.equal(result.body.previousUpdatedAt, item.updatedAt.toISOString());
  const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.brand, 'Corrected'); assert.equal(saved.size, null); assert.equal(saved.itemType, null); assert.equal(saved.color, null); assert.equal(saved.condition, null); assert.equal(saved.keyDetails, '');
  assert.equal(saved.weightOz, 9); assert.equal(saved.listedPrice, 31); assert.equal(saved.itemCost, 0); assert.equal(saved.marketplaceFees, 0); assert.equal(saved.feesEstimated, false); assert.equal(saved.shippingCost, null); assert.equal(saved.shippingEstimated, true); assert.equal(saved.shippingCharged, 0);
  const evidence = JSON.parse(saved.evidenceJson!); assert.equal(evidence.brand.status, 'confirmed'); assert.equal(evidence.brand.previous.value, 'Before');
});
test('stale operator values reject the entire change while unrelated version changes remain editable', async t => {
  const { db, item, patch } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { brand: 'Newer', updatedAt: new Date(Date.now() + 1000) } });
  const stale = await patch({ brand: 'Old draft', notes: 'Must not save' }); assert.equal(stale.status, 409); assert.ok('code' in stale.body); assert.equal(stale.body.code, 'ITEM_EDIT_CONFLICT');
  const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } }); assert.equal(saved.brand, 'Newer'); assert.equal(saved.notes, null);
  const cost = await patch({ itemCost: 7 });
  assert.equal(cost.status, 200); assert.ok('previousUpdatedAt' in cost.body); assert.equal(cost.body.previousUpdatedAt, saved.updatedAt.toISOString());
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).brand, 'Newer');
});
test('shipping rules and sold-history protection remain enforced inside the save transaction', async t => {
  const { db, item, patch } = await fixture(t);
  assert.equal((await patch({ shipped: true })).status, 422);
  const sold = await db.item.update({ where: { id: item.id }, data: { status: 'Sold', salePrice: 30 } });
  assert.equal((await patch({ status: 'Ready' }, sold)).status, 422);
  assert.equal((await patch({ shipped: true, itemCost: -1 }, sold)).status, 422);
  assert.equal((await patch({ shipped: true }, sold)).status, 200);
  const shipped = await db.item.findUniqueOrThrow({ where: { id: item.id } }); assert.ok(shipped.shippedAt); assert.equal(shipped.salePrice, 30);
  assert.equal((await patch({ shipped: false }, sold)).status, 409);
  assert.equal((await patch({ shipped: false }, shipped)).status, 200);
});
test('duplicate SKUs, missing items and invalid edits preserve the original item', async t => {
  const { db, item, patch } = await fixture(t);
  await db.item.create({ data: { sku: 'TAKEN' } });
  assert.equal((await patch({ sku: 'TAKEN' })).status, 409);
  assert.equal((await applyItemChanges(db, -1, {})).status, 400);
  assert.equal((await applyItemChanges(db, 999999, { notes: 'Missing' })).status, 404);
  assert.equal((await applyItemChanges(db, item.id, null)).status, 422);
  assert.equal((await patch({ itemCost: 'NaN' })).status, 422);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).sku, 'EDIT-001');
});

test('invalid inventory states reject the entire edit without hiding the item or saving unrelated fields', async t => {
  const { db, item, patch } = await fixture(t);
  for (const status of ['not-a-real-inventory-state', 'Needs review', '', null, 0, {}, ['Ready']]) {
    const response = await patch({ status, notes: 'Must not save', itemCost: 99 });
    assert.equal(response.status, 422); assert.ok('error' in response.body); assert.match(response.body.error, /supported inventory status/);
    assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), item);
  }
  const sold = await db.item.update({ where: { id: item.id }, data: { status: 'Sold', salePrice: 30 } });
  assert.equal((await patch({ status: 'not-a-real-inventory-state', shipped: true, itemCost: 99 }, sold)).status, 422);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), sold);
});

test('current and historical statuses remain usable without rewriting unknown stored history', async t => {
  const { db, item } = await fixture(t);
  for (const status of ['Ready', 'Ready for Nifty', 'Uploaded to Nifty', 'Listed', 'Problem', 'Archived', 'Removed', 'Needs Info', 'Photographed']) {
    const before = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    const response = await applyItemChanges(db, item.id, withExpectedItemValues(before, { status }));
    assert.equal(response.status, 200); assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, status);
  }
  const historic = await db.item.update({ where: { id: item.id }, data: { status: 'Unknown historical status' } });
  const response = await applyItemChanges(db, item.id, withExpectedItemValues(historic, { notes: 'History retained' }));
  assert.equal(response.status, 200); const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.status, historic.status); assert.equal(saved.notes, 'History retained');
});

test('archive and removal cannot hide live or uncertain listings and preserve all item fields on rejection', async t => {
  const { db, item, patch } = await fixture(t);
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', status: 'published' } });
  for (const state of ['published', 'unknown', 'delist_pending', 'delisting', 'delist_unknown', 'delist_failed', 'sold']) {
    await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: state } });
    for (const status of ['Archived', 'Removed']) {
      const response = await patch({ status, notes: 'Must not save' });
      assert.equal(response.status, 422); assert.ok('error' in response.body); assert.match(response.body.error, /live or uncertain/);
      assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item);
      assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, state);
    }
  }
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'ended' } });
  assert.equal((await patch({ status: 'Archived' })).status, 200);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, 'ended');
});

test('archive and removal protect publishing jobs, historical activity and sale records', async t => {
  const { db, item } = await fixture(t);
  const run = await db.publishRun.create({ data: { status: 'running', marketplacesJson: '["ebay"]', totalJobs: 1 } });
  const job = await db.publishJob.create({ data: { itemId: item.id, runId: run.id, marketplace: 'ebay', status: 'queued' } });
  for (const state of ['queued', 'retrying', 'publishing']) {
    await db.publishJob.update({ where: { id: job.id }, data: { status: state } });
    for (const status of ['Archived', 'Removed']) assert.equal((await applyItemChanges(db, item.id, { status })).status, 422);
    assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item);
  }
  await db.publishJob.update({ where: { id: job.id }, data: { status: 'cancelled' } });
  for (const data of [{ niftyStatus: 'Published' }, { niftyStatus: 'Not Uploaded', salePrice: 0 }, { salePrice: 30 }, { status: 'Sold' }]) {
    const before = await db.item.update({ where: { id: item.id }, data });
    for (const status of ['Archived', 'Removed']) assert.equal((await applyItemChanges(db, item.id, { status, itemCost: 99 })).status, 422);
    assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), before);
  }
});
test('local repricing warns about live listings without changing their recorded prices', async t => {
  const { db, item, patch } = await fixture(t);
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', status: 'published', price: 25 } });
  const result = await patch({ listedPrice: 35 }); assert.equal(result.status, 200); assert.ok('priceWarning' in result.body); assert.match(result.body.priceWarning!, /saved locally/);
  assert.equal((await db.marketplaceListing.findFirstOrThrow()).price, 25);
});
test('a failed update rolls back field changes and provenance together', async t => {
  const { db, item, patch } = await fixture(t);
  await db.$executeRawUnsafe("CREATE TRIGGER fixture_stop_item BEFORE UPDATE ON Item BEGIN SELECT RAISE(ABORT, 'fixture update failure'); END");
  assert.equal((await patch({ brand: 'Changed', itemCost: 9 })).status, 500);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), item);
});

test('a stale edit cannot change a replacement item with the same ID and field values', async t => {
  const { db, item, patch } = await fixture(t);
  await db.item.delete({ where: { id: item.id } });
  const replacement = await db.item.create({ data: { id: item.id, sku: 'REPLACEMENT', brand: item.brand,
    status: item.status, listedPrice: item.listedPrice, createdAt: new Date(item.createdAt.getTime() + 60_000) } });
  const result = await patch({ brand: 'Old item correction', listedPrice: 40, notes: 'Must stay with the old identity' });
  assert.equal(result.status, 409);
  assert.ok('error' in result.body); assert.match(result.body.error, /original inventory item could not be confirmed/);
  assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), replacement);
});

test('a replaced sale cannot be shipped, renamed, repriced or flagged from its old identity', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const { db, item } = await fixture(t);
  const oldSale = await db.item.update({ where: { id: item.id }, data: { status: 'Sold', salePrice: 30 } });
  await db.item.delete({ where: { id: item.id } });
  const replacement = await db.item.create({ data: { id: item.id, sku: oldSale.sku, status: 'Sold', salePrice: 30,
    listedPrice: oldSale.listedPrice, createdAt: new Date(oldSale.createdAt.getTime() + 60_000) } });
  for (const changes of [{ shipped: true }, { sku: 'RENAMED' }, { listedPrice: 40 }, { itemCost: 8 }, { flagged: true }]) {
    const response = await applyItemChanges(db, item.id, withExpectedItemValues(oldSale, changes));
    assert.equal(response.status, 409);
    assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), replacement);
  }
  assert.equal(log.mock.callCount(), 0, 'Rejected edits must not log a successful SKU rename');
  assert.equal((await applyItemChanges(db, item.id, withExpectedItemValues(replacement, { shipped: true }))).status, 200);
  assert.ok((await db.item.findUniqueOrThrow({ where: { id: item.id } })).shippedAt);
});
