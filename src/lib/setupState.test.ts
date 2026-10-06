import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hasLinkedSetupAccount, readSetupSnapshot, setupRequest, setupChoicePatch } from './setupState.ts';
import { setupView, setupReceipt } from './setupView.ts';
import { updateSettingsRow } from './settingsStore.ts';
const observed = { incomingPathSet: true, incomingPathExists: true, incomingPath: 'C:/fixture/photos', workerInstalled: true, hasMarketplaceAccount: true, hasSecondaryDisplay: true, visionEnabled: false, visionInstalled: false };
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-setup-state-')), file = path.join(root, 'test.db');
  fs.copyFileSync('config/template.db', file);
  const options = { datasources: { db: { url: `file:${file.replaceAll('\\', '/')}` } } }, db = new PrismaClient(options), other = new PrismaClient(options);
  t.after(async () => { await Promise.all([db.$disconnect(), other.$disconnect()]); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-setup-state-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, other };
}
test('setup snapshot uses actual inventory counts and keeps optional AI out of progress', async t => {
  const { db } = await fixture(t);
  const item = await db.item.create({ data: { sku: 'SETUP', status: 'Ready' } });
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', status: 'published' } });
  const before = await db.item.findMany();
  const result = await readSetupSnapshot(db, { setupAcknowledged: ['ebay-policy'] }, observed); setupView(result);
  assert.equal(result.progress.complete, true); assert.equal(result.progress.total, 7); assert.equal(result.steps.find(step => step.id === 'vision')?.state, 'todo');
  assert.match(result.steps.find(step => step.id === 'first-batch')?.note ?? '', /1 item/); assert.deepEqual(await db.item.findMany(), before);
  const empty = await readSetupSnapshot(db, {}, { ...observed, workerInstalled: false }); assert.ok(empty.blocking.includes('worker')); assert.equal(empty.progress.complete, false);
});
test('enabled posting settings alone do not establish a locally confirmed linked account', () => {
  const settings = { publish: { ebayBrowser: { enabled: true }, depop: { enabled: false } } } as never;
  const account = { marketplace: 'ebay', loggedIn: false, awaitingConfirmation: false, loginInProgress: false };
  assert.equal(hasLinkedSetupAccount(settings, [account]), false);
  assert.equal(hasLinkedSetupAccount(settings, [{ ...account, loggedIn: true }]), true);
  assert.equal(hasLinkedSetupAccount(settings, [{ ...account, loggedIn: true, awaitingConfirmation: true }]), false);
  assert.equal(hasLinkedSetupAccount(settings, [{ ...account, loggedIn: true, loginInProgress: true }]), false);
  assert.equal(hasLinkedSetupAccount(settings, [{ ...account, marketplace: 'depop', loggedIn: true }]), false);
});
test('setup actions preserve unrelated choices and concurrent settings through the existing compare-and-swap writer', async t => {
  const { db, other } = await fixture(t);
  const baseline = { setupAcknowledged: ['legacy-choice'], setupGuideDismissed: false, marker: 'keep', publish: { autoRun: { enabled: true } } };
  await db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: JSON.stringify(baseline) }, update: { data: JSON.stringify(baseline) } });
  const apply = (store: PrismaClient, input: unknown) => updateSettingsRow(store, raw => {
    const current = JSON.parse(raw!); const next = { ...current, ...setupChoicePatch(current, setupRequest(input)) };
    return { data: JSON.stringify(next), value: next };
  });
  await Promise.all([apply(db, { acknowledge: 'ebay-policy', value: true }), apply(other, { dismissed: true })]);
  const saved = JSON.parse((await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).data);
  assert.deepEqual(saved.setupAcknowledged, ['legacy-choice', 'ebay-policy']); assert.equal(saved.setupGuideDismissed, true); assert.equal(saved.marker, 'keep'); assert.deepEqual(saved.publish, baseline.publish);
  const cleared = await apply(db, { acknowledge: 'ebay-policy', value: false }); assert.deepEqual(cleared.setupAcknowledged, ['legacy-choice']);
});
test('invalid actions and incomplete or mismatched receipts cannot count as a confirmed setup save', () => {
  for (const input of [null, {}, [], { acknowledge: 'worker', value: true }, { acknowledge: 'ebay-policy' }, { acknowledge: 'ebay-policy', value: 'true' }, { dismissed: true, extra: 1 }]) assert.throws(() => setupRequest(input));
  assert.throws(() => setupChoicePatch({ setupAcknowledged: 'broken' } as never, { acknowledge: 'ebay-policy', value: true }));
  const request = setupRequest({ dismissed: true }); setupReceipt({ ok: true, request }, request);
  for (const reply of [{ ok: true }, { ok: true, request: 1 }, { ok: true, request: { dismissed: false } }, { ok: true, request: { acknowledge: 'ebay-policy', value: true } }]) assert.throws(() => setupReceipt(reply, request));
  for (const reply of [{}, { steps: [], progress: { done: 0, total: 0, complete: true }, blocking: [], dismissed: false }]) assert.throws(() => setupView(reply));
});
test('unavailable setup data propagates an error and a failed settings write leaves the prior choices intact', async t => {
  await assert.rejects(readSetupSnapshot({ $transaction: async () => { throw Error('Fixture data unavailable'); } } as never, {}, observed), /unavailable/);
  const { db } = await fixture(t);
  await db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: '{}' }, update: { data: '{}' } });
  await db.$executeRawUnsafe("CREATE TRIGGER fixture_setup_stop BEFORE UPDATE ON AppSettings BEGIN SELECT RAISE(ABORT, 'fixture setup failure'); END");
  await assert.rejects(updateSettingsRow(db, () => ({ data: '{"setupGuideDismissed":true}', value: true })));
  assert.equal((await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).data, '{}');
});
