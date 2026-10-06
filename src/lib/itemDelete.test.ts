import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { deleteItem, deleteSelectedItems } from "./itemDelete.ts";
import { itemDeleteExpectation, itemDeleteReceiptMatches, bulkDeleteReceiptMatches } from './itemDeleteSelection.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-safe-delete-"));
  const file = path.join(root, "test.db");
  fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  const settings = { processingPath: path.join(root, "processing"), readyPath: path.join(root, "ready"),
    needsReviewPath: path.join(root, "review"), archivePath: path.join(root, "archive"), incomingPath: path.join(root, "incoming") };
  for (const folder of Object.values(settings)) fs.mkdirSync(folder);
  const source = await db.item.create({ data: { sku: "SOURCE", status: "Photographed", processingFolderPath: path.join(settings.processingPath, "SOURCE") } });
  const target = await db.item.create({ data: { sku: "TARGET", status: "Photographed" } });
  fs.mkdirSync(source.processingFolderPath!);
  const image = path.join(source.processingFolderPath!, "owned.jpg");
  fs.writeFileSync(image, "working image");
  const original = path.join(settings.archivePath, "original.jpg"); fs.writeFileSync(original, "original");
  const photo = await db.photo.create({ data: { itemId: source.id, originalFilename: "owned.jpg", storedPath: image, sha256: "owned-hash", isCover: true } });
  await db.fileHash.create({ data: { sha256: "owned-hash", originalFilename: "owned.jpg", processedPath: image, sku: source.sku } });
  t.after(async () => {
    await db.$disconnect();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-safe-delete-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db, settings, source, target, image, original, photo, opts: { store: db, settings } };
}

test("deleting the source of moved or split photos preserves the other item's files", async t => {
  const { db, source, target, image, original, opts } = await fixture(t);
  const moved = path.join(source.processingFolderPath!, "moved.jpg"); fs.writeFileSync(moved, "moved image");
  await db.photo.create({ data: { itemId: target.id, originalFilename: "moved.jpg", storedPath: moved, sha256: "moved-hash" } });
  await db.fileHash.create({ data: { sha256: "moved-hash", originalFilename: "moved.jpg", processedPath: moved, sku: source.sku } });
  assert.equal((await deleteItem(source.id, opts)).ok, true);
  assert.equal(fs.existsSync(image), false);
  assert.equal(fs.readFileSync(moved, "utf8"), "moved image");
  assert.equal(fs.readFileSync(original, "utf8"), "original");
  assert.equal(await db.photo.count({ where: { itemId: target.id } }), 1);
  assert.equal(await db.fileHash.count({ where: { sha256: "moved-hash" } }), 1);
});

test("active and unresolved marketplace links cannot be erased, even with force", async t => {
  const { db, source, image, opts } = await fixture(t);
  const listing = await db.marketplaceListing.create({ data: { itemId: source.id, marketplace: "depop", externalListingId: "seller-shirt", externalUrl: "https://www.depop.com/products/seller-shirt/" } });
  for (const status of ["published", "unknown", "delist_pending", "delisting", "delist_unknown", "delist_failed"]) {
    await db.marketplaceListing.update({ where: { id: listing.id }, data: { status } });
    const result = await deleteItem(source.id, { ...opts, force: true });
    assert.equal(result.code, "LIVE_LISTINGS", status);
    assert.equal(await db.photo.count({ where: { itemId: source.id } }), 1);
    assert.equal(fs.existsSync(image), true);
  }
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: "ended" } });
  assert.equal((await deleteItem(source.id, opts)).ok, true);
});

test("pending publishing work must be cancelled before deletion", async t => {
  const { db, source, opts } = await fixture(t);
  const run = await db.publishRun.create({ data: { marketplacesJson: '["depop"]' } });
  const job = await db.publishJob.create({ data: { runId: run.id, itemId: source.id, marketplace: "depop" } });
  for (const status of ["queued", "retrying", "publishing"]) {
    await db.publishJob.update({ where: { id: job.id }, data: { status } });
    assert.equal((await deleteItem(source.id, opts)).code, "PUBLISH_IN_PROGRESS");
  }
  await db.publishJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  assert.equal((await deleteItem(source.id, opts)).ok, true);
});

test("a failed item deletion rolls back photos and dedup records and leaves files intact", async t => {
  const { db, source, image, opts } = await fixture(t);
  await db.$executeRawUnsafe("CREATE TRIGGER prevent_item_delete BEFORE DELETE ON Item BEGIN SELECT RAISE(ABORT,'injected delete failure'); END");
  const result = await deleteItem(source.id, opts);
  assert.equal(result.ok, false);
  assert.equal(await db.item.count({ where: { id: source.id } }), 1);
  assert.equal(await db.photo.count({ where: { itemId: source.id } }), 1);
  assert.equal(await db.fileHash.count({ where: { sha256: "owned-hash" } }), 1);
  assert.equal(fs.readFileSync(image, "utf8"), "working image");
});

test("shared file references and their dedup hash survive another item's deletion", async t => {
  const { db, source, target, image, opts } = await fixture(t);
  await db.photo.create({ data: { itemId: target.id, originalFilename: "shared.jpg",
    storedPath: process.platform === "win32" ? image.toUpperCase() : image, sha256: "owned-hash" } });
  assert.equal((await deleteItem(source.id, opts)).ok, true);
  assert.equal(fs.existsSync(image), true);
  assert.equal(await db.fileHash.count({ where: { sha256: "owned-hash" } }), 1);
});

test("stored folder paths cannot authorize deleting archive, unmanaged, or unowned files", async t => {
  const { root, db, source, original, opts } = await fixture(t);
  const outside = path.join(root, "outside.jpg"); fs.writeFileSync(outside, "unmanaged");
  const unowned = path.join(source.processingFolderPath!, "unowned.txt"); fs.writeFileSync(unowned, "keep");
  await db.item.update({ where: { id: source.id }, data: { processingFolderPath: root, readyFolderPath: opts.settings.archivePath } });
  for (const file of [original, outside]) await db.photo.create({ data: { itemId: source.id, originalFilename: path.basename(file), storedPath: file, sha256: file } });
  const result = await deleteItem(source.id, opts);
  assert.equal(result.ok, true); assert.ok(result.cleanupWarnings?.length);
  assert.equal(fs.existsSync(original), true); assert.equal(fs.existsSync(outside), true); assert.equal(fs.existsSync(unowned), true);
});

test("a linked working path cannot delete an archive original", async t => {
  const { db, source, original, opts } = await fixture(t);
  const link = path.join(opts.settings.processingPath, "archive-link");
  fs.symlinkSync(opts.settings.archivePath, link, "junction");
  await db.photo.create({ data: { itemId: source.id, originalFilename: "original.jpg", storedPath: path.join(link, "original.jpg"), sha256: "linked-original" } });
  const result = await deleteItem(source.id, opts);
  assert.equal(result.ok, true); assert.ok(result.cleanupWarnings?.length);
  assert.equal(fs.readFileSync(original, "utf8"), "original");
});

test("sold history requires explicit force and force still cannot erase pending removals", async t => {
  const { db, source, opts } = await fixture(t);
  await db.item.update({ where: { id: source.id }, data: { status: "Sold", salePrice: 25 } });
  assert.equal((await deleteItem(source.id, opts)).error, "SOLD_HISTORY");
  const listing = await db.marketplaceListing.create({ data: { itemId: source.id, marketplace: "depop", status: "delist_unknown" } });
  assert.equal((await deleteItem(source.id, { ...opts, force: true })).code, "LIVE_LISTINGS");
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: "ended" } });
  assert.equal((await deleteItem(source.id, { ...opts, force: true })).ok, true);
});

test("legacy unresolved publication remains protected without blocking an ordinary draft", async t => {
  const { db, source, opts } = await fixture(t);
  await db.item.update({ where: { id: source.id }, data: { niftyStatus: "Published" } });
  assert.equal((await deleteItem(source.id, opts)).code, "LIVE_LISTINGS");
  await db.item.update({ where: { id: source.id }, data: { niftyStatus: "Not Uploaded" } });
  assert.equal((await deleteItem(source.id, opts)).ok, true);
});

test("cleanup preserves a configured working root even when nested inside another working root", async t => {
  const { db, source, opts } = await fixture(t);
  const nested = path.join(opts.settings.processingPath, "ready"); fs.mkdirSync(nested);
  opts.settings.readyPath = nested;
  const image = path.join(nested, "ready-image.jpg"); fs.writeFileSync(image, "prepared image");
  await db.photo.create({ data: { itemId: source.id, originalFilename: "ready-image.jpg", storedPath: image, sha256: "prepared" } });
  assert.equal((await deleteItem(source.id, opts)).ok, true);
  assert.equal(fs.existsSync(image), false);
  assert.equal(fs.statSync(nested).isDirectory(), true);
});

test('an old deletion confirmation cannot remove a replacement identity or its files', async t => {
  const { db, source, image, original, opts } = await fixture(t);
  const expected = { id: source.id, sku: source.sku, createdAt: source.createdAt.toISOString(), updatedAt: source.updatedAt.toISOString() };
  await db.item.update({ where: { id: source.id }, data: { createdAt: new Date(source.createdAt.getTime() + 60_000) } });
  const request = { ...opts, expected };
  const result = await deleteItem(source.id, request);
  t.diagnostic(JSON.stringify({ result, itemRemaining: await db.item.count({ where: { id: source.id } }), workingPhotoPresent: fs.existsSync(image), originalPresent: fs.existsSync(original) }));
  assert.equal(result.ok, false);
  assert.equal(await db.item.count({ where: { id: source.id } }), 1);
  assert.equal(await db.photo.count({ where: { itemId: source.id } }), 1);
  assert.equal(await db.fileHash.count({ where: { sha256: 'owned-hash' } }), 1);
  assert.equal(fs.readFileSync(image, 'utf8'), 'working image');
});

test('renamed or changed items require a new deletion confirmation even with force', async t => {
  const { db, source, image, original, opts } = await fixture(t);
  const expected = itemDeleteExpectation(source);
  const renamed = await db.item.update({ where: { id: source.id }, data: { sku: 'RENAMED', updatedAt: new Date(source.updatedAt.getTime() + 1000) } });
  assert.equal((await deleteItem(source.id, { ...opts, force: true, expected })).code, 'ITEM_CHANGED');
  const changed = await db.item.update({ where: { id: source.id }, data: { notes: 'New information', updatedAt: new Date(renamed.updatedAt.getTime() + 1000) } });
  assert.equal((await deleteItem(source.id, { ...opts, force: true, expected: itemDeleteExpectation(renamed) })).code, 'ITEM_CHANGED');
  assert.equal(fs.existsSync(image), true);
  const fresh = itemDeleteExpectation(changed), result = await deleteItem(source.id, { ...opts, expected: fresh });
  assert.equal(itemDeleteReceiptMatches(result, fresh), true);
  assert.equal(itemDeleteReceiptMatches(result, expected), false);
  assert.equal(fs.existsSync(image), false); assert.equal(fs.existsSync(original), true);
});

test('a reviewed mixed selection reports exact deletions, sold protection and changed or publishing items', async t => {
  const { db, source, target, image, original, opts } = await fixture(t);
  const pending = await db.item.create({ data: { sku: 'PENDING' } }), changed = await db.item.create({ data: { sku: 'CHANGED' } });
  const expected = [source, target, pending, changed].map(itemDeleteExpectation), ids = expected.map(row => row.id);
  await db.item.update({ where: { id: target.id }, data: { status: 'Sold', salePrice: 30 } });
  const run = await db.publishRun.create({ data: { marketplacesJson: '["ebay"]' } });
  await db.publishJob.create({ data: { itemId: pending.id, runId: run.id, marketplace: 'ebay' } });
  await db.item.update({ where: { id: changed.id }, data: { notes: 'Changed after confirmation', updatedAt: new Date(changed.updatedAt.getTime() + 1000) } });
  const result = await deleteSelectedItems(ids, expected, opts);
  assert.equal(result.deleted, 1); assert.deepEqual(result.deletedIds, [source.id]);
  assert.equal(result.soldKept, 1); assert.deepEqual(result.soldKeptIds, [target.id]);
  assert.deepEqual(result.failed.map(row => row.id), [pending.id, changed.id]);
  assert.equal(bulkDeleteReceiptMatches(result, expected), true);
  assert.equal(await db.item.count(), 3); assert.equal(fs.existsSync(image), false); assert.equal(fs.existsSync(original), true);
  for (const corrupt of [{ ...result, deleted: 2 }, { ...result, deletedIds: [source.id, source.id] },
    { ...result, failed: [] }, { ...result, expectedItems: expected.map(row => ({ ...row, sku: 'OTHER' })) },
    { ...result, cleanupWarnings: [{ id: target.id, warnings: ['Wrong target'] }] }]) assert.equal(bulkDeleteReceiptMatches(corrupt, expected), false);
});

test('malformed or incomplete deletion selections fail before touching inventory or files', async t => {
  const { db, source, target, image, opts } = await fixture(t);
  const first = itemDeleteExpectation(source), second = itemDeleteExpectation(target);
  for (const [ids, expected] of [[[source.id], undefined], [[source.id, target.id], [first]], [[source.id], [second]],
    [[source.id, source.id], [first, first]], [[String(source.id)], [first]], [[source.id], [{ ...first, createdAt: 'invalid' }]],
    [Array(101).fill(source.id), Array(101).fill(first)]]) await assert.rejects(deleteSelectedItems(ids, expected, opts), /Reload/);
  assert.equal((await deleteItem(target.id, { ...opts, expected: first })).code, 'INVALID_CONFIRMATION');
  assert.equal(await db.item.count(), 2); assert.equal(await db.photo.count(), 1); assert.equal(await db.fileHash.count(), 1);
  assert.equal(fs.readFileSync(image, 'utf8'), 'working image');
});

test('an unexpected deletion failure stops the rest of the batch and keeps their files', async t => {
  const { db, source, target, image, opts } = await fixture(t);
  await db.$executeRawUnsafe(`CREATE TRIGGER stop_first_delete BEFORE DELETE ON Item WHEN OLD.id = ${source.id} BEGIN SELECT RAISE(ABORT, 'fixture unexpected failure'); END`);
  const expected = [source, target].map(itemDeleteExpectation);
  const result = await deleteSelectedItems(expected.map(row => row.id), expected, opts);
  assert.equal(result.deleted, 0); assert.equal(result.failed.length, 2);
  assert.match(result.failed[0].error, /could not be confirmed/); assert.match(result.failed[1].error, /Not attempted/);
  assert.equal(bulkDeleteReceiptMatches(result, expected), true);
  assert.equal(await db.item.count(), 2); assert.equal(await db.photo.count(), 1); assert.equal(fs.existsSync(image), true);
});
