import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { reviewRemoval, validRemovalReview, type RemovalReview } from './removalRecovery.ts';
import { beginDelistAttempt, finishDelistAttempt, removalBacklog } from './saleProtection.ts';

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-removal-review-'));
  const file = path.join(dir, 'test.db'); fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + file.replaceAll('\\', '/') } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: '000086', status: 'Sold', platformSold: 'eBay', salePrice: 20.99, itemCost: 3 } });
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'depop', status: 'delist_failed',
    externalListingId: 'seller-belt', externalUrl: 'https://www.depop.com/products/seller-belt/', attemptCount: 4, lastError: 'Missing Edit link' } });
  const snapshot = async (): Promise<RemovalReview> => {
    const row = (await removalBacklog(db)).find(row => row.id === listing.id)!;
    return { ...row, externalUrl: row.externalUrl!, externalListingId: row.externalListingId!, sku: row.item.sku,
      updatedAt: row.updatedAt.toISOString(), itemUpdatedAt: row.item.updatedAt.toISOString() };
  };
  return { db, item, listing, snapshot };
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
