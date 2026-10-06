import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { applyItemChanges } from './itemUpdate.ts';
import { archiveSelection } from './bulkArchive.ts';
import { parseManualSale, saleMoneyCents, type ManualSaleCommand } from './manualSale.ts';
import { readManualSale } from './manualSaleStore.ts';
import { loadUploadHistory, parseHistoryQuery } from './pastUploads.ts';
import { historyView } from './historyView.ts';
import { recordConfirmedSale, beginDelistAttempt } from './publish/saleProtection.ts';
import { recordOrderReview, resolveOrderReview } from './publish/orderReviews.ts';
import { computeEarnings, estimateFees } from './earnings.ts';

async function fixture(t: TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-manual-sale-'));
  const file = path.join(folder, 'test.db'); fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}?connection_limit=1` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(folder), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('blackcat-manual-sale-')); fs.rmSync(folder, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: 'MANUAL-1', status: 'Listed', itemCost: 3, listedPrice: 99, notes: 'Keep', createdAt: new Date('2026-01-01') } });
  const command: ManualSaleCommand = { operationId: randomUUID(), selection: archiveSelection(JSON.parse(JSON.stringify(item))),
    source: 'in_person', fulfillment: 'pickup', completed: false, soldAt: '2026-01-02T12:00:00.000Z', salePriceCents: 1200,
    feeCents: 0, shippingChargedCents: 0, shippingCostCents: 0, reference: 'Cash at market', sourceListing: null };
  const change = (value = command) => applyItemChanges(db, item.id, { manualSale: value });
  return { db, item, command, change };
}

test('in-person sale records actual zero costs, preserves stock details and queues every linked counterpart', async t => {
  const { db, item, command, change } = await fixture(t);
  const source = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', externalListingId: 'seller-shirt', externalUrl: 'https://www.depop.com/products/seller-shirt/', status: 'published' } });
  const unknown = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', status: 'unknown' } });
  const photo = await db.photo.create({ data: { itemId: item.id, storedPath: 'C:/fixture/photo.jpg', originalFilename: 'photo.jpg', sha256: 'original' } });
  const run = await db.publishRun.create({ data: { marketplacesJson: '["etsy"]', totalJobs: 1 } });
  const job = await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: 'etsy', status: 'queued' } });
  const result = await change(); assert.equal(result.status, 200);
  const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.status, 'Sold'); assert.equal(saved.platformSold, 'In person'); assert.equal(saved.salePrice, 12);
  for (const key of ['marketplaceFees', 'shippingCost', 'shippingCharged'] as const) assert.equal(saved[key], 0);
  assert.equal(saved.shippedAt, null); assert.equal(saved.itemCost, 3); assert.equal(saved.notes, 'Keep'); assert.equal(saved.listedPrice, 99);
  assert.deepEqual(await db.photo.findUnique({ where: { id: photo.id } }), photo);
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'cancelled');
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: source.id } })).status, 'delist_pending');
  assert.match((await db.marketplaceListing.findUniqueOrThrow({ where: { id: unknown.id } })).lastError!, /identity/);
  assert.equal(await db.problemLog.count(), 1);
  assert.equal((await readManualSale(db, saved))?.fulfillment, 'pickup');
  const page = await loadUploadHistory(db, parseHistoryQuery(new URLSearchParams('view=sales'))); historyView(page);
  assert.equal(page.items[0].manualSale?.operationId, command.operationId); assert.equal(page.counts.shipping, 1);
  const totals = computeEarnings(saved, { default: { feePercent: 80, fixedFee: 7 } }, { tiers: [], default: 20 })!;
  assert.equal(totals.netProfit, 9); assert.equal(totals.feesEstimated, false); assert.equal(totals.shippingEstimated, false);
});

test('linked marketplace manual sale preserves its identity, native replay preserves actuals and true second sales remain conflicts', async t => {
  const { db, item, command, change } = await fixture(t);
  const source = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', externalListingId: 'seller-shirt', externalUrl: 'https://www.depop.com/products/seller-shirt/', status: 'published' } });
  const other = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', externalListingId: '123456789012', externalUrl: 'https://www.ebay.com/itm/123456789012', status: 'published' } });
  command.source = 'depop'; command.fulfillment = 'shipping'; command.shippingCostCents = null; command.shippingChargedCents = 500;
  command.sourceListing = { id: source.id, updatedAt: source.updatedAt.toISOString(), externalListingId: source.externalListingId, externalUrl: source.externalUrl };
  assert.equal((await change()).status, 200);
  let saved = await db.item.findUniqueOrThrow({ where: { id: item.id } }); assert.equal(saved.shippingCost, null); assert.equal(saved.shippingEstimated, true);
  const native = { marketplace: 'depop' as const, listingId: source.externalListingId!, listingUrl: source.externalUrl!, reference: 'receipt', classification: 'confirmed_sale' as const,
    financials: { currency: 'USD' as const, salePriceCents: 9900, shippingChargedCents: 8800 } };
  assert.equal((await recordConfirmedSale(db, native)).doubleSale, false);
  saved = await db.item.findUniqueOrThrow({ where: { id: item.id } }); assert.equal(saved.salePrice, 12); assert.equal(saved.shippingCharged, 5);
  assert.equal((await recordConfirmedSale(db, { ...native, marketplace: 'ebay', listingId: other.externalListingId!, listingUrl: other.externalUrl! })).doubleSale, true);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).platformSold, 'Depop');
});

test('unlinked marketplace and off-platform shipped sales do not fabricate marketplace records', async t => {
  for (const source of ['ebay', 'etsy', 'poshmark', 'mercari', 'off_platform'] as const) await t.test(source, async t => {
    const { db, item, command, change } = await fixture(t); command.source = source; command.fulfillment = 'shipping'; command.completed = true;
    command.salePriceCents = 0; command.feeCents = 0; command.shippingCostCents = 0;
    assert.equal((await change()).status, 200); assert.equal(await db.marketplaceListing.count(), 0);
    const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } }); assert.ok(saved.shippedAt); assert.equal(saved.salePrice, 0);
    assert.equal((await readManualSale(db, saved))?.fulfillment, 'shipping');
  });
});

test('lost-response replay preserves later corrections and active removal attempts; changed payload cannot reuse receipt', async t => {
  const { db, item, command, change } = await fixture(t);
  const other = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', externalListingId: 'seller-shirt', externalUrl: 'https://www.depop.com/products/seller-shirt/', status: 'published' } });
  await change(); await beginDelistAttempt(db, other.id);
  await db.item.update({ where: { id: item.id }, data: { salePrice: 0, shippingCost: 0, shippedAt: new Date() } });
  const before = await db.item.findUniqueOrThrow({ where: { id: item.id } }), listing = await db.marketplaceListing.findUnique({ where: { id: other.id } });
  assert.equal((await change()).status, 200); assert.equal(await db.syncLog.count({ where: { field: 'manual_sale' } }), 1);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), before); assert.deepEqual(await db.marketplaceListing.findUnique({ where: { id: other.id } }), listing);
  assert.equal((await change({ ...command, salePriceCents: 1500 })).status, 409);
});

test('strict identity, item revision, listing revision, existing sales and malformed money block all writes', async t => {
  const { db, item, command, change } = await fixture(t);
  for (const patch of [{ selection: { ...command.selection, createdAt: '2020-01-01T00:00:00.000Z' } }, { selection: { ...command.selection, updatedAt: '2020-01-01T00:00:00.000Z' } },
    { selection: { ...command.selection, sku: 'OTHER' } }, { soldAt: '2999-01-01T00:00:00.000Z' }]) assert.equal((await change({ ...command, ...patch })).status, 409);
  for (const patch of [{ feeCents: null }, { feeCents: -1 }, { salePriceCents: 1.2 }, { shippingChargedCents: 1 }, { reference: '' }, { source: 'bogus' }, { extra: true }])
    assert.equal((await applyItemChanges(db, item.id, { manualSale: { ...command, ...patch } })).status, 422);
  assert.equal((await applyItemChanges(db, item.id, { manualSale: command, notes: 'changed' })).status, 422);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item); assert.equal(await db.syncLog.count(), 0);
  const source = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', status: 'published' } });
  assert.equal((await change({ ...command, source: 'depop' })).status, 409);
  assert.equal((await change({ ...command, source: 'depop', sourceListing: { id: source.id, updatedAt: '2020-01-01T00:00:00.000Z', externalUrl: null, externalListingId: null } })).status, 409);
  await change(); assert.equal((await change({ ...command, operationId: randomUUID() })).status, 409);
});

test('returned manual sales cannot replay as new sales, inherit pickup labels or accept old fulfillment views', async t => {
  const { db, item, command, change } = await fixture(t); await change();
  const first = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  const review = await recordOrderReview(db, { sku: item.sku, reason: 'Returned cash sale' });
  await resolveOrderReview(db, review!, { decision: 'return_to_review', fullRefund: true, itemReceived: true, feeLoss: 0, postageLoss: 0 });
  assert.equal((await change()).status, 200);
  let saved = await db.item.findUniqueOrThrow({ where: { id: item.id } }); assert.equal(saved.status, 'Needs Info'); assert.equal(await readManualSale(db, saved), null);
  // A second sale on the same creation identity must invalidate the old page even if shippedAt is null again.
  const second = { ...command, operationId: randomUUID(), selection: archiveSelection(JSON.parse(JSON.stringify(saved))), source: 'off_platform' as const, fulfillment: 'shipping' as const };
  assert.equal((await change(second)).status, 200);
  saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal((await readManualSale(db, saved))?.fulfillment, 'shipping');
  assert.equal((await applyItemChanges(db, item.id, { shipped: true, expectedValues: { status: 'Sold', createdAt: first.createdAt.toISOString(), shippedAt: null, updatedAt: first.updatedAt.toISOString() } })).status, 409);
  assert.equal((await applyItemChanges(db, item.id, { shipped: true, expectedValues: { status: 'Sold', createdAt: saved.createdAt.toISOString(), shippedAt: null, updatedAt: saved.updatedAt.toISOString() } })).status, 200);
});

test('transaction failure rolls back the sale, queue and ledger together', async t => {
  const { db, item, command } = await fixture(t);
  const broken = { $transaction: (run: Function) => db.$transaction(tx => run(new Proxy(tx, { get(target, key) {
    if (key === 'syncLog') return { ...target.syncLog, findMany: target.syncLog.findMany.bind(target.syncLog), create: async () => { throw Error('disk full'); } };
    return Reflect.get(target, key);
  } }))) };
  const result = await applyItemChanges(broken as never, item.id, { manualSale: command }); assert.equal(result.status, 500);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item); assert.equal(await db.syncLog.count(), 0);
});

test('money parsing retains explicit zero and rejects missing, fractional cents, exponents and nonfinite amounts', () => {
  assert.equal(saleMoneyCents('0', 'Fees'), 0); assert.equal(saleMoneyCents('12.34', 'Price'), 1234);
  for (const value of ['', ' ', '1.234', '-1', '1e2', 'Infinity', '1,000', '1000001']) assert.throws(() => saleMoneyCents(value, 'Price'));
  assert.throws(() => parseManualSale(null));
});

test('fee lookup accepts unique case/space equivalents, preserves exact keys and avoids ambiguous matches', () => {
  const model = { eBay: { feePercent: 10, fixedFee: 1 }, default: { feePercent: 50, fixedFee: 0 } };
  assert.equal(estimateFees(20, ' EBAY ', model), 3); assert.equal(estimateFees(20, 'eBay shop', model), 10);
  const duplicates = { ...model, ebay: { feePercent: 20, fixedFee: 0 } };
  assert.equal(estimateFees(20, 'eBay', duplicates), 3); assert.equal(estimateFees(20, 'ebay', duplicates), 4);
  assert.equal(estimateFees(20, ' EBAY ', duplicates), 10);
});
