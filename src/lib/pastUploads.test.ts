import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadUploadHistory, uploadHistorySummary, saleDateLabel } from "./pastUploads.ts";
import { unlinkedHistoryWhere } from "./publish/listingGuards.ts";

test("sale marketplace labels normalize stored casing without duplicating direct sale records", () => {
  const item = { status: "Sold", niftyStatus: "Not Uploaded", platformSold: " MERCARI ", marketplaceListings: [{ marketplace: "mercari", status: "sold" }] };
  assert.deepEqual(uploadHistorySummary(item).soldPlatforms, ["Mercari"]);
  assert.deepEqual(uploadHistorySummary({ ...item, platformSold: null, marketplaceListings: [] }).soldPlatforms, []);
});

test("receipt calendar dates do not shift to the previous US day", () => {
  assert.equal(saleDateLabel("2026-09-11T00:00:00.000Z", "en-US", "America/New_York"), "9/11/2026");
  assert.equal(saleDateLabel("2026-09-11T01:15:00.000Z", "en-US", "America/New_York"), "9/10/2026");
});

test("history includes a direct eBay sale and live direct items regardless of Nifty status", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-history-"));
  fs.copyFileSync(path.join(process.cwd(), "config/template.db"), path.join(dir, "test.db"));
  const db = new PrismaClient({ datasources: { db: { url: `file:${path.join(dir, "test.db").replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sold = await db.item.create({ data: { sku: "000008", status: "Sold", niftyStatus: "Not Uploaded", platformSold: "eBay", salePrice: 13.99 } });
  await db.marketplaceListing.createMany({ data: [
    { itemId: sold.id, marketplace: "ebay", status: "sold" },
    ...["depop", "etsy", "poshmark", "mercari"].map(marketplace => ({ itemId: sold.id, marketplace, status: "ended" })),
  ] });
  const live = await db.item.create({ data: { sku: "DIRECT", status: "Ready for Nifty" } });
  await db.marketplaceListing.create({ data: { itemId: live.id, marketplace: "depop", status: "published" } });
  await db.item.create({ data: { sku: "LEGACY", status: "Sold", niftyStatus: "Published", platformSold: "Poshmark" } });
  const pending = await db.item.create({ data: { sku: "NOT-POSTED", status: "Ready for Nifty" } });
  await db.marketplaceListing.create({ data: { itemId: pending.id, marketplace: "ebay", status: "not_published" } });
  const result = await loadUploadHistory(db);
  assert.deepEqual(new Set(result.items.map(item => item.sku)), new Set(["000008", "DIRECT", "LEGACY"]));
  const item = result.items.find(item => item.sku === "000008")!;
  assert.equal(item.legacy, false);
  assert.deepEqual(item.soldPlatforms, ["eBay"]);
  assert.equal(item.removalSummary, "4 other listings removed");
  assert.equal(item.removalNeedsAttention, false);
  assert.equal(item.salePrice, 13.99);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: sold.id } })).niftyStatus, "Not Uploaded");
  const legacyEligible = await db.item.findMany({ where: unlinkedHistoryWhere, select: { sku: true } });
  assert.deepEqual(new Set(legacyEligible.map(row => row.sku)), new Set(["LEGACY", "NOT-POSTED"]));
});

test("an explicit Legacy fallback remains manageable after a failed direct attempt", () => {
  const result = uploadHistorySummary({ status: "Uploaded to Nifty", niftyStatus: "Published", platformSold: null,
    marketplaceListings: [{ marketplace: "ebay", status: "not_published" }] });
  assert.equal(result.legacy, true);
});

test("history names unresolved removal platforms instead of claiming a sold item is protected", () => {
  const result = uploadHistorySummary({ status: "Sold", niftyStatus: "Not Uploaded", platformSold: "eBay", marketplaceListings: [
    { marketplace: "ebay", status: "sold" }, { marketplace: "depop", status: "ended" },
    { marketplace: "mercari", status: "delist_unknown" },
  ] });
  assert.equal(result.removalNeedsAttention, true);
  assert.equal(result.removalSummary, "Removal needs attention: Mercari");
});
