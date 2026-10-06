import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { photoRecipe } from '../preparedPhotos.ts';
import { readPublishEligibility, platformPreflight } from './eligibility.ts';
import { eligibilityView, parseEligibilityQuery, eligibilityQueryString, selectedPlatformWarnings, queueAutoState } from './eligibilityView.ts';
import { ebayBrowserValidate } from './adapters/ebay-browser/mapping.ts';
import { depopValidate } from './adapters/depop/mapping.ts';
import type { CanonicalListing } from './types.ts';
import type { AppSettingsData } from '../types.ts';
import { buildCanonicalListing } from './canonical.ts';
const validators = [{ id: 'ebay' as const, validate: ebayBrowserValidate }, { id: 'depop' as const, validate: depopValidate }];
const settings = { publish: { relistPricing: 'preserve_marketplace' } } as AppSettingsData;
const listing = { itemId: 1, sku: 'PREFLIGHT', title: 'Nike Mens T-shirt Blue M', description: 'Fixture garment', itemType: 'T-shirt', category: 'Tops', department: 'Men', condition: 'Good', price: 25, size: 'M', quantity: 1, photos: [{ path: 'C:/fixture/photo.jpg', name: 'photo.jpg' }] } as CanonicalListing;
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-preflight-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-preflight-')); fs.rmSync(root, { recursive: true, force: true }); });
  const ready = path.join(root, 'ready'), files = path.join(ready, 'listing_photos'); fs.mkdirSync(files, { recursive: true });
  const item = await db.item.create({ data: { sku: 'PREFLIGHT', status: 'Ready', brand: 'Nike', itemType: 'T-shirt', category: 'Tops', department: 'Men', color: 'Blue', condition: 'Pre-owned - Good', size: 'M', listedPrice: 25, readyFolderPath: ready } });
  const source = path.join(root, 'source.jpg'); fs.writeFileSync(source, 'Fixture photo bytes');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  await db.photo.create({ data: { itemId: item.id, originalFilename: 'source.jpg', storedPath: source, sha256: hash, includeInListing: true, isCover: true } });
  const photos = await db.photo.findMany({ where: { itemId: item.id } }), recipe = photoRecipe(item.sku, photos);
  const output = path.join(files, recipe[0].name); fs.copyFileSync(source, output);
  const receipt = (file: string) => { const stat = fs.statSync(file, { bigint: true }); return { size: String(stat.size), mtimeNs: String(stat.mtimeNs), sha256: hash }; };
  fs.writeFileSync(path.join(ready, 'item.json'), JSON.stringify({ photoSnapshot: { version: 1, itemId: item.id, sku: item.sku, directory: ready, recipe, sources: [receipt(source)], files: [receipt(output)] } }));
  return { db, item, root };
}
test('native platform problems appear despite passing shared readiness, without changing inventory or files', async t => {
  const { db, item, root } = await fixture(t);
  const before = await db.item.findMany(), files = fs.readdirSync(root);
  const result = await readPublishEligibility(db, settings, validators); eligibilityView(result);
  assert.equal(result.items.length, 1); const row = result.items[0]; assert.equal(row.ready, true);
  assert.ok(row.platformIssues.ebay.some(issue => issue.field === 'condition')); assert.ok(row.platformIssues.depop.some(issue => issue.field === 'condition'));
  assert.ok(!row.applicableOn.includes('etsy')); assert.ok(row.platformIssues.mercari.some(issue => /unavailable/.test(issue.message)));
  assert.equal(selectedPlatformWarnings(row, [{ id: 'ebay', name: 'eBay' }]).length, 1); assert.deepEqual(selectedPlatformWarnings(row, []), []);
  assert.deepEqual(await db.item.findMany(), before); assert.deepEqual(fs.readdirSync(root), files); assert.equal(await db.publishJob.count(), 0);
  await db.item.update({ where: { id: item.id }, data: { condition: 'Good' } });
  const corrected = await readPublishEligibility(db, settings, validators); assert.deepEqual(corrected.items[0].platformIssues.ebay, []); assert.deepEqual(corrected.items[0].platformIssues.depop, []);
});
test('preflight validates the actual preserved price and respects publication uncertainty and already-published targets', () => {
  const previous = [{ marketplace: 'depop', status: 'ended', externalListingId: 'old', price: 0.5 }, { marketplace: 'ebay', status: 'unknown', externalListingId: null, price: null }];
  const result = platformPreflight(listing, previous, ['depop', 'ebay'], settings, validators);
  assert.ok(result.depop.some(issue => issue.field === 'price')); assert.ok(result.ebay.some(issue => issue.field === 'listing' && /may be live/.test(issue.message))); assert.equal(listing.price, 25);
  assert.deepEqual(platformPreflight(listing, previous, ['depop'], { publish: { relistPricing: 'reviewed' } } as AppSettingsData, validators).depop, []);
  const published = platformPreflight({ ...listing, condition: 'Wrong' }, [{ marketplace: 'ebay', status: 'published', externalListingId: '123', price: 25 }], ['ebay'], settings, [{ id: 'ebay', validate: () => { throw Error('Already published must not be revalidated'); } }]); assert.deepEqual(published.ebay, []);
  assert.match(platformPreflight(listing, [{ marketplace: 'depop', status: 'ended', externalListingId: null, price: null }], ['depop'], settings, validators).depop[0].message, /previous price/);
});
test('unavailable validators cannot produce an all-clear result', () => {
  const checks = platformPreflight(listing, [], ['ebay', 'depop', 'poshmark'], settings, [{ id: 'ebay', validate: () => { throw Error('Fixture failure'); } }, { id: 'depop', validate: () => null as never }]);
  for (const marketplace of ['ebay', 'depop', 'poshmark']) assert.match(checks[marketplace][0].message, /unavailable/);
});
test('shared failures and review-only records retain their existing scope', async t => {
  const { db, item } = await fixture(t); await db.item.update({ where: { id: item.id }, data: { listedPrice: null } });
  await db.item.createMany({ data: [{ sku: 'REVIEW', status: 'Photographed' }, { sku: 'SOLD', status: 'Sold' }, { sku: 'SHELL', status: 'Needs Info', isShell: true }, { sku: 'LEGACY', status: 'Needs Info', niftyStatus: 'Published' }] });
  const result = await readPublishEligibility(db, settings, [{ id: 'ebay', validate: () => { throw Error('No valid shared listing'); } }]); eligibilityView(result);
  assert.equal(result.items[0].ready, false); assert.deepEqual(result.items[0].platformIssues, {}); assert.deepEqual(result.awaitingReview.map(row => row.sku), ['REVIEW']);
  await assert.rejects(readPublishEligibility({ $transaction: async () => { throw Error('Unavailable'); } } as never, settings, validators), /Unavailable/);
});
test('incomplete warnings and malformed automation state are rejected instead of clearing the view', async t => {
  const { db } = await fixture(t); const result = await readPublishEligibility(db, settings, validators); eligibilityView(result);
  for (const broken of [{}, { ...result, awaitingReview: null }, { ...result, items: [{ ...result.items[0], platformIssues: {} }] }, { ...result, items: [{ ...result.items[0], platformIssues: { ebay: 'bad' } }] }]) assert.throws(() => eligibilityView(broken));
  assert.throws(() => eligibilityView({ ...result, items: [result.items[0], result.items[0]] }));
  assert.throws(() => eligibilityView({ ...result, items: [{ ...result.items[0], itemType: {} }] }));
  const auto = { config: { enabled: false, marketplaces: ['ebay'] }, state: 'off', needsAttention: 0, error: null, runId: null }; queueAutoState(auto);
  for (const broken of [{}, { ...auto, error: {} }, { ...auto, needsAttention: '0' }, { ...auto, config: { enabled: 'false', marketplaces: ['ebay'] } }]) assert.throws(() => queueAutoState(broken));
});

test('queue package estimates match publication values without marking saved weight as measured or changing inventory', async t => {
  const { db, item } = await fixture(t);
  for (const weightOz of [null, 18]) {
    const updated = await db.item.update({ where: { id: item.id }, data: { weightOz }, include: { photos: true } });
    const before = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    const queue = await readPublishEligibility(db, settings, validators);
    const published = buildCanonicalListing(updated, settings).listing;
    assert.ok(published);
    assert.equal(queue.items[0].ready, true, 'Allowed estimates must not prevent shared readiness');
    assert.equal(queue.items[0].packageDetails.weightOz, weightOz ?? 6);
    assert.equal(queue.items[0].packageDetails.weightBasis, weightOz === null ? 'type_estimate' : 'saved_unverified');
    assert.equal(published.weightOz, queue.items[0].packageDetails.weightOz);
    assert.deepEqual(published.packageDims, queue.items[0].packageDetails.dimensions);
    assert.deepEqual(published.packageDims, { length: 9, width: 6, height: 1 });
    assert.deepEqual(await db.item.findUniqueOrThrow({ where: { id: item.id } }), before);
    assert.equal(await db.publishJob.count(), 0);
  }
});

test('20k Ready records retain complete totals and late-page access while preflight checks only the requested page', async t => {
  const { db, item } = await fixture(t);
  for (let start = 1; start < 20000; start += 1000) await db.item.createMany({ data: Array.from({ length: Math.min(1000, 20000 - start) }, (_, offset) => ({
    sku: start + offset === 19999 ? 'ZZ-LAST' : `Q${String(start + offset).padStart(5, '0')}`, status: 'Ready', brand: 'Fixture',
    itemType: 'T-shirt', size: 'M', category: 'Tops', department: 'Men', color: 'Blue', condition: 'Good', listedPrice: 25, readyFolderPath: item.readyFolderPath,
  })) });
  await db.item.createMany({ data: [
    ...Array.from({ length: 13 }, (_, index) => ({ sku: `REVIEW-${index}`, status: 'Photographed' })),
    { sku: 'SHELL', status: 'Needs Info', isShell: true }, { sku: 'LEGACY', status: 'Needs Info', niftyStatus: 'Published' }, { sku: 'SOLD', status: 'Sold' },
  ] });
  const files = t.mock.method(fs, 'readdirSync');
  const started = performance.now(); const first = await readPublishEligibility(db, settings, validators); eligibilityView(first);
  assert.equal(first.items.length, 100); assert.equal(first.pagination.total, 20000); assert.equal(first.pagination.pages, 200);
  assert.equal(first.counts.approved, 20000); assert.equal(first.counts.awaitingReview, 13); assert.equal(first.awaitingReview.length, 6);
  assert.equal(files.mock.callCount(), 100, 'Off-page files must not be checked');
  assert.equal(first.items.filter(row => row.ready).length, 1, 'Approval totals must not pretend missing prepared files passed preflight');
  const query = parseEligibilityQuery(new URLSearchParams('page=200&marketplaces=ebay'));
  const last = await readPublishEligibility(db, settings, validators, query); eligibilityView(last);
  assert.equal(last.items.length, 100); assert.equal(last.items.at(-1)?.sku, 'ZZ-LAST'); assert.equal(last.pagination.page, 200);
  assert.ok(!first.items.some(row => last.items.some(other => other.id === row.id)));
  const search = await readPublishEligibility(db, settings, validators, { ...query, q: 'ZZ-LAST' }); eligibilityView(search);
  assert.equal(search.pagination.page, 1); assert.equal(search.pagination.total, 1); assert.equal(search.items[0].sku, 'ZZ-LAST');
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', status: 'published' } });
  const ebay = await readPublishEligibility(db, settings, validators, { ...query, page: 1 }); eligibilityView(ebay);
  assert.equal(ebay.pagination.total, 19999); assert.equal(ebay.counts.withListings, 1); assert.equal(ebay.items.some(row => row.id === item.id), false);
  const unselected = await readPublishEligibility(db, settings, validators, { ...query, marketplaces: [] }); eligibilityView(unselected);
  assert.equal(unselected.pagination.total, 0); assert.equal(unselected.items.length, 0); assert.equal(unselected.counts.approved, 20000);
  const etsy = await readPublishEligibility(db, settings, validators, { ...query, marketplaces: ['etsy'] }); eligibilityView(etsy);
  assert.equal(etsy.pagination.total, 0, 'Non-vintage items do not become an unfinished Etsy queue');
  await db.item.updateMany({ where: { status: 'Ready', sku: { not: 'ZZ-LAST' } }, data: { status: 'Archived' } });
  const shrunk = await readPublishEligibility(db, settings, validators, query); eligibilityView(shrunk);
  assert.equal(shrunk.pagination.page, 1); assert.equal(shrunk.pagination.pages, 1); assert.equal(shrunk.pagination.total, 1); assert.equal(shrunk.items[0].sku, 'ZZ-LAST');
  assert.equal(await db.publishJob.count(), 0);
  t.diagnostic(`20k queue paging/search/filter checks: ${Math.round(performance.now() - started)}ms; 100 file checks per full page`);
});

test('invalid queue parameters and incomplete counts cannot authorize a page selection', async t => {
  for (const value of ['page=0', 'page=-1', 'page=1e2', 'pageSize=500', 'marketplaces=unknown', 'q=' + 'x'.repeat(201)])
    assert.throws(() => parseEligibilityQuery(new URLSearchParams(value)));
  const query = parseEligibilityQuery(new URLSearchParams('page=2&pageSize=25&marketplaces=ebay,depop,ebay&q=%20shirt%20'));
  assert.deepEqual(parseEligibilityQuery(new URLSearchParams(eligibilityQueryString(query))), query);
  assert.deepEqual(query.marketplaces, ['depop', 'ebay']); assert.equal(query.q, 'shirt');
  const { db } = await fixture(t); const value = await readPublishEligibility(db, settings, validators);
  for (const patch of [{ total: 2 }, { page: 0 }, { pages: 3 }, { pageSize: 500 }, { marketplaces: ['unknown'] }])
    assert.throws(() => eligibilityView({ ...value, pagination: { ...value.pagination, ...patch } }));
  for (const patch of [{ approved: 0 }, { awaitingReview: 1 }, { withListings: 2 }])
    assert.throws(() => eligibilityView({ ...value, counts: { ...value.counts, ...patch } }));
  assert.throws(() => eligibilityView({ ...value, counts: null }));
  assert.throws(() => eligibilityView({ ...value, pagination: null }));
});
