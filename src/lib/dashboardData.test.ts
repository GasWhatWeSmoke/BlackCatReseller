import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { dashboardPage, readDashboardStats, readDashboardCollisions, readDashboardProblems, dismissDashboardProblems } from './dashboardData.ts';
import { dashboardStatsView, collisionPageView, problemPageView, dismissalResult } from './dashboardDataView.ts';
import { dashboardSales } from './dashboardSales.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-dashboard-data-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-dashboard-data-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

test('dashboard totals preserve lifetime money and platform readiness; unavailable Incoming stays unknown', async t => {
  const { db, root } = await fixture(t);
  await db.item.createMany({ data: [
    { sku: 'SALE1', status: 'Sold', salePrice: 17, shippingCharged: 0 },
    { sku: 'SALE2', status: 'Sold', salePrice: null, shippingCharged: null },
    { sku: 'READY', status: 'Ready', niftyStatus: 'Not uploaded' },
    { sku: 'LIVE', status: 'Published' }, { sku: 'REVIEW', status: 'Photographed' },
  ] });
  const live = await db.item.findUniqueOrThrow({ where: { sku: 'LIVE' } });
  await db.marketplaceListing.create({ data: { itemId: live.id, marketplace: 'ebay', status: 'published' } });
  await db.problemLog.createMany({ data: [{ type: 'UNREADABLE_FILE' }, { type: 'SOLD_STILL_LISTED' }, { type: 'UNREADABLE_FILE', resolved: true }] });
  fs.writeFileSync(path.join(root, 'photo.JPG'), 'fixture'); fs.mkdirSync(path.join(root, 'directory.jpg'));
  const settings = { incomingPath: root, publish: { autoRun: { enabled: false, marketplaces: ['ebay'] } } };
  const result = await readDashboardStats(db, settings as never); dashboardStatsView(json(result));
  assert.equal(result.totalItems, 5); assert.equal(result.readyCount, 1); assert.equal(result.listedCount, 1); assert.equal(result.problemsOpen, 1); assert.equal(result.incomingCount, 1);
  assert.deepEqual(result.lifetimeSales, dashboardSales([{ salePrice: 17, shippingCharged: 0 }, { salePrice: null, shippingCharged: null }]));
  const missing = await readDashboardStats(db, { ...settings, incomingPath: path.join(root, 'missing') } as never); dashboardStatsView(json(missing));
  assert.equal(missing.incomingCount, null); assert.ok(missing.incomingError); assert.equal(missing.totalItems, 5);
  assert.equal((await readDashboardStats(db, { ...settings, publish: { autoRun: { enabled: false, marketplaces: [] } } } as never)).readyCount, 0);
});

test('collision pages remain bounded and retain malformed or empty groups without hiding valid work', async t => {
  const { db } = await fixture(t);
  for (let id = 1; id <= 27; id++) await db.collision.create({ data: { id, sku: `GROUP-${id}`, incomingPhotosJson: id === 27 ? '{broken' : id === 26 ? '[]' : '[{"storedPath":"C:/fixture/photo.jpg"}]', createdAt: new Date('2026-09-20') } });
  const first = await readDashboardCollisions(db); collisionPageView(json(first));
  assert.equal(first.total, 27); assert.equal(first.collisions.length, 25); assert.equal(first.collisions[0].id, 27); assert.ok(first.collisions[0].error); assert.ok(first.collisions[1].error); assert.equal(first.collisions[2].photoCount, 1);
  assert.equal('incomingPhotosJson' in first.collisions[2], false);
  const last = await readDashboardCollisions(db, 999); collisionPageView(json(last)); assert.equal(last.page, 2); assert.deepEqual(last.collisions.map(row => row.id), [2, 1]);
  assert.equal(await db.collision.count({ where: { status: 'pending' } }), 27);
});

test('problem pagination puts older critical failures ahead of warnings and preserves stable ties and unknown types', async t => {
  const { db } = await fixture(t);
  await db.problemLog.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ id: index + 1, type: index === 0 ? 'UNREADABLE_FILE' : index === 1 ? 'UNKNOWN_FUTURE_TYPE' : 'GROUPING_UNCERTAIN', createdAt: new Date(index ? '2026-09-20' : '2026-01-01') })) });
  await db.problemLog.createMany({ data: [{ type: 'SKU_SEQUENCE_INFO' }, { type: 'SOLD_STILL_LISTED' }, { type: 'UNREADABLE_FILE', resolved: true }] });
  const pages = await Promise.all([1, 2, 3].map(page => readDashboardProblems(db, page)));
  for (const page of pages) problemPageView(json(page));
  assert.deepEqual(pages.map(page => page.problems.length), [50, 50, 6]); assert.equal(pages[0].total, 106);
  assert.equal(pages[0].problems[0].id, 1); assert.equal(pages[0].problems[1].id, 105);
  assert.equal(new Set(pages.flatMap(page => page.problems.map(row => row.id))).size, 106);
  assert.equal(pages[2].problems.at(-1)?.type, 'SKU_SEQUENCE_INFO');
});

test('dismissal receipts identify the request, preserve retired issues and only count newly closed active problems', async t => {
  const { db } = await fixture(t);
  const active = await db.problemLog.create({ data: { type: 'UNREADABLE_FILE' } });
  const retired = await db.problemLog.create({ data: { type: 'SOLD_STILL_LISTED' } });
  const result = await dismissDashboardProblems(db, { id: active.id }); dismissalResult(result, active.id); assert.equal(result.resolved, 1);
  assert.equal((await dismissDashboardProblems(db, { id: active.id })).resolved, 0);
  assert.equal((await dismissDashboardProblems(db, { id: retired.id })).resolved, 0);
  await db.problemLog.createMany({ data: [{ type: 'GROUPING_UNCERTAIN' }, { type: 'UNREADABLE_FILE' }] });
  const all = await dismissDashboardProblems(db, { all: true }); dismissalResult(all, null); assert.equal(all.resolved, 2);
  assert.equal((await db.problemLog.findUniqueOrThrow({ where: { id: retired.id } })).resolved, false);
  for (const input of [null, {}, { id: '1' }, { id: 0 }, { all: true, id: active.id }, { all: false, id: active.id }]) await assert.rejects(dismissDashboardProblems(db, input));
  assert.throws(() => dismissalResult({ ok: true, resolved: 1 }, active.id));
  assert.throws(() => dismissalResult({ ...result, requestedId: retired.id }, active.id));
});

test('read failures propagate rather than returning empty queues; incomplete views and invalid pages are rejected', async () => {
  const db = { $transaction: async () => { throw Error('Fixture database unavailable'); } } as never;
  await assert.rejects(readDashboardStats(db, { incomingPath: os.tmpdir(), publish: {} } as never), /unavailable/);
  await assert.rejects(readDashboardCollisions(db), /unavailable/); await assert.rejects(readDashboardProblems(db), /unavailable/);
  for (const input of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992']) assert.throws(() => dashboardPage(input));
  assert.equal(dashboardPage(null), 1); assert.equal(dashboardPage('2'), 2);
  for (const validate of [dashboardStatsView, collisionPageView, problemPageView]) assert.throws(() => validate({}));
  assert.throws(() => problemPageView({ total: 1, page: 1, pages: 1, pageSize: 50, problems: [] }));
});

test('failed bulk dismissal rolls back every problem update', async t => {
  const { db } = await fixture(t);
  await db.problemLog.createMany({ data: [{ type: 'UNREADABLE_FILE' }, { type: 'GROUPING_UNCERTAIN' }] });
  await db.$executeRawUnsafe("CREATE TRIGGER fixture_stop_dismiss BEFORE UPDATE OF resolved ON ProblemLog WHEN NEW.resolved=1 AND OLD.type='GROUPING_UNCERTAIN' BEGIN SELECT RAISE(ABORT, 'fixture dismissal failure'); END");
  await assert.rejects(dismissDashboardProblems(db, { all: true }));
  assert.equal(await db.problemLog.count({ where: { resolved: false } }), 2);
});

test('stock values count active unsold items once and preserve partial, missing and explicit zero inputs',async t=>{
  const {db,root}=await fixture(t);
  await db.item.createMany({data:[
    {sku:'A',status:'Listed',itemCost:4.5,listedPrice:20},
    {sku:'B',status:'Photographed',itemCost:0,listedPrice:0},
    {sku:'C',status:'Needs Info'},
    {sku:'D',status:'Problem',itemCost:3,listedPrice:30},
    {sku:'E',status:'Sold',itemCost:99,listedPrice:199},
    {sku:'F',status:'Archived',itemCost:99,listedPrice:199},
    {sku:'G',status:'Removed',itemCost:99,listedPrice:199},
    {sku:'H',status:'Ready',itemCost:-1,listedPrice:-2},
  ]});
  const before=await db.item.findMany(),result=await readDashboardStats(db,{incomingPath:root,publish:{}} as never);
  assert.deepEqual(result.stockValue,{activeItems:5,cost:{knownTotal:7.5,recorded:3,missing:2},asking:{knownTotal:50,recorded:3,missing:2}});
  dashboardStatsView(result);assert.deepEqual(await db.item.findMany(),before);
  for(const mutate of [(v:any)=>{v.stockValue.cost.missing=0;},(v:any)=>{v.stockValue.activeItems=8;},(v:any)=>{v.stockValue.cost.knownTotal=NaN;}]){
    const bad=structuredClone(result);mutate(bad);assert.throws(()=>dashboardStatsView(bad));
  }
});

test('an entirely unpriced inventory reports unknown value, an empty inventory reports zero, and 20k stock reads stay compact',async t=>{
  const {db,root}=await fixture(t),settings={incomingPath:root,publish:{}} as never;
  let stats=await readDashboardStats(db,settings);assert.equal(stats.stockValue.cost.knownTotal,0);dashboardStatsView(stats);
  await db.item.create({data:{sku:'UNKNOWN'}});stats=await readDashboardStats(db,settings);
  assert.equal(stats.stockValue.cost.knownTotal,null);assert.equal(stats.stockValue.asking.knownTotal,null);dashboardStatsView(stats);
  const bad=structuredClone(stats);bad.stockValue.cost.knownTotal=0;assert.throws(()=>dashboardStatsView(bad));
  for(let start=1;start<20000;start+=500)await db.item.createMany({data:Array.from({length:Math.min(500,20000-start)},(_,i)=>({sku:`VALUE-${start+i}`,itemCost:2.25,listedPrice:10.5}))});
  const start=performance.now();stats=await readDashboardStats(db,settings);const ms=performance.now()-start;
  assert.equal(stats.stockValue.activeItems,20000);assert.equal(stats.stockValue.cost.knownTotal,19999*2.25);assert.equal(stats.stockValue.asking.knownTotal,19999*10.5);
  assert.equal(stats.stockValue.cost.missing,1);assert.ok(Buffer.byteLength(JSON.stringify(stats))<2500);dashboardStatsView(stats);
  t.diagnostic(`20k inventory valuation: ${ms.toFixed(1)}ms, ${Buffer.byteLength(JSON.stringify(stats))} bytes`);
});

test('twenty-thousand-problem backlog returns bounded first and last pages with unchanged records', async t => {
  const { db } = await fixture(t);
  for (let start = 0; start < 20000; start += 500) await db.problemLog.createMany({ data: Array.from({ length: 500 }, (_, index) => ({ type: (start + index) % 100 === 0 ? 'UNREADABLE_FILE' : 'GROUPING_UNCERTAIN', sku: String(start + index), message: 'Fixture issue' })) });
  const started = Date.now(); const first = await readDashboardProblems(db), last = await readDashboardProblems(db, 400);
  assert.equal(first.total, 20000); assert.equal(first.problems.length, 50); assert.equal(last.problems.length, 50); assert.equal(last.page, 400);
  assert.ok(first.problems.every(row => row.type === 'UNREADABLE_FILE')); assert.equal(await db.problemLog.count({ where: { resolved: false } }), 20000);
  const bytes = Buffer.byteLength(JSON.stringify(first)); assert.ok(bytes < 20000); t.diagnostic(`20k problems: first/last ${Date.now() - started}ms, ${bytes} bytes in first page`);
  for (let start = 0; start < 20000; start += 500) await db.collision.createMany({ data: Array.from({ length: 500 }, (_, index) => ({ sku: String(start + index), incomingPhotosJson: '[{"storedPath":"C:/fixture/photo.jpg"}]' })) });
  const groupStart = Date.now(), firstGroups = await readDashboardCollisions(db), lastGroups = await readDashboardCollisions(db, 800);
  assert.equal(firstGroups.total, 20000); assert.equal(firstGroups.collisions.length, 25); assert.equal(lastGroups.page, 800); assert.equal(lastGroups.collisions.length, 25);
  assert.equal(await db.collision.count({ where: { status: 'pending' } }), 20000);
  t.diagnostic(`20k photo groups: first/last ${Date.now() - groupStart}ms, ${Buffer.byteLength(JSON.stringify(firstGroups))} bytes in first page`);
});
