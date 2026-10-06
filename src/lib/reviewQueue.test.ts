import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { readReviewIndex, readReviewSignatures, readReviewDetails, reviewIds } from './reviewQueueRead.ts';
import { filterReviewQueue, reviewIndexView, reviewBatchView, fetchReviewDetail } from './reviewQueueClient.ts';
import { reviewKey, reviewSignature, type ReviewCheckpoint, type ReviewItem } from './reviewCheckpoint.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-review-read-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + file.replaceAll('\\', '/') } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return db;
}
const checkpoint = (item: ReviewItem, signature: string): ReviewCheckpoint => ({ version: 1, key: reviewKey(item), revision: 'fixture', id: item.id,
  createdAt: item.createdAt, sku: item.sku, itemVersion: item.updatedAt, signature, reviewedAt: item.updatedAt,
  title: 'Fixture item', price: 20, photos: 3, phase: 'reviewed' });

test('review index retains queue eligibility and detail reads preserve blocking publication state', async t => {
  const db = await fixture(t);
  await db.item.createMany({ data: [{ id: 1, sku: '000001', status: 'Photographed', notes: 'PRIVATE', aiError: 'PRIVATE' },
    { id: 2, sku: '000002', status: 'Needs Info', flagged: true }, { id: 3, sku: '000003', status: 'Ready' }, { id: 4, sku: '000004', status: 'Sold' }] });
  await db.marketplaceListing.create({ data: { itemId: 1, marketplace: 'ebay', status: 'published' } });
  const index = readReviewIndex(db); assert.deepEqual(reviewIndexView(await index).map(row => row.id), [1, 2]);
  assert.ok(!JSON.stringify(await index).includes('PRIVATE')); assert.equal((await index).items[0].hasAiError, true);
  const rows = await readReviewDetails(db, [1, 999]); assert.equal(rows.items.length, 1);
  assert.match(rows.items[0].republicationBlockReason!, /Already listed/); assert.equal(rows.items[0].notes, 'PRIVATE');
  assert.equal(await db.item.count(), 4);
});

test('checkpoint filtering retains exact content, photo, identity, phase, version and draft safeguards', async t => {
  const db = await fixture(t);
  await db.item.createMany({ data: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, sku: String(i + 1), status: 'Needs Info' })) });
  const initial = await readReviewDetails(db, Array.from({ length: 9 }, (_, i) => i + 1));
  const checkpoints = await Promise.all(initial.items.map(async row => checkpoint(row as unknown as ReviewItem, await reviewSignature(row as unknown as ReviewItem))));
  // Child photo changes do not need to update the item's timestamp.
  await db.photo.create({ data: { itemId: 2, storedPath: 'fixture.jpg', originalFilename: 'fixture.jpg', sha256: 'fixture' } });
  await db.item.update({ where: { id: 3 }, data: { aiRaw: '{"title":"changed"}', updatedAt: new Date(initial.items[2].updatedAt) } });
  checkpoints[3].phase = 'unknown'; checkpoints[4].itemVersion = '2000-01-01T00:00:00.000Z';
  checkpoints[5].createdAt = '2000-01-01T00:00:00.000Z'; checkpoints[5].key = reviewKey(checkpoints[5]);
  const index = (await readReviewIndex(db)).items;
  const dirty = new Set([`${index[6].id}:${index[6].createdAt}`]);
  const result = await filterReviewQueue(index, checkpoints, dirty, async ids => (await readReviewSignatures(db, ids)).items, 8);
  assert.deepEqual(result.map(row => row.id), [2, 3, 4, 5, 6, 7, 8]);
  const vanished = await filterReviewQueue(index.slice(0, 1), checkpoints, new Set(), async () => []);
  assert.equal(vanished.length, 1);
});

test('review signature verification stays bounded and failures do not report an empty queue', async () => {
  const index = Array.from({ length: 251 }, (_, i) => ({ id: i + 1, sku: String(i + 1), createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', flagged: false, hasAiError: false }));
  const checkpoints = index.map(row => checkpoint(row as unknown as ReviewItem, 'a'.repeat(64)));
  let active = 0, max = 0; const sizes: number[] = [];
  const result = await filterReviewQueue(index, checkpoints, new Set(), async ids => {
    sizes.push(ids.length); active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return ids.map(id => ({ ...index[id - 1], signature: 'a'.repeat(64) }));
  });
  assert.deepEqual(result, []); assert.equal(max, 4); assert.ok(sizes.every(size => size <= 50));
  await assert.rejects(filterReviewQueue(index, checkpoints, new Set(), async () => { throw Error('Fixture read failed'); }), /Fixture read failed/);
});

test('malformed or reused item receipts cannot supply an editable review item', async t => {
  for (const raw of [null, '', '0', '1,no', Array.from({ length: 51 }, (_, i) => String(i + 1)).join(',')]) assert.throws(() => reviewIds(raw));
  assert.deepEqual(reviewIds('1,2,1'), [1, 2]);
  assert.throws(() => reviewIndexView({ items: [], total: 1 })); assert.throws(() => reviewBatchView({ items: [{ id: 2 }], requestedIds: [1] }, [1]));
  const db = await fixture(t); await db.item.create({ data: { id: 1, sku: '000001', status: 'Needs Info' } });
  const row = (await readReviewIndex(db)).items[0], valid = await readReviewDetails(db, [1]);
  t.mock.method(globalThis, 'fetch', async () => Response.json(valid));
  assert.equal((await fetchReviewDetail(row, new AbortController().signal)).id, 1);
  await assert.rejects(fetchReviewDetail({ ...row, createdAt: '2000-01-01T00:00:00.000Z' }, new AbortController().signal), /no longer/);
});

test('20000 review identities expose the final SKU without loading every photo or AI payload', async t => {
  const db = await fixture(t);
  for (let offset = 0; offset < 20000; offset += 250) await db.item.createMany({ data: Array.from({ length: 250 }, (_, i) => ({ id: offset + i + 1,
    sku: String(offset + i + 1).padStart(6, '0'), status: 'Needs Info', aiRaw: 'PRIVATE '.repeat(200), notes: 'PRIVATE '.repeat(200) })) });
  const before = await db.item.findMany({ where: { status: { in: ['Photographed', 'Needs Info'] } }, include: { photos: true }, orderBy: { sku: 'asc' }, take: 5000 });
  assert.equal(before.at(-1)?.sku, '005000');
  const start = performance.now(), index = await readReviewIndex(db), ms = Math.round(performance.now() - start);
  assert.equal(reviewIndexView(index).length, 20000); assert.equal(index.items.at(-1)?.sku, '020000');
  assert.ok(!JSON.stringify(index).includes('PRIVATE'));
  const detail = await readReviewDetails(db, [20000]); assert.equal(detail.items[0].sku, '020000'); assert.equal(detail.items.length, 1);
  t.diagnostic(`20000 review identities: ${ms}ms, ${Buffer.byteLength(JSON.stringify(index))} bytes; one detail: ${Buffer.byteLength(JSON.stringify(detail))} bytes; old capped read: ${Buffer.byteLength(JSON.stringify(before))} bytes`);
});
