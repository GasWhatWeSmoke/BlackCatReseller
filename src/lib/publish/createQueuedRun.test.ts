import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createQueuedRun } from "./createQueuedRun.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-create-batch-"));
  const database = path.join(root, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), database);
  const db = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const item = await db.item.create({ data: { sku: "BATCH-TEST", status: "Ready for Nifty", trueVintage: true } });
  return { db, item };
}

test("a repeated item or platform produces one job per marketplace", async t => {
  const { db, item } = await fixture(t);
  const result = await createQueuedRun(db, [item.id, item.id], ["depop", "ebay", "etsy", "poshmark", "ebay"]);
  assert.equal(result.ok, true); assert.equal(result.jobs, 4);
  assert.equal(await db.publishJob.count(), 4);
  assert.equal((await db.publishRun.findFirstOrThrow()).totalJobs, 4);
});

test("job-save failure rolls back the run too", async t => {
  const { db, item } = await fixture(t);
  await db.$executeRawUnsafe("CREATE TRIGGER fail_jobs BEFORE INSERT ON PublishJob BEGIN SELECT RAISE(ABORT, 'injected job failure'); END");
  await assert.rejects(createQueuedRun(db, [item.id], ["depop"]));
  assert.equal(await db.publishRun.count(), 0); assert.equal(await db.publishJob.count(), 0);
});

test("paused uploads block a second batch until the first is handled", async t => {
  const { db, item } = await fixture(t);
  await db.publishRun.create({ data: { status: "paused", totalJobs: 0, marketplacesJson: '["depop"]' } });
  const result = await createQueuedRun(db, [item.id], ["depop"]);
  assert.equal(result.ok, false); assert.match(result.error!, /already active/);
  assert.equal(await db.publishRun.count(), 1); assert.equal(await db.publishJob.count(), 0);
});

test("a sold or missing selection cannot create any part of a batch", async t => {
  const { db, item } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { status: "Sold" } });
  for (const ids of [[item.id], [item.id + 100], [-1]]) assert.equal((await createQueuedRun(db, ids, ["depop"])).ok, false);
  assert.equal(await db.publishRun.count(), 0); assert.equal(await db.publishJob.count(), 0);
});

test("unknown publication outcomes stay blocked while other selected platforms can queue", async t => {
  const { db, item } = await fixture(t);
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "ebay", status: "unknown" } });
  const result = await createQueuedRun(db, [item.id], ["ebay", "depop"]);
  assert.equal(result.jobs, 1); assert.equal(result.skipped?.[0].marketplace, "ebay");
  assert.equal((await db.publishJob.findFirstOrThrow()).marketplace, "depop");
});

test("non-vintage pieces skip Etsy while keeping their eligible platforms", async t => {
  const {db,item}=await fixture(t);
  await db.item.update({where:{id:item.id},data:{trueVintage:false,status:"Ready"}});
  const result=await createQueuedRun(db,[item.id],["ebay","etsy"]);
  assert.equal(result.jobs,1);
  assert.equal((await db.publishJob.findFirstOrThrow()).marketplace,"ebay");
  assert.equal(result.skipped?.[0].marketplace,"etsy");
});
