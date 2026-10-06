import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "./types.ts";
import { transferPhotos, resolvePhotoCollision } from "./photoRecovery.ts";
import { PhotoChangeError } from "./photoMutations.ts";
import { isUnderManagedRoots } from "./paths.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-photo-recovery-"));
  const filename = path.join(root, "test.db"); fs.copyFileSync("config/template.db", filename);
  const db = new PrismaClient({ datasources: { db: { url: `file:${filename.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-photo-recovery-")); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = Object.fromEntries(["processingPath", "readyPath", "needsReviewPath", "archivePath", "incomingPath", "exportsPath"]
    .map(key => { const folder = path.join(root, key); fs.mkdirSync(folder); return [key, folder]; })) as unknown as AppSettingsData;
  const source = await db.item.create({ data: { sku: "SOURCE", photoCount: 2 } });
  const target = await db.item.create({ data: { sku: "TARGET" } });
  const other = await db.item.create({ data: { sku: "OTHER" } });
  function staged(name: string, contents = name, marker = false) {
    const storedPath = path.join(settings.processingPath, name + ".jpg"); fs.writeFileSync(storedPath, contents);
    return { originalFilename: name + ".jpg", storedPath, thumbPath: null,
      sha256: createHash("sha256").update(contents).digest("hex"), isMarker: marker, includeInListing: !marker,
      rotation: 0, sortOrder: 0, decodedValue: null, width: 800, height: 600 };
  }
  const old = [];
  for (const [index, name] of ["first", "second", "marker"].entries()) {
    const data = staged(name, name, index === 2);
    old.push(await db.photo.create({ data: { ...data, itemId: source.id, sortOrder: index === 2 ? 999 : index, isCover: index === 0 } }));
    await db.fileHash.create({ data: { sha256: data.sha256, originalFilename: data.originalFilename, processedPath: data.storedPath } });
  }
  const incoming = [staged("incoming")];
  async function group(photos = incoming, existingItemId: number | null = source.id) {
    return db.collision.create({ data: { sku: source.sku, existingItemId, incomingPhotosJson: JSON.stringify(photos) } });
  }
  return { root, db, settings, source, target, other, old, incoming, staged, group };
}
const conflict = (error: unknown) => error instanceof PhotoChangeError && error.status === 409;

test("unrelated staged paths are rejected before probing the filesystem", t => {
  let probes = 0;
  t.mock.method(fs, "lstatSync", () => { probes++; throw new Error("unexpected filesystem probe"); });
  const settings = { processingPath: path.join(os.tmpdir(), "managed-photos") } as AppSettingsData;
  assert.equal(isUnderManagedRoots(path.join(os.tmpdir(), "unrelated", "photo.jpg"), settings), false);
  assert.equal(probes, 0);
});

test("a stale Move cannot take photos from the destination of an earlier Move", async t => {
  const f = await fixture(t), ids = [f.old[0].id];
  await transferPhotos(f.db, f.source.id, { photoIds: ids, targetItemId: f.target.id }, false);
  await assert.rejects(transferPhotos(f.db, f.source.id, { photoIds: ids, targetItemId: f.other.id }, false), conflict);
  assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.target.id } })).photoCount, 1);
  assert.equal(await f.db.photo.count({ where: { itemId: f.target.id } }), 1);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.old[1].id } })).isCover, true);
  assert.equal(fs.readFileSync(f.old[0].storedPath, "utf8"), "first");
});

test("Split returns current counts, keeps markers internal, and cannot replay a stale selection", async t => {
  const f = await fixture(t), photoIds = [f.old[1].id, f.old[2].id];
  const result = await transferPhotos(f.db, f.source.id, { photoIds, newSku: "SPLIT" }, true);
  assert.equal(result.item?.photoCount, 1);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id: f.old[2].id } })).isCover, false);
  await assert.rejects(transferPhotos(f.db, f.source.id, { photoIds, newSku: "UNWANTED" }, true), conflict);
  assert.equal(await f.db.item.findUnique({ where: { sku: "UNWANTED" } }), null);
});

test("a transfer failure rolls back every photo and the new split item", async t => {
  const f = await fixture(t); const before = await f.db.photo.findMany({ orderBy: { id: "asc" } });
  await f.db.$executeRawUnsafe(`CREATE TRIGGER prevent_transfer BEFORE UPDATE ON Photo WHEN NEW.id=${f.old[1].id} AND NEW.itemId<>OLD.itemId BEGIN SELECT RAISE(ABORT,'injected transfer failure'); END`);
  for (const split of [false, true]) {
    await assert.rejects(transferPhotos(f.db, f.source.id, { photoIds: f.old.slice(0, 2).map(p => p.id), newSku: "FAILED", targetItemId: f.target.id }, split));
    assert.deepEqual(await f.db.photo.findMany({ orderBy: { id: "asc" } }), before);
    assert.equal(await f.db.item.findUnique({ where: { sku: "FAILED" } }), null);
    assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.source.id } })).photoCount, 2);
  }
});

test("invalid and duplicate selections or conflicting SKUs leave inventory unchanged", async t => {
  const f = await fixture(t), id = f.old[0].id;
  for (const input of [{ photoIds: [id, id], targetItemId: f.target.id }, { photoIds: [String(id)], targetItemId: f.target.id },
    { photoIds: [id], targetItemId: f.source.id }, { photoIds: [id], targetItemId: 999999 }]) {
    await assert.rejects(transferPhotos(f.db, f.source.id, input, false), PhotoChangeError);
  }
  for (const newSku of ["../escape", "", "TARGET"]) await assert.rejects(transferPhotos(f.db, f.source.id, { photoIds: [id], newSku }, true), PhotoChangeError);
  assert.equal((await f.db.photo.findUniqueOrThrow({ where: { id } })).itemId, f.source.id);
  assert.equal(await f.db.item.count(), 3);
});

test("Append adds unique photos once and preserves the reviewed cover", async t => {
  const f = await fixture(t);
  const duplicate = f.staged("duplicate-copy", "first");
  const group = await f.group([duplicate, ...f.incoming, f.incoming[0]]);
  const result = await resolvePhotoCollision(f.db, group.id, "append", f.settings);
  assert.equal(result.added, 1); assert.equal(result.duplicatesSkipped, 2);
  assert.equal(result.items[0].photoCount, 3);
  assert.equal(result.items[0].photos.find(p => p.isCover)?.id, f.old[0].id);
  for (const resolution of ["append", "replace", "new"]) await assert.rejects(resolvePhotoCollision(f.db, group.id, resolution, f.settings), conflict);
  assert.equal(await f.db.photo.count(), 4); assert.equal(await f.db.item.count(), 3);
});

test("failed replacement preserves old rows, hashes, files, and a pending resolution", async t => {
  const f = await fixture(t), group = await f.group();
  const before = await f.db.photo.findMany({ orderBy: { id: "asc" } });
  await f.db.$executeRawUnsafe("CREATE TRIGGER prevent_attach BEFORE INSERT ON Photo BEGIN SELECT RAISE(ABORT,'injected attach failure'); END");
  await assert.rejects(resolvePhotoCollision(f.db, group.id, "replace", f.settings));
  assert.deepEqual(await f.db.photo.findMany({ orderBy: { id: "asc" } }), before);
  assert.equal(await f.db.fileHash.count(), 3);
  assert.equal((await f.db.collision.findUniqueOrThrow({ where: { id: group.id } })).status, "pending");
  for (const photo of f.old) assert.ok(fs.existsSync(photo.storedPath));
});

test("replacement cleans only unshared working copies and retains financial/listing history", async t => {
  const f = await fixture(t), group = await f.group();
  await f.db.item.update({ where: { id: f.source.id }, data: { status: "Sold", salePrice: 17, itemCost: 5 } });
  await f.db.marketplaceListing.create({ data: { itemId: f.source.id, marketplace: "poshmark", status: "sold", externalListingId: "fixture" } });
  await f.db.photo.create({ data: { itemId: f.other.id, originalFilename: "shared", storedPath: f.old[0].storedPath, sha256: f.old[0].sha256 } });
  const result = await resolvePhotoCollision(f.db, group.id, "replace", f.settings);
  assert.equal(result.items[0].photoCount, 1); assert.equal(result.items[0].photos.filter(p => p.isCover).length, 1);
  assert.equal(fs.existsSync(f.old[0].storedPath), true); assert.equal(fs.existsSync(f.old[1].storedPath), false);
  const item = await f.db.item.findUniqueOrThrow({ where: { id: f.source.id } });
  assert.equal(item.status, "Sold"); assert.equal(item.salePrice, 17); assert.equal(item.itemCost, 5);
  assert.equal(await f.db.marketplaceListing.count(), 1);
});

test("New creates a unique suffix once and rolls back an incomplete new item", async t => {
  const f = await fixture(t), group = await f.group();
  await f.db.item.create({ data: { sku: "SOURCE-2" } });
  const result = await resolvePhotoCollision(f.db, group.id, "new", f.settings);
  assert.equal(result.target.sku, "SOURCE-3"); assert.equal(result.items[0].photoCount, 1);
  await assert.rejects(resolvePhotoCollision(f.db, group.id, "new", f.settings), conflict);
  const failing = await f.group([f.staged("failing-new")]);
  await f.db.$executeRawUnsafe("CREATE TRIGGER prevent_new_photo BEFORE INSERT ON Photo BEGIN SELECT RAISE(ABORT,'injected attach failure'); END");
  await assert.rejects(resolvePhotoCollision(f.db, failing.id, "new", f.settings));
  assert.equal(await f.db.item.findUnique({ where: { sku: "SOURCE-4" } }), null);
  assert.equal((await f.db.collision.findUniqueOrThrow({ where: { id: failing.id } })).status, "pending");
});

test("missing, changed or escaped staged photos cannot erase the current selection", async t => {
  const f = await fixture(t);
  const changed = f.staged("changed"); fs.writeFileSync(changed.storedPath, "other bytes");
  const missing = f.staged("missing"); fs.unlinkSync(missing.storedPath);
  const outside = { ...f.staged("outside"), storedPath: path.join(f.root, "outside.jpg") }; fs.writeFileSync(outside.storedPath, "outside");
  for (const incoming of [changed, missing, outside]) {
    const group = await f.group([incoming]);
    await assert.rejects(resolvePhotoCollision(f.db, group.id, "replace", f.settings), conflict);
    assert.equal((await f.db.collision.findUniqueOrThrow({ where: { id: group.id } })).status, "pending");
    assert.equal(await f.db.photo.count({ where: { itemId: f.source.id } }), 3);
    assert.ok(fs.existsSync(f.old[0].storedPath));
  }
});

test("a stale existing-item identity cannot replace a newer item that reused its SKU", async t => {
  const f = await fixture(t), group = await f.group();
  await f.db.item.update({ where: { id: f.source.id }, data: { sku: "RENAMED" } });
  await f.db.item.create({ data: { sku: "SOURCE" } });
  await assert.rejects(resolvePhotoCollision(f.db, group.id, "replace", f.settings), conflict);
  assert.equal(await f.db.photo.count({ where: { itemId: f.source.id } }), 3);
  assert.equal((await f.db.collision.findUniqueOrThrow({ where: { id: group.id } })).status, "pending");
});

test("competing resolution transactions attach the group only once", async t => {
  const f = await fixture(t), group = await f.group();
  const other = new PrismaClient({ datasources: { db: { url: `file:${path.join(f.root, "test.db").replaceAll("\\", "/")}` } } });
  try {
    const results = await Promise.allSettled([resolvePhotoCollision(f.db, group.id, "append", f.settings), resolvePhotoCollision(other, group.id, "append", f.settings)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && conflict(result.reason)).length, 1);
    assert.equal(await f.db.photo.count({ where: { itemId: f.source.id } }), 4);
    assert.equal((await f.db.item.findUniqueOrThrow({ where: { id: f.source.id } })).photoCount, 3);
  } finally { await other.$disconnect(); }
});

test("competing moves cannot both claim the same source photo", async t => {
  const f = await fixture(t), photoIds = [f.old[0].id];
  const other = new PrismaClient({ datasources: { db: { url: `file:${path.join(f.root, "test.db").replaceAll("\\", "/")}` } } });
  try {
    const results = await Promise.allSettled([transferPhotos(f.db, f.source.id, { photoIds, targetItemId: f.target.id }, false),
      transferPhotos(other, f.source.id, { photoIds, targetItemId: f.other.id }, false)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && conflict(result.reason)).length, 1);
    for (const id of [f.source.id, f.target.id, f.other.id]) {
      const item = await f.db.item.findUniqueOrThrow({ where: { id } });
      assert.equal(item.photoCount, await f.db.photo.count({ where: { itemId: id, includeInListing: true, isMarker: false } }));
    }
  } finally { await other.$disconnect(); }
});
