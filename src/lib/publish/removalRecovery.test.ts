import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { reviewRemoval, validRemovalReview, type RemovalReview } from './removalRecovery.ts';
import { beginDelistAttempt, finishDelistAttempt, removalBacklog } from './saleProtection.ts';
import { deleteItem } from '../itemDelete.ts';
import { itemDeleteExpectation } from '../itemDeleteSelection.ts';
import { scanAutoRunCandidates } from './autoRunScan.ts';
import { createQueuedRun } from './createQueuedRun.ts';
import type { AppSettingsData } from '../types.ts';

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-removal-review-'));
  const file = path.join(dir, 'test.db'); fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + file.replaceAll('\\', '/') } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: '000086', status: 'Sold', platformSold: 'eBay', salePrice: 20.99, itemCost: 3 } });
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', status: 'delist_failed',
    externalListingId: 'seller-belt', externalUrl: 'https://www.depop.com/products/seller-belt/', attemptCount: 4, lastError: 'Missing Edit link' } });
  const snapshot = async (): Promise<RemovalReview> => {
    const row = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id }, include: { item: true } });
    return { ...row, externalUrl: row.externalUrl!, externalListingId: row.externalListingId!, sku: row.item.sku,
      updatedAt: row.updatedAt.toISOString(), itemUpdatedAt: row.item.updatedAt.toISOString() };
  };
  const settings = { processingPath: path.join(dir, 'processing'), readyPath: path.join(dir, 'ready'),
    needsReviewPath: path.join(dir, 'review'), archivePath: path.join(dir, 'archive'), incomingPath: path.join(dir, 'incoming') };
  return { db, item, listing, snapshot, deleteOptions: { store: db, settings } };
}

test('owner-confirmed removal clears the backlog atomically with honest provenance and unchanged item history', async t => {
  const { db, item, listing, snapshot } = await fixture(t); const review = await snapshot();
  const result = await reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: review });
  assert.deepEqual(result, { ok: true, listingId: listing.id, action: 'confirm_manual_removal', status: 'ended' });
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item);
  const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.equal(saved.attemptCount, 4); assert.equal(saved.externalUrl, listing.externalUrl); assert.ok(saved.endedAt);
  assert.equal(saved.lastError, null, 'Successful manual removal must not leave an Inventory warning badge'); assert.equal((await removalBacklog(db)).length, 0);
  const audit = await db.problemLog.findFirstOrThrow(); assert.equal(audit.resolved, true);
  assert.equal(audit.type, 'MANUAL_LISTING_REMOVAL_CONFIRMED'); assert.equal(JSON.parse(audit.message!).previousError, 'Missing Edit link');
  assert.match(JSON.parse(audit.message!).note, /No automated removal verification/);
  await assert.rejects(reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: review }), /changed/);
  assert.equal(await db.problemLog.count(), 1); assert.equal(await db.publishJob.count(), 0);
});

test('reviewed retry renews the bounded attempt budget without certifying removal and preserves the previous failure in audit', async t => {
  const { db, item, listing, snapshot } = await fixture(t);
  const result = await reviewRemoval(db, { action: 'retry_removal', confirmed: true, listing: await snapshot() });
  assert.equal(result.status, 'delist_pending'); assert.equal((await removalBacklog(db)).length, 1);
  const audit = JSON.parse((await db.problemLog.findFirstOrThrow()).message!);
  assert.equal(audit.previousAttempts, 4); assert.equal(audit.previousStatus, 'delist_failed');
  const attempt = await beginDelistAttempt(db, listing.id); assert.equal(attempt?.attempt, 1);
  await finishDelistAttempt(db, { ...attempt!, outcome: 'unknown', verified: false });
  assert.equal((await removalBacklog(db))[0].status, 'delist_unknown');
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), item); assert.equal(await db.publishJob.count(), 0);
});

test('stale identity, item revision, missing confirmation and malformed reviews never alter removal state', async t => {
  const { db, item, listing, snapshot } = await fixture(t); const review = await snapshot();
  for (const patch of [{ id: 0 }, { itemId: item.id + 1 }, { sku: 'OTHER' }, { externalListingId: 'other' },
    { externalUrl: 'https://www.depop.com/products/other/' }, { updatedAt: 'bad' }, { itemUpdatedAt: new Date(0).toISOString() }, { attemptCount: 2 }]) {
    await assert.rejects(reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: { ...review, ...patch } }));
  }
  assert.equal(validRemovalReview(null), false);
  await assert.rejects(reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: false, listing: review }));
  assert.deepEqual(await db.marketplaceListing.findUnique({ where: { id: listing.id } }), listing);
  assert.equal(await db.problemLog.count(), 0);
  await db.item.update({ where: { id: item.id }, data: { status: 'Ready', updatedAt: new Date(Date.now() + 1000) } });
  await assert.rejects(reviewRemoval(db, { action: 'retry_removal', confirmed: true, listing: review }), /changed/);
});

test('a browser claiming the reviewed row wins over manual resolution and active jobs remain protected', async t => {
  const { db, item, listing, snapshot } = await fixture(t);
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'delist_pending', attemptCount: 0 } });
  const review = await snapshot(); await beginDelistAttempt(db, listing.id);
  await assert.rejects(reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: review }), /changed/);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, 'delisting');
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'delist_failed' } });
  const run = await db.publishRun.create({ data: { status: 'running', marketplacesJson: '["depop"]', totalJobs: 1 } });
  await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: 'depop', status: 'publishing' } });
  await assert.rejects(reviewRemoval(db, { action: 'retry_removal', confirmed: true, listing: await snapshot() }), /active publishing/);
  assert.equal(await db.problemLog.count(), 0);
});

test('audit failure rolls back the status update and cannot silently clear a removal', async t => {
  const { db, listing, snapshot } = await fixture(t);
  const failing = { $transaction: (fn: any) => db.$transaction(tx => fn({ ...tx, problemLog: { create: async () => { throw Error('audit unavailable'); } } })) };
  await assert.rejects(reviewRemoval(failing as any, { action: 'confirm_manual_removal', confirmed: true, listing: await snapshot() }), /audit unavailable/);
  assert.deepEqual(await db.marketplaceListing.findUnique({ where: { id: listing.id } }), listing);
  assert.equal(await db.problemLog.count(), 0);
});

for (const status of ['Ready', 'Ready for Nifty', 'Listed']) {
  test(`external withdrawal of an unsold ${status} item prevents reposting and permits a fresh deletion`, async t => {
    const { db, item, listing, snapshot, deleteOptions } = await fixture(t);
    const before = await db.item.update({ where: { id: item.id }, data: { status, salePrice: null, platformSold: null, updatedAt: new Date(0) } });
    await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'published' } });
    assert.equal((await deleteItem(item.id, deleteOptions)).code, 'LIVE_LISTINGS');
    await reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: await snapshot() });
    const after = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(after.status, 'Removed'); assert.equal(after.salePrice, null); assert.equal(after.itemCost, before.itemCost);
    const scan = await scanAutoRunCandidates(db, {} as AppSettingsData, ['depop'], () => { throw Error('Withdrawn item must never reach an adapter'); });
    assert.equal(scan.batch, null); assert.equal(scan.coverage.total, 0);
    assert.equal((await createQueuedRun(db, [item.id], ['depop'])).ok, false);
    assert.equal((await deleteItem(item.id, { ...deleteOptions, expected: itemDeleteExpectation(before) })).code, 'ITEM_CHANGED');
    assert.equal((await deleteItem(item.id, { ...deleteOptions, expected: itemDeleteExpectation(after) })).ok, true);
    assert.equal(await db.item.count({ where: { id: item.id } }), 0);
    assert.equal(await db.problemLog.count({ where: { type: 'MANUAL_LISTING_REMOVAL_CONFIRMED' } }), 1);
  });
}

test('other live marketplaces remain protected and stale confirmations cannot resolve them', async t => {
  const { db, item, snapshot, deleteOptions } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { status: 'Ready', salePrice: null, platformSold: null, updatedAt: new Date(0) } });
  const other = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', status: 'published',
    externalListingId: '123456789012', externalUrl: 'https://www.ebay.com/itm/123456789012' } });
  const first = await snapshot();
  const second: RemovalReview = { ...other, sku: item.sku, externalListingId: other.externalListingId!, externalUrl: other.externalUrl!,
    updatedAt: other.updatedAt.toISOString(), itemUpdatedAt: first.itemUpdatedAt };
  await reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: first });
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, 'Needs Info');
  assert.equal((await deleteItem(item.id, { ...deleteOptions, force: true })).code, 'LIVE_LISTINGS');
  await assert.rejects(reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: second }), /changed/);
  const current = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  await reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: { ...second, itemUpdatedAt: current.updatedAt.toISOString() } });
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, 'Needs Info');
  assert.equal((await deleteItem(item.id, deleteOptions)).ok, true);
});

test('unsold withdrawal blocks active jobs and retains legacy Nifty protection', async t => {
  const { db, item, listing, snapshot, deleteOptions } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { status: 'Ready', salePrice: null, platformSold: null, niftyStatus: 'Published' } });
  await assert.rejects(reviewRemoval(db, { action: 'retry_removal', confirmed: true, listing: await snapshot() }), /changed/);
  const run = await db.publishRun.create({ data: { marketplacesJson: '["depop"]' } });
  const job = await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: 'depop' } });
  for (const status of ['queued', 'publishing', 'retrying']) {
    await db.publishJob.update({ where: { id: job.id }, data: { status } });
    await assert.rejects(reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: await snapshot() }), /active publishing/);
    assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, 'delist_failed');
  }
  await db.publishJob.update({ where: { id: job.id }, data: { status: 'cancelled' } });
  await reviewRemoval(db, { action: 'confirm_manual_removal', confirmed: true, listing: await snapshot() });
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, 'Needs Info');
  assert.equal((await deleteItem(item.id, deleteOptions)).code, 'LIVE_LISTINGS');
});

test('unsold withdrawal and repost suppression roll back together when the audit cannot be written', async t => {
  const { db, item, listing, snapshot } = await fixture(t);
  const before = await db.item.update({ where: { id: item.id }, data: { status: 'Ready', salePrice: null, platformSold: null } });
  const failing = { $transaction: (fn: any) => db.$transaction(tx => fn({ ...tx, problemLog: { create: async () => { throw Error('audit unavailable'); } } })) };
  await assert.rejects(reviewRemoval(failing as any, { action: 'confirm_manual_removal', confirmed: true, listing: await snapshot() }), /audit unavailable/);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), before);
  assert.deepEqual(await db.marketplaceListing.findUnique({ where: { id: listing.id } }), listing);
});
