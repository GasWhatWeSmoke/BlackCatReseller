import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';
import * as listing from './listing.ts';
import * as edits from './itemEdits.ts';
import { photoRecipe } from './preparedPhotos.ts';
import { buildCanonicalListing } from './publish/canonical.ts';
import { createQueuedRun } from './publish/createQueuedRun.ts';
import type { AppSettingsData } from './types.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-reidentify-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + file.replaceAll('\\', '/') } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-reidentify-')); fs.rmSync(root, { recursive: true, force: true }); });
  const worker = { runReenrich: async () => { throw Error('No model calls in this fixture'); } };
  const deps: Record<string, unknown> = { './db': { prisma: db }, './settings': {}, './worker': worker, './listing': listing, './itemEdits': edits };
  const exports: Record<string, any> = {};
  const source = ts.transpileModule(fs.readFileSync('src/lib/reidentify.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.compileFunction(source, ['exports', 'require', 'console'])(exports, (name: string) => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; }, { log() {} });
  const ready = path.join(root, 'ready'), folder = path.join(ready, 'listing_photos'); fs.mkdirSync(folder, { recursive: true });
  const original = path.join(root, 'original.jpg'); await sharp({ create: { width: 8, height: 6, channels: 3, background: '#123456' } }).jpeg().toFile(original);
  const bytes = fs.readFileSync(original), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const item = await db.item.create({ data: { sku: 'AI-RETRY', status: 'Ready', brand: 'Free People', size: 'M', itemType: 'Bralette', category: 'Tops', department: 'Women', color: 'Blue', condition: 'Good', listedPrice: 25, weightOz: 6, keyDetails: '',
    description: 'Operator description remains the source of truth.', readyFolderPath: ready,
    evidenceJson: JSON.stringify({ brand: { value: 'Free People', status: 'confirmed', sources: ['operator'] } }) } });
  const photo = await db.photo.create({ data: { itemId: item.id, originalFilename: 'original.jpg', storedPath: original, sha256: hash, isMarker: false, includeInListing: true } });
  const recipe = photoRecipe(item.sku, [photo]), exported = path.join(folder, recipe[0].name); fs.copyFileSync(original, exported);
  const receipt = (p: string) => { const stat = fs.statSync(p, { bigint: true }); return { size: String(stat.size), mtimeNs: String(stat.mtimeNs), sha256: hash }; };
  fs.writeFileSync(path.join(ready, 'item.json'), JSON.stringify({ photoSnapshot: { version: 1, itemId: item.id, sku: item.sku, directory: ready, recipe, sources: [receipt(original)], files: [receipt(exported)] } }));
  return { db, item, photo, api: exports, bytes, original, exported };
}
const enrichment = { fields: { brand: 'New AI brand', size: 'XS', color: 'Red' }, aiFields: ['brand', 'size', 'color'],
  raw: { model: 'Unreviewed collection', keyDetails: ['New AI detail'], description: 'An entirely new generated description with distinctive panels, contrasting details and a structured silhouette.', confidence: 0.99 } };

test('successful AI retry preserves operator values but revokes approval and blocks publication until review', async t => {
  const f = await fixture(t); const before = await f.db.item.findUniqueOrThrow({ where: { id: f.item.id }, include: { photos: true } });
  const settings = { minListingPhotos: 1 } as AppSettingsData; assert.ok(buildCanonicalListing(before, settings).listing);
  const prepared = await f.api.prepareReidentifyItem(f.item.id); assert.equal(prepared.ok, true);
  const result = await f.api.applyReidentification(prepared.prepared, enrichment); assert.equal(result.ok, true);
  for (const field of ['brand', 'size', 'color', 'description', 'keyDetails'] as const) assert.equal(result.item[field], before[field]);
  assert.equal(result.item.status, 'Photographed'); assert.equal(result.item.readyFolderPath, null); assert.ok(result.item.updatedAt > before.updatedAt);
  const after = await f.db.item.findUniqueOrThrow({ where: { id: f.item.id }, include: { photos: true } });
  assert.equal(buildCanonicalListing(after, settings).listing, null);
  assert.equal((await createQueuedRun(f.db, [f.item.id], ['depop'])).ok, false); assert.equal(await f.db.publishJob.count(), 0);
  assert.deepEqual(fs.readFileSync(f.original), f.bytes); assert.deepEqual(fs.readFileSync(f.exported), f.bytes);
  assert.equal(JSON.parse(after.evidenceJson!).brand.status, 'confirmed');
});

test('sold, archived, historical and live inventory are protected before inference', async t => {
  const f = await fixture(t);
  for (const data of [{ status: 'Sold' }, { status: 'Archived' }, { status: 'Removed' }, { status: 'Ready', niftyStatus: 'Published' }, { niftyStatus: 'Not Uploaded', salePrice: 0 }]) {
    const before = await f.db.item.update({ where: { id: f.item.id }, data });
    assert.equal((await f.api.prepareReidentifyItem(f.item.id)).status, 409);
    assert.deepEqual(await f.db.item.findUnique({ where: { id: f.item.id } }), before);
  }
  await f.db.item.update({ where: { id: f.item.id }, data: { status: 'Ready', salePrice: null } });
  const record = await f.db.marketplaceListing.create({ data: { itemId: f.item.id, marketplace: 'depop', status: 'published' } });
  for (const status of ['published', 'unknown', 'delist_pending', 'delisting', 'delist_unknown', 'delist_failed', 'sold']) {
    await f.db.marketplaceListing.update({ where: { id: record.id }, data: { status } });
    assert.equal((await f.api.prepareReidentifyItem(f.item.id)).status, 409);
  }
});

test('publishing reserved during inference prevents applying AI results even without an item revision change', async t => {
  const f = await fixture(t); const prepared = await f.api.prepareReidentifyItem(f.item.id);
  const run = await createQueuedRun(f.db, [f.item.id], ['depop']); assert.equal(run.ok, true);
  assert.equal((await f.api.applyReidentification(prepared.prepared, enrichment)).status, 409);
  assert.deepEqual(await f.db.item.findUnique({ where: { id: f.item.id } }), f.item);
  assert.equal((await f.api.prepareReidentifyItem(f.item.id)).status, 409);
});

test('a replacement row cannot adopt the previous item AI answer even with reused IDs and timestamps', async t => {
  const f = await fixture(t); const prepared = await f.api.prepareReidentifyItem(f.item.id);
  await f.db.item.delete({ where: { id: f.item.id } });
  const replacement = await f.db.item.create({ data: { ...f.item, createdAt: new Date(f.item.createdAt.getTime() + 60000) } });
  // Item deletion retains the photo with itemId=null; reattach that same row.
  await f.db.photo.update({ where: { id: f.photo.id }, data: { itemId: replacement.id } });
  assert.equal((await f.api.applyReidentification(prepared.prepared, enrichment)).status, 409);
  assert.deepEqual(await f.db.item.findUnique({ where: { id: f.item.id } }), replacement);
});

test('protected failed records cannot occupy the retry page ahead of eligible inventory', async t => {
  const f = await fixture(t); await f.db.item.update({ where: { id: f.item.id }, data: { status: 'Sold', aiError: 'old' } });
  for (let index = 0; index < 501; index++) {
    const row = await f.db.item.create({ data: { sku: `PROTECTED-${index}`, status: 'Sold', aiError: 'old' } });
    await f.db.photo.create({ data: { itemId: row.id, originalFilename: 'shared.jpg', storedPath: f.original, sha256: f.photo.sha256, isMarker: false, includeInListing: true } });
  }
  const eligible = await f.db.item.create({ data: { sku: 'ELIGIBLE-LATE', status: 'Photographed', aiError: 'retry' } });
  await f.db.photo.create({ data: { itemId: eligible.id, originalFilename: 'shared.jpg', storedPath: f.original, sha256: f.photo.sha256, isMarker: false, includeInListing: true } });
  const rows = await f.db.item.findMany({ where: {
    ...f.api.REIDENTIFY_CANDIDATE_WHERE, aiError: { not: null },
    photos: { some: { isMarker: false, includeInListing: true, storedPath: { not: '' } } },
  }, orderBy: { id: 'asc' }, take: 500, select: { id: true } });
  assert.deepEqual(rows, [{ id: eligible.id }]); assert.equal(await f.db.publishJob.count(), 0);
});

test('retry preparation carries the saved photo rotation', async t => {
  const f = await fixture(t);
  await f.db.photo.update({ where: { id: f.photo.id }, data: { rotation: 90 } });
  const prepared = await f.api.prepareReidentifyItem(f.item.id);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.prepared.photos[0].rotation, 90);
});

test('rotation changes during inference reject the result even without a parent revision change', async t => {
  const f = await fixture(t); const prepared = await f.api.prepareReidentifyItem(f.item.id);
  await f.db.photo.update({ where: { id: f.photo.id }, data: { rotation: 180 } });
  assert.equal((await f.api.applyReidentification(prepared.prepared, enrichment)).status, 409);
  assert.deepEqual(await f.db.item.findUnique({ where: { id: f.item.id } }), f.item);
});
