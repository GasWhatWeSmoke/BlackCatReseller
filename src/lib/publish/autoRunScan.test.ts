import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { photoRecipe } from '../preparedPhotos.ts';
import type { AppSettingsData } from '../types.ts';
import { scanAutoRunCandidates } from './autoRunScan.ts';
import { createAutoRunController } from './autoRun.ts';
import { queueAutoState } from './eligibilityView.ts';
import { ebayBrowserValidate } from './adapters/ebay-browser/mapping.ts';

const settings = { minListingPhotos: 1, publish: { relistPricing: 'reviewed' } } as AppSettingsData;
const adapter = () => ({ availability: () => ({ configured: true, reason: null }), validate: ebayBrowserValidate });
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-auto-scan-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + file.replaceAll('\\', '/') } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  async function ready(sku: string) {
    const folder = path.join(root, sku), photosDir = path.join(folder, 'listing_photos'); fs.mkdirSync(photosDir, { recursive: true });
    const item = await db.item.create({ data: { sku, status: 'Ready', brand: 'Nike', itemType: 'T-shirt', category: 'Tops', department: 'Men', color: 'Blue', condition: 'Good', size: 'M', listedPrice: 25, readyFolderPath: folder } });
    const source = path.join(folder, 'source.jpg'); fs.writeFileSync(source, 'Synthetic image bytes');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const photo = await db.photo.create({ data: { itemId: item.id, originalFilename: 'source.jpg', storedPath: source, sha256: hash, includeInListing: true, isCover: true } });
    const recipe = photoRecipe(sku, [photo]), output = path.join(photosDir, recipe[0].name); fs.copyFileSync(source, output);
    const receipt = (file: string) => { const stat = fs.statSync(file, { bigint: true }); return { size: String(stat.size), mtimeNs: String(stat.mtimeNs), sha256: hash }; };
    fs.writeFileSync(path.join(folder, 'item.json'), JSON.stringify({ photoSnapshot: { version: 1, itemId: item.id, sku, directory: folder,
      recipe, sources: [receipt(source)], files: [receipt(output)] } }));
    return item;
  }
  const invalid = (count: number) => db.item.createMany({ data: Array.from({ length: count }, (_, index) => ({ sku: `INVALID-${index}`, status: 'Ready' })) });
  return { db, ready, invalid };
}

test('20k candidates produce a checked batch with only 25 file preflights and explicit partial coverage', async t => {
  const { db, ready, invalid } = await fixture(t); const ids = [];
  for (let index = 0; index < 25; index++) ids.push((await ready(`READY-${index}`)).id);
  await invalid(19975); const before = await db.item.findMany({ where: { id: { in: ids } } });
  const files = t.mock.method(fs, 'readdirSync');
  const result = await scanAutoRunCandidates(db, settings, ['ebay'], adapter);
  assert.deepEqual(result.batch, { itemIds: ids, marketplaces: ['ebay'] });
  assert.deepEqual(result.coverage, { checked: 25, total: 20000, complete: false });
  assert.equal(files.mock.callCount(), 25); assert.equal(result.needsAttention, 0);
  assert.deepEqual(await db.item.findMany({ where: { id: { in: ids } } }), before); assert.equal(await db.publishJob.count(), 0);
});

test('invalid early pages do not hide a later ready item and complete scans report all checked failures', async t => {
  const { db, ready, invalid } = await fixture(t); await invalid(210); const last = await ready('LATE'); const progress: number[] = [];
  const result = await scanAutoRunCandidates(db, settings, ['ebay'], adapter, { onProgress: value => progress.push(value.coverage.checked) });
  assert.deepEqual(result.batch?.itemIds, [last.id]); assert.equal(result.needsAttention, 210);
  assert.deepEqual(result.coverage, { checked: 211, total: 211, complete: true }); assert.deepEqual(progress, [0, 100, 200, 211]);
  await db.item.update({ where: { id: last.id }, data: { listedPrice: null } });
  const blocked = await scanAutoRunCandidates(db, settings, ['ebay'], adapter);
  assert.equal(blocked.batch, null); assert.equal(blocked.needsAttention, 211); assert.equal(blocked.coverage.complete, true);
});

test('switching off between pages stops preflight and never queues a partial selection', async t => {
  const { db, invalid } = await fixture(t); await invalid(210); let enabled = true, queued = 0;
  const controller = createAutoRunController({ config: async () => ({ enabled, marketplaces: ['ebay'] }), activeRun: async () => null,
    batch: (targets, onProgress) => scanAutoRunCandidates(db, settings, targets, adapter, { shouldContinue: async () => enabled,
      onProgress: value => { onProgress?.(value); if (value.coverage.checked === 100) enabled = false; } }),
    queue: async () => { queued++; return { ok: true }; } });
  await controller.tick(); assert.equal(queued, 0); assert.equal(controller.snapshot().state, 'off'); assert.equal(controller.snapshot().attentionCoverage, null);
});

test('ID snapshots recheck sold and unapproved rows; history, uncertain listings and non-vintage Etsy stay excluded', async t => {
  const { db, ready } = await fixture(t); const a = await ready('A'), b = await ready('B');
  const changed = await scanAutoRunCandidates(db, settings, ['ebay'], adapter, { shouldContinue: async () => {
    await db.item.update({ where: { id: a.id }, data: { status: 'Sold' } }); await db.item.update({ where: { id: b.id }, data: { status: 'Photographed' } }); return true;
  } });
  assert.equal(changed.batch, null); assert.equal(changed.coverage.complete, true);
  await db.item.updateMany({ data: { status: 'Ready' } });
  await db.marketplaceListing.create({ data: { itemId: a.id, marketplace: 'ebay', status: 'unknown' } });
  const run = await db.publishRun.create({ data: { status: 'done', marketplacesJson: '["ebay"]', totalJobs: 1 } });
  await db.publishJob.create({ data: { itemId: b.id, runId: run.id, marketplace: 'ebay', status: 'failed' } });
  assert.equal((await scanAutoRunCandidates(db, settings, ['ebay'], adapter)).coverage.total, 0);
  assert.equal((await scanAutoRunCandidates(db, settings, ['etsy'], adapter)).coverage.total, 0);
  assert.equal(await db.publishJob.count(), 1);
});

test('partial batches keep compatible targets and validate the preserved marketplace price', async t => {
  const { db, ready } = await fixture(t); const a = await ready('A'), b = await ready('B'), c = await ready('C'); const prices: number[] = [];
  await db.marketplaceListing.create({ data: { itemId: a.id, marketplace: 'ebay', status: 'ended', price: 19 } });
  const result = await scanAutoRunCandidates(db, { ...settings, publish: { relistPricing: 'preserve_marketplace' } } as AppSettingsData,
    ['ebay', 'depop'], market => ({ availability: () => ({ configured: true, reason: null }), validate: listing => {
      prices.push(listing.price); return market === 'depop' && listing.itemId === b.id ? [{ field: 'fixture', message: 'Incompatible target' }] : [];
    } }));
  assert.deepEqual(result.batch, { itemIds: [a.id, c.id], marketplaces: ['ebay', 'depop'] });
  assert.ok(prices.includes(19)); assert.equal((await db.item.findUniqueOrThrow({ where: { id: a.id } })).listedPrice, 25);
  const unavailable = await scanAutoRunCandidates(db, settings, ['ebay'], () => undefined);
  assert.equal(unavailable.needsAttention, 3); assert.equal(unavailable.batch, null); assert.equal(unavailable.coverage.complete, true);
});

test('inconsistent check coverage cannot become an all-clear and snapshots cannot mutate controller state', async () => {
  const view = { config: { enabled: true, marketplaces: ['ebay'] }, state: 'running', needsAttention: 2, error: null, runId: 1,
    attentionCoverage: { checked: 25, total: 20000, complete: false } };
  queueAutoState(view);
  for (const patch of [{ checked: -1 }, { checked: 20001 }, { complete: true }, { total: '20000' }, { checked: 1 }])
    assert.throws(() => queueAutoState({ ...view, attentionCoverage: { ...view.attentionCoverage, ...patch } }));
  const controller = createAutoRunController({ config: async () => view.config, activeRun: async () => null,
    batch: async () => ({ batch: { itemIds: [1], marketplaces: ['ebay'] }, needsAttention: 2, coverage: view.attentionCoverage }),
    queue: async () => ({ ok: true, runId: 1 }) });
  await controller.tick(); const snapshot = controller.snapshot(); snapshot.attentionCoverage!.checked = 20000;
  assert.equal(controller.snapshot().attentionCoverage?.checked, 25);
});
