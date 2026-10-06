import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_INVENTORY_QUERY, inventoryBackHref, inventoryDateRange, inventoryItemHref, inventoryNeighbors, inventoryPage,
  inventoryQueryString, parseInventoryQuery, type InventoryQuery } from "./inventoryQuery.ts";

const query = (changes: Partial<InventoryQuery> = {}) => ({ ...DEFAULT_INVENTORY_QUERY, ...changes });

test("inventory filters round-trip through internal links without accepting redirect destinations", () => {
  const value = parseInventoryQuery(new URLSearchParams("q=blue&state=Sold&marketplace=poshmark&priceField=sold&priceMin=0&page=3&pageSize=25&returnTo=https://example.invalid"));
  assert.deepEqual(parseInventoryQuery(new URLSearchParams(inventoryQueryString(value))), value);
  const href = inventoryItemHref(42, value), url = new URL(href, "http://127.0.0.1:41999");
  assert.equal(url.pathname, "/inventory/42");
  assert.deepEqual(parseInventoryQuery(new URLSearchParams(url.searchParams.get("from")!)), value);
  assert.ok(inventoryBackHref(value).startsWith("/inventory?")); assert.ok(!href.includes("example.invalid"));
});

test("invalid ranges, dates, states and unbounded pages fail before querying inventory", () => {
  for (const value of ["page=0", "page=-1", "page=1e6", "pageSize=101", "priceMin=30&priceMax=20", "priceMin=-1",
    "priceMin=Infinity", "priceMax=1.001", "dateFrom=2026-02-30", "dateFrom=2026-09-20&dateTo=2026-09-01",
    "state=made-up", "marketplace=unknown", "batch=1.5", "dateField=shipped", "priceField=profit"])
    assert.throws(() => parseInventoryQuery(new URLSearchParams(value)), value);
  assert.equal(parseInventoryQuery(new URLSearchParams("priceMin=.50&priceMax=25.")).priceMin, ".50");
});

test("calendar end dates include the whole local day across daylight-saving changes", () => {
  const previous = process.env.TZ; process.env.TZ = "America/New_York";
  try {
    const spring = inventoryDateRange("2026-03-08", "2026-03-08")!;
    const autumn = inventoryDateRange("2026-11-01", "2026-11-01")!;
    assert.equal((spring.gte as Date).getHours(), 0); assert.equal((spring.lt as Date).getHours(), 0);
    assert.equal(+(spring.lt as Date) - +(spring.gte as Date), 23 * 60 * 60 * 1000);
    assert.equal(+(autumn.lt as Date) - +(autumn.gte as Date), 25 * 60 * 60 * 1000);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("real SQLite inventory pages and filtered navigation retain every item beyond old caps", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-inventory-query-"));
  const file = path.join(root, "test.db"); fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-inventory-query-")); fs.rmSync(root, { recursive: true, force: true }); });
  const batch = await db.batch.create({ data: { name: "Filter fixture" } });
  const rows = [
    { sku: "000001", status: "Photographed", brand: "Nike", category: "Clothing", size: "M", itemType: "T-shirt", listedPrice: 25, flagged: true, batchId: batch.id, createdAt: new Date(2026, 8, 1, 13) },
    { sku: "000002", status: "Ready", brand: "Lee", category: "Clothing", size: "32", itemType: "Jeans", listedPrice: 45 },
    { sku: "000003", status: "Sold", brand: "Levis", category: "Clothing", size: "M", listedPrice: 25, salePrice: 17, platformSold: "Poshmark", dateSold: new Date(2026, 8, 3, 23, 30) },
    { sku: "000004", status: "Ready for Nifty", brand: "Fixture", category: "Bag", size: null, itemType: "Handbag", listedPrice: 0, dateListed: new Date(2026, 7, 1, 12) },
    { sku: "000005", status: "Uploaded to Nifty", brand: "Adidas", category: "Shoes", size: "8", listedPrice: 35 },
    { sku: "000006", status: "Needs Info", brand: "Nike", category: null, size: "L", itemType: "Top", listedPrice: 20 },
    { sku: "000007", status: "Problem", brand: "Nike", category: "Clothing", listedPrice: 7 },
  ];
  for (const data of rows) await db.item.create({ data: { ...data, photoCount: 999, aiRaw: "PRIVATE-AI-DIAGNOSTIC" } });
  for (let start = 0; start < 6000; start += 500) await db.item.createMany({ data: Array.from({ length: 500 }, (_, n) => ({
    sku: `F-${String(start + n).padStart(6, "0")}`, status: "Archived", brand: "Fixture", category: "Clothing", size: "S",
    itemType: "T-shirt", listedPrice: 10, createdAt: new Date(2020, 0, 1), aiRaw: "PRIVATE-AI-DIAGNOSTIC".repeat(40) })) });
  const bySku = new Map((await db.item.findMany({ where: { sku: { startsWith: "000" } } })).map(row => [row.sku, row]));
  const first = bySku.get("000001")!;
  const photo = (name: string, extra: Record<string, unknown>) => db.photo.create({ data: { itemId: first.id, originalFilename: `${name}.jpg`, storedPath: `C:/fixture/${name}.jpg`, sha256: "a".repeat(64), ...extra } });
  await photo("marker", { isMarker: true, isCover: true });
  await photo("excluded", { includeInListing: false, isCover: true, sortOrder: 0 });
  await photo("included", { sortOrder: 1 });
  const cover = await photo("cover", { isCover: true, sortOrder: 2, rotation: 90 });
  await db.marketplaceListing.createMany({ data: [
    { itemId: bySku.get("000002")!.id, marketplace: "ebay", status: "published", price: 44, title: "Rare stitched eagle jacket", publishedAt: new Date(2026, 8, 2, 12) },
    { itemId: bySku.get("000003")!.id, marketplace: "poshmark", status: "sold", price: 17 },
    { itemId: bySku.get("000003")!.id, marketplace: "ebay", status: "ended", price: 20 },
    { itemId: bySku.get("000004")!.id, marketplace: "depop", status: "ended", price: 19, publishedAt: new Date(2026, 7, 5, 12) },
    { itemId: bySku.get("000007")!.id, marketplace: "depop", status: "published", price: 7 },
  ] });
  const before = await db.item.findMany({ select: { id: true, status: true, updatedAt: true }, orderBy: { id: "asc" } });

  await t.test("all pages are reachable in SKU order with bounded payloads and correct image counts", async () => {
    const firstPage = await inventoryPage(db, query());
    assert.equal(firstPage.total, 6007); assert.equal(firstPage.pages, 121); assert.equal(firstPage.items.length, 50);
    assert.equal(firstPage.items[0].sku, "000001"); assert.equal(firstPage.items[0].cover?.id, cover.id);
    assert.equal(firstPage.items[0].photoCount, 3); assert.equal(firstPage.items[0].selectedPhotoCount, 2);
    assert.equal(firstPage.items[0].cover?.rotation, 90); assert.equal(firstPage.items[1].title, "Rare stitched eagle jacket");
    const json = JSON.stringify(firstPage); assert.ok(!json.includes("PRIVATE-AI-DIAGNOSTIC")); assert.ok(json.length < 100_000);
    const last = await inventoryPage(db, query({ page: 121 }));
    assert.equal(last.items.length, 7); assert.equal(last.items.at(-1)?.sku, "F-005999");
    assert.equal((await inventoryPage(db, query({ page: 1_000_000 }))).page, 121);
  });

  await t.test("brand, type, exact size, category, flags, SKU and batch filters compose", async () => {
    const filtered = await inventoryPage(db, query({ brand: "nik", itemType: "shirt", size: "M", category: "Clothing", flagged: true, batch: String(batch.id) }));
    assert.deepEqual(filtered.items.map(row => row.sku), ["000001"]);
    assert.deepEqual((await inventoryPage(db, query({ sku: "F-005999" }))).items.map(row => row.sku), ["F-005999"]);
    assert.deepEqual((await inventoryPage(db, query({ category: "__unset__" }))).items.map(row => row.sku), ["000006"]);
  });

  await t.test("marketplace filters distinguish an active listing from its actual sale channel", async () => {
    assert.deepEqual((await inventoryPage(db, query({ state: "Listed", marketplace: "ebay" }))).items.map(row => row.sku), ["000002"]);
    assert.equal((await inventoryPage(db, query({ state: "Sold", marketplace: "ebay" }))).total, 0);
    assert.deepEqual((await inventoryPage(db, query({ state: "Sold", marketplace: "poshmark" }))).items.map(row => row.sku), ["000003"]);
    assert.equal((await inventoryPage(db, query({ marketplace: "ebay" }))).total, 2);
    assert.deepEqual((await inventoryPage(db, query({ state: "Previously listed" }))).items.map(row => row.sku), ["000005"]);
  });

  await t.test("asking and sold-price ranges stay separate and zero is a valid filter", async () => {
    assert.deepEqual((await inventoryPage(db, query({ state: "Ready", priceMin: "0", priceMax: "0" }))).items.map(row => row.sku), ["000004"]);
    assert.deepEqual((await inventoryPage(db, query({ priceField: "sold", priceMin: "17", priceMax: "17" }))).items.map(row => row.sku), ["000003"]);
    assert.equal((await inventoryPage(db, query({ priceMin: "17", priceMax: "17" }))).total, 0);
  });

  await t.test("date ranges include late-day sales and recorded marketplace dates", async () => {
    assert.deepEqual((await inventoryPage(db, query({ dateField: "added", dateFrom: "2026-09-01", dateTo: "2026-09-01" }))).items.map(row => row.sku), ["000001"]);
    assert.deepEqual((await inventoryPage(db, query({ dateField: "sold", dateFrom: "2026-09-03", dateTo: "2026-09-03" }))).items.map(row => row.sku), ["000003"]);
    for (const day of ["2026-08-01", "2026-08-05"]) assert.deepEqual((await inventoryPage(db, query({ dateField: "listed", dateFrom: day, dateTo: day }))).items.map(row => row.sku), ["000004"]);
    assert.deepEqual((await inventoryPage(db, query({ q: "stitched eagle" }))).items.map(row => row.sku), ["000002"]);
  });

  await t.test("previous and next use the whole matching inventory, beyond the former 2000-item limit", async () => {
    const late = await db.item.findUniqueOrThrow({ where: { sku: "F-005998" } });
    const neighbors = await inventoryNeighbors(db, late.id, query());
    assert.equal(neighbors?.index, 6005); assert.equal(neighbors?.total, 6007);
    assert.equal((await db.item.findUniqueOrThrow({ where: { id: neighbors!.next! } })).sku, "F-005999");
    const filtered = await inventoryNeighbors(db, first.id, query({ brand: "Nike", page: 12 }));
    assert.equal(filtered?.index, 0); assert.equal(filtered?.total, 3); assert.equal(filtered?.next, bySku.get("000006")!.id);
    assert.equal((await inventoryNeighbors(db, first.id, query({ state: "Sold" })))?.matches, false);
    assert.equal(await inventoryNeighbors(db, 999999, query()), null);
    await assert.rejects(inventoryNeighbors(db, 0, query()), /Invalid/);
  });

  await t.test("reads do not change business records", async () => {
    assert.deepEqual(await db.item.findMany({ select: { id: true, status: true, updatedAt: true }, orderBy: { id: "asc" } }), before);
    assert.equal(await db.photo.count(), 4); assert.equal(await db.publishJob.count(), 0);
  });

  await t.test("database failures propagate rather than pretending the inventory is empty", async () => {
    await db.$executeRawUnsafe("ALTER TABLE Item RENAME TO UnavailableItem");
    await assert.rejects(inventoryPage(db, query()));
    await assert.rejects(inventoryNeighbors(db, first.id, query()));
  });
});
