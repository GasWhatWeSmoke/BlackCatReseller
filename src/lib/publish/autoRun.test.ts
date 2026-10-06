import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { configureAutoRun, createAutoRunController, readAutoRun, selectAutoBatch } from "./autoRun.ts";
import { createQueuedRun } from "./createQueuedRun.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-auto-run-"));
  const file = path.join(root, "test.db"); fs.copyFileSync(path.resolve("config/template.db"), file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: "AUTO-TEST", status: "Ready for Nifty" } });
  return { db, item };
}
test("Auto Run is off by default and groups compatible platforms in bounded batches", () => {
  assert.equal(readAutoRun().enabled, false);
  const batch = selectAutoBatch([{ id: 1, marketplaces: [] }, { id: 2, marketplaces: ["depop","ebay"] }, { id: 3, marketplaces: ["ebay","depop"] }, { id: 4, marketplaces: ["etsy"] }]);
  assert.deepEqual(batch?.itemIds, [2,3]);
  assert.equal(selectAutoBatch(Array.from({ length: 100 }, (_, id) => ({ id, marketplaces: ['depop'] })))?.itemIds.length, 25);
});
test("newly approved pieces are picked up on a later tick without another Start click", async () => {
  let ready = false, calls = 0, active: { id: number; status: string } | null = null;
  const controller = createAutoRunController({ config: async () => ({ enabled: true, marketplaces: ['depop'] }),
    activeRun: async () => active, batch: async () => ({ needsAttention: 0, batch: ready ? { itemIds: [1], marketplaces: ['depop'] } : null }),
    queue: async () => { calls++; active = { id: 7, status: 'running' }; return { ok: true, runId: 7 }; } });
  await controller.tick(); assert.equal(controller.snapshot().state, 'waiting');
  ready = true; await controller.tick(); await controller.tick(); assert.equal(calls, 1);
  active = { id: 7, status: 'paused' }; await controller.tick(); assert.equal(controller.snapshot().state, 'paused');
});
test("switching off while checking prevents the next automatic batch", async () => {
  let enabled = true;
  const controller = createAutoRunController({ config: async () => ({ enabled, marketplaces: ['depop'] }), activeRun: async () => null,
    batch: async () => { enabled = false; return { needsAttention: 0, batch: { itemIds: [1], marketplaces: ['depop'] } }; },
    queue: async () => { throw new Error('must not queue'); } });
  await controller.tick(); assert.equal(controller.snapshot().state, 'off'); assert.equal(controller.snapshot().error, null);
});
test("overlapping timer ticks cannot start two runs", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { entered = resolve; });
  let queued = 0;
  const controller = createAutoRunController({ config: async () => ({ enabled: true, marketplaces: ['depop'] }), activeRun: async () => null,
    batch: async () => { entered(); await gate; return { needsAttention: 0, batch: { itemIds: [1], marketplaces: ['depop'] } }; },
    queue: async () => { queued++; return { ok: true, runId: 1 }; } });
  const first = controller.tick(); await began; await controller.tick(); release(); await first;
  assert.equal(queued, 1);
});
test("automatic reservations recheck settings, preserve history, and pause/resume through the switch", async t => {
  const { db, item } = await fixture(t);
  assert.equal((await createQueuedRun(db, [item.id], ['depop'], true)).ok, false);
  await configureAutoRun(db, true, ['depop']);
  const first = await createQueuedRun(db, [item.id], ['depop'], true); assert.equal(first.ok, true);
  const off = await configureAutoRun(db, false, ['depop']); assert.equal(off.pausedRunId, first.runId);
  assert.equal((await db.publishRun.findUniqueOrThrow({ where: { id: first.runId } })).status, 'paused');
  await configureAutoRun(db, true, ['depop']);
  assert.equal((await db.publishRun.findUniqueOrThrow({ where: { id: first.runId } })).status, 'running');
  await db.publishRun.update({ where: { id: first.runId }, data: { status: 'done' } });
  await db.publishJob.updateMany({ data: { status: 'failed' } });
  assert.equal((await createQueuedRun(db, [item.id], ['depop'], true)).ok, false);
  assert.equal(await db.publishRun.count(), 1);
});
test("automatic listing never adopts Nifty items or skips human approval", async t => {
  const { db, item } = await fixture(t);
  await configureAutoRun(db, true, ['depop']);
  await db.item.update({ where: { id: item.id }, data: { niftyStatus: 'Published' } });
  assert.equal((await createQueuedRun(db, [item.id], ['depop'], true)).ok, false);
  await db.item.update({ where: { id: item.id }, data: { niftyStatus: 'Not Uploaded', status: 'Photographed' } });
  assert.equal((await createQueuedRun(db, [item.id], ['depop'], true)).ok, false);
  assert.equal(await db.publishJob.count(), 0);
});
test("switching off does not pause another manually started run", async t => {
  const { db, item } = await fixture(t);
  await configureAutoRun(db, true, ['depop']);
  const manual = await createQueuedRun(db, [item.id], ['depop']);
  await configureAutoRun(db, false, ['depop']);
  assert.equal((await db.publishRun.findUniqueOrThrow({ where: { id: manual.runId } })).status, 'running');
});
