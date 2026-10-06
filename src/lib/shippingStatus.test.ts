import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { readShippingCount } from './shippingStatus.ts';
import { shippingCount } from './shipQueue.ts';

test('shipping count includes only sold, unshipped inventory and never modifies sale history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-shipping-count-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll('\\', '/')}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-shipping-count-')); fs.rmSync(root, { recursive: true, force: true }); });
  await db.item.createMany({ data: [
    { sku: 'UNSHIPPED', status: 'Sold', shippedAt: null },
    { sku: 'SHIPPED', status: 'Sold', shippedAt: new Date('2026-09-20') },
    { sku: 'READY', status: 'Ready' }, { sku: 'RETURNED', status: 'Needs Info' }, { sku: 'ARCHIVED', status: 'Archived' },
  ] });
  const before = await db.item.findMany();
  assert.deepEqual(await readShippingCount(db), { count: 1 });
  assert.deepEqual(await db.item.findMany(), before);
  await db.item.update({ where: { sku: 'UNSHIPPED' }, data: { shippedAt: new Date('2026-09-20') } });
  assert.deepEqual(await readShippingCount(db), { count: 0 });
});

test('unavailable data and malformed counts cannot look like an empty shipping queue', async () => {
  await assert.rejects(readShippingCount({ item: { count: async () => { throw Error('Fixture database unavailable'); } } } as never), /unavailable/);
  for (const value of [null, {}, { count: -1 }, { count: 0.5 }, { count: '3' }, { count: null }, { count: Infinity }, { count: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => shippingCount(value));
  assert.deepEqual(shippingCount({ count: 0 }), { count: 0 }); assert.deepEqual(shippingCount({ count: 20000 }), { count: 20000 });
});
