import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { checkDirectUploadOverlap, checkExistingUploadState, directUploadState, republicationBlockReason } from "./listingGuards.ts";

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-overlap-"));
  const database = path.join(dir, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), database);
  const db = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    await db.$disconnect();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const item = await db.item.create({ data: { sku: "OVERLAP-TEST", status: "Ready for Nifty" } });
  return { db, item };
}

test("existing listing checks preserve publication and uncertainty barriers", async (t) => {
  const { db, item } = await fixture(t);
  assert.equal(await checkExistingUploadState(db, item.id), null);
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "depop", status: "unknown" } });
  assert.match((await checkExistingUploadState(db, item.id))!, /verification/);
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: "published" } });
  const state = await db.item.findUniqueOrThrow({ where: { id: item.id }, include: directUploadState });
  assert.match(republicationBlockReason(state)!, /duplicate/);
  assert.equal(republicationBlockReason(state), await checkExistingUploadState(db, item.id));
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: "ended" } });
  assert.equal(await checkExistingUploadState(db, item.id), null);
});

test("paused jobs reserve the item until publication uncertainty is resolved", async (t) => {
  const { db, item } = await fixture(t);
  const run = await db.publishRun.create({ data: { status: "paused", marketplacesJson: '["ebay"]', totalJobs: 1 } });
  const job = await db.publishJob.create({ data: { itemId: item.id, runId: run.id, marketplace: "ebay", status: "queued" } });
  assert.match((await checkExistingUploadState(db, item.id))!, /pending/);
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "ebay", status: "unknown" } });
  await db.publishJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  assert.match((await checkExistingUploadState(db, item.id))!, /verification/);
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: "not_published" } });
  assert.equal(await checkExistingUploadState(db, item.id), null);
});

test("fresh imported-status checks keep sold items out of publishing", async (t) => {
  const { db, item } = await fixture(t);
  assert.equal(await checkDirectUploadOverlap(db, item.id), null);
  await db.item.update({ where: { id: item.id }, data: { niftyStatus: "Uploading" } });
  assert.match((await checkDirectUploadOverlap(db, item.id))!, /imported/);
  await db.item.update({ where: { id: item.id }, data: { status: "Sold" } });
  assert.match((await checkDirectUploadOverlap(db, item.id, true))!, /no longer approved/);
});
