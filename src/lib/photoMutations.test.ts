import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { editPhoto, removePhoto, PhotoChangeError } from "./photoMutations.ts";
import { deleteItem } from "./itemDelete.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-photo-edit-"));
  const file = path.join(root, "test.db"); fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-photo-edit-")); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { processingPath: path.join(root, "processing"), readyPath: path.join(root, "ready"),
    needsReviewPath: path.join(root, "review"), archivePath: path.join(root, "archive"), incomingPath: path.join(root, "incoming") };
  for (const folder of Object.values(settings)) fs.mkdirSync(folder);
  const source = await db.item.create({ data: { sku: "SOURCE", photoCount: 2 } });
  const target = await db.item.create({ data: { sku: "TARGET", photoCount: 1 } });
  async function photo(itemId: number, name: string, sortOrder: number, isCover: boolean, isMarker = false) {
    const storedPath = path.join(settings.processingPath, name); fs.writeFileSync(storedPath, name);
    const thumbPath = storedPath + ".thumb.jpg"; fs.writeFileSync(thumbPath, "thumb " + name);
    const row = await db.photo.create({ data: { itemId, storedPath, thumbPath, originalFilename: name, sha256: name,
      sortOrder, isCover, isMarker, includeInListing: !isMarker } });
    await db.fileHash.create({ data: { sha256: name, processedPath: storedPath, originalFilename: name } });
    return row;
  }
  const first = await photo(source.id, "first.jpg", 0, true), second = await photo(source.id, "second.jpg", 1, false);
  const marker = await photo(source.id, "marker.jpg", 999, false, true), targetCover = await photo(target.id, "target.jpg", 0, true);
  const original = path.join(settings.archivePath, "original.jpg"); fs.writeFileSync(original, "original");
  return { root, db, settings, source, target, first, second, marker, targetCover, original };
}

test("photo deletion commits rows/count/cover together and retains archived originals", async t => {
  const f = await fixture(t);
  const result = await removePhoto(f.db, f.first.id, { expectedItemId: f.source.id }, f.settings);
  assert.equal(result.ok, true); assert.deepEqual(result.cleanupWarnings, []);
  assert.equal(await f.db.photo.findUnique({ where: { id: f.first.id } }), null);
  assert.equal(await f.db.fileHash.count({ where: { sha256: f.first.sha256 } }), 0);
  assert.equal(fs.existsSync(f.first.storedPath), false); assert.equal(fs.existsSync(f.first.thumbPath!), false);
  assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.source.id } })).photoCount, 1);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.second.id } })).isCover, true);
  assert.equal(fs.readFileSync(f.original, "utf8"), "original");
});

test("a failed deletion or recount leaves photo bytes and dedup records intact", async t => {
  const f = await fixture(t);
  for (const target of ["Photo", "Item"]) {
    await f.db.$executeRawUnsafe(`CREATE TRIGGER prevent_change BEFORE ${target === "Photo" ? "DELETE" : "UPDATE"} ON ${target} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    await assert.rejects(removePhoto(f.db, f.first.id, {}, f.settings));
    assert.equal(await f.db.photo.count({ where: { id: f.first.id } }), 1);
    assert.equal(await f.db.fileHash.count({ where: { sha256: f.first.sha256 } }), 1);
    assert.equal(fs.readFileSync(f.first.storedPath, "utf8"), "first.jpg");
    assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.source.id } })).photoCount, 2);
    await f.db.$executeRawUnsafe("DROP TRIGGER prevent_change");
  }
});

test("a failed cover change restores the previous cover", async t => {
  const f = await fixture(t);
  await f.db.$executeRawUnsafe(`CREATE TRIGGER prevent_cover BEFORE UPDATE ON Photo WHEN NEW.id=${f.second.id} AND NEW.isCover=1 BEGIN SELECT RAISE(ABORT,'injected cover failure'); END`);
  await assert.rejects(editPhoto(f.db, f.second.id, { isCover: true, expectedItemId: f.source.id }));
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.first.id } })).isCover, true);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.second.id } })).isCover, false);
});

test("setting an excluded photo as cover includes it; exclusion recovers another cover", async t => {
  const f = await fixture(t);
  await editPhoto(f.db, f.second.id, { includeInListing: false });
  const chosen = await editPhoto(f.db, f.second.id, { isCover: true });
  assert.equal(chosen.photo.includeInListing, true); assert.equal(chosen.photo.isCover, true);
  assert.equal(chosen.items[0].photoCount, 2);
  const excluded = await editPhoto(f.db, f.second.id, { includeInListing: false });
  assert.equal(excluded.photo.isCover, false); assert.equal(excluded.items[0].photoCount, 1);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.first.id } })).isCover, true);
});

test("reassignment changes covers and counts on the actual source and destination atomically", async t => {
  const f = await fixture(t);
  await editPhoto(f.db, f.first.id, { itemId: f.target.id, isCover: true, expectedItemId: f.source.id });
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.targetCover.id } })).isCover, false);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.second.id } })).isCover, true);
  assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.source.id } })).photoCount, 1);
  assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.target.id } })).photoCount, 2);
  await assert.rejects(editPhoto(f.db, f.first.id, { rotation: 90, expectedItemId: f.source.id }), e => e instanceof PhotoChangeError && e.status === 409);
  await assert.rejects(removePhoto(f.db, f.first.id, { expectedItemId: f.source.id }, f.settings), e => e instanceof PhotoChangeError && e.status === 409);
  assert.equal((await deleteItem(f.source.id, { store: f.db, settings: f.settings })).ok, true);
  assert.equal(fs.readFileSync(f.first.storedPath, "utf8"), "first.jpg");
});

test("reordering is one transaction and refuses stale or foreign selections", async t => {
  const f = await fixture(t);
  const change = { photoOrder: [f.second.id, f.first.id], expectedOrder: [f.first.id, f.second.id], expectedItemId: f.source.id };
  await f.db.$executeRawUnsafe(`CREATE TRIGGER prevent_reorder BEFORE UPDATE ON Photo WHEN NEW.id=${f.first.id} AND NEW.sortOrder=1 BEGIN SELECT RAISE(ABORT,'injected reorder failure'); END`);
  await assert.rejects(editPhoto(f.db, f.first.id, change));
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.second.id } })).sortOrder, 1);
  await f.db.$executeRawUnsafe("DROP TRIGGER prevent_reorder");
  const result = await editPhoto(f.db, f.first.id, change);
  assert.deepEqual(result.items[0].photos.filter(p => !p.isMarker).map(p => p.id), change.photoOrder);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.marker.id } })).sortOrder, 999);
  await assert.rejects(editPhoto(f.db, f.first.id, change), e => e instanceof PhotoChangeError && e.status === 409);
  await assert.rejects(editPhoto(f.db, f.first.id, { ...change, expectedOrder: change.photoOrder, photoOrder: [f.first.id, f.targetCover.id] }), e => e instanceof PhotoChangeError && e.status === 400);
});

test("invalid photo changes cannot clear covers or partially move a photo", async t => {
  const f = await fixture(t); const before = await f.db.photo.findMany({ orderBy: { id: "asc" } });
  for (const input of [null, [], {}, { rotation: 45 }, { rotation: "90" }, { includeInListing: "false" },
    { sortOrder: -1 }, { isCover: true, includeInListing: false }, { itemId: 999999, isCover: true }, { unknown: true }]) {
    await assert.rejects(editPhoto(f.db, f.first.id, input), PhotoChangeError);
  }
  await assert.rejects(editPhoto(f.db, f.marker.id, { isCover: true }), PhotoChangeError);
  assert.deepEqual(await f.db.photo.findMany({ orderBy: { id: "asc" } }), before);
  assert.equal((await editPhoto(f.db, f.first.id, { rotation: -90 })).photo.rotation, 270);
});

test("shared files/hashes and pending collision references survive photo removal", async t => {
  const f = await fixture(t);
  await f.db.photo.create({ data: { itemId: f.target.id, originalFilename: "shared.jpg", sha256: f.first.sha256,
    storedPath: process.platform === "win32" ? f.first.storedPath.toUpperCase() : f.first.storedPath } });
  await removePhoto(f.db, f.first.id, {}, f.settings);
  assert.equal(fs.readFileSync(f.first.storedPath, "utf8"), "first.jpg");
  assert.equal(await f.db.fileHash.count({ where: { sha256: f.first.sha256 } }), 1);
  await f.db.collision.create({ data: { sku: "PENDING", incomingPhotosJson: JSON.stringify([f.second]) } });
  await removePhoto(f.db, f.second.id, {}, f.settings);
  assert.equal(fs.readFileSync(f.second.storedPath, "utf8"), "second.jpg");
  assert.equal(await f.db.fileHash.count({ where: { sha256: f.second.sha256 } }), 1);
});

test("archive paths and replacement file contents cannot be removed by cleanup", async t => {
  const f = await fixture(t);
  await f.db.photo.update({ where: { id: f.first.id }, data: { storedPath: f.original } });
  assert.ok((await removePhoto(f.db, f.first.id, {}, f.settings)).cleanupWarnings.length);
  assert.equal(fs.readFileSync(f.original, "utf8"), "original");
  let calls = 0;
  const store = { $transaction: async (action: Parameters<PrismaClient["$transaction"]>[0]) => {
    const result = await f.db.$transaction(action as never);
    if (++calls === 1) fs.writeFileSync(f.second.storedPath, "replacement after database commit");
    return result;
  } } as Pick<PrismaClient, "$transaction">;
  assert.ok((await removePhoto(store, f.second.id, {}, f.settings)).cleanupWarnings.length);
  assert.equal(fs.readFileSync(f.second.storedPath, "utf8"), "replacement after database commit");
});

test("a retained dedup record never points at a file erased by photo cleanup", async t => {
  const f = await fixture(t);
  const copy = path.join(f.settings.processingPath, "another-copy.jpg"); fs.copyFileSync(f.first.storedPath, copy);
  await f.db.photo.create({ data: { itemId: f.target.id, originalFilename: "another-copy.jpg", storedPath: copy, sha256: f.first.sha256 } });
  await removePhoto(f.db, f.first.id, {}, f.settings);
  const retained = await f.db.fileHash.findUniqueOrThrow({ where: { sha256: f.first.sha256 } });
  assert.equal(fs.existsSync(retained.processedPath!), true);
  assert.equal(fs.readFileSync(copy, "utf8"), "first.jpg");
});

test("an unreadable pending photo group rolls back deletion instead of guessing ownership", async t => {
  const f = await fixture(t);
  await f.db.collision.create({ data: { sku: "BROKEN", incomingPhotosJson: "not JSON" } });
  await assert.rejects(removePhoto(f.db, f.first.id, {}, f.settings));
  assert.equal(await f.db.photo.count({ where: { id: f.first.id } }), 1);
  assert.equal(fs.existsSync(f.first.storedPath), true);
  assert.equal(await f.db.fileHash.count({ where: { sha256: f.first.sha256 } }), 1);
});
