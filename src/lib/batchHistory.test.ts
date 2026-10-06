import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { clearBatchHistory } from "./batchHistory.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-history-"));
  const file = path.join(root, "test.db");
  fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    await db.$disconnect();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-history-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await db.batch.create({ data: { name: "First" } });
  const second = await db.batch.create({ data: { name: "Second" } });
  const image = path.join(root, "photo.jpg"); fs.writeFileSync(image, "owned fixture photo");
  const item = await db.item.create({ data: { sku: "HISTORY", status: "Sold", salePrice: 17, itemCost: 5, batchId: first.id } });
  const photo = await db.photo.create({ data: { itemId: item.id, storedPath: image, originalFilename: "photo.jpg",
    sha256: createHash("sha256").update(fs.readFileSync(image)).digest("hex") } });
  for (const batchId of [first.id, second.id]) {
    await db.collision.create({ data: { batchId, sku: `PENDING-${batchId}`, incomingPhotosJson: JSON.stringify([{ storedPath: image }]) } });
    await db.problemLog.create({ data: { batchId, type: "OPEN", resolved: false } });
    await db.problemLog.create({ data: { batchId, type: "HISTORY", resolved: true } });
  }
  await db.collision.create({ data: { batchId: first.id, sku: "RESOLVED", status: "resolved", incomingPhotosJson: "[]" } });
  await db.collision.create({ data: { batchId: 999999, sku: "OLD-DANGLING", incomingPhotosJson: "[]" } });
  await db.problemLog.create({ data: { type: "GLOBAL-OPEN", resolved: false } });
  await db.problemLog.create({ data: { type: "GLOBAL-RESOLVED", resolved: true } });
  return { db, first, second, item, photo, image };
}

test("single history deletion retains pending groups and open issues without touching inventory", async t => {
  const { db, first, second, item, photo, image } = await fixture(t);
  const original = await db.collision.findFirstOrThrow({ where: { batchId: first.id, status: "pending" } });
  assert.deepEqual(await clearBatchHistory(db, first.id), { ok: true, batchesDeleted: 1, pendingGroupsKept: 1, openIssuesKept: 1 });
  assert.deepEqual(await db.collision.findUnique({ where: { id: original.id } }), { ...original, batchId: null });
  assert.equal(await db.problemLog.count({ where: { type: "OPEN", batchId: null } }), 1);
  assert.equal(await db.problemLog.count({ where: { batchId: first.id } }), 0);
  assert.equal(await db.problemLog.count({ where: { batchId: second.id } }), 2);
  assert.equal(await db.problemLog.count({ where: { type: { startsWith: "GLOBAL" } } }), 2);
  assert.deepEqual(await db.item.findUnique({ where: { id: item.id } }), { ...item, batchId: null });
  assert.deepEqual(await db.photo.findUnique({ where: { id: photo.id } }), photo);
  assert.equal(fs.readFileSync(image, "utf8"), "owned fixture photo");
});

test("all-history cleanup detaches orphan group IDs and preserves unrelated problem logs", async t => {
  const { db, image } = await fixture(t);
  assert.deepEqual(await clearBatchHistory(db), { ok: true, batchesDeleted: 2, pendingGroupsKept: 3, openIssuesKept: 2 });
  assert.equal(await db.batch.count(), 0);
  assert.equal(await db.collision.count(), 4);
  assert.equal(await db.collision.count({ where: { batchId: { not: null } } }), 0);
  assert.equal(await db.problemLog.count({ where: { resolved: false } }), 3);
  assert.equal(await db.problemLog.count({ where: { type: "GLOBAL-RESOLVED" } }), 1);
  assert.equal(await db.problemLog.count({ where: { type: "HISTORY" } }), 0);
  assert.equal(fs.readFileSync(image, "utf8"), "owned fixture photo");
});

test("a failed batch delete rolls back all metadata cleanup", async t => {
  const { db, first } = await fixture(t);
  const groups = await db.collision.findMany({ orderBy: { id: "asc" } });
  const problems = await db.problemLog.findMany({ orderBy: { id: "asc" } });
  const items = await db.item.findMany();
  await db.$executeRawUnsafe("CREATE TRIGGER prevent_history_delete BEFORE DELETE ON Batch BEGIN SELECT RAISE(ABORT,'injected history failure'); END");
  await assert.rejects(clearBatchHistory(db, first.id));
  assert.deepEqual(await db.collision.findMany({ orderBy: { id: "asc" } }), groups);
  assert.deepEqual(await db.problemLog.findMany({ orderBy: { id: "asc" } }), problems);
  assert.deepEqual(await db.item.findMany(), items);
  assert.equal(await db.batch.count(), 2);
});

test("missing and invalid batch IDs leave all history intact", async t => {
  const { db } = await fixture(t);
  assert.deepEqual(await clearBatchHistory(db, 999999), { ok: false, error: "Batch not found." });
  for (const id of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(clearBatchHistory(db, id), /Invalid batch ID/);
  }
  assert.equal(await db.batch.count(), 2);
  assert.equal(await db.collision.count(), 4);
  assert.equal(await db.problemLog.count(), 6);
});
