import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { photoRecipe } from "../preparedPhotos.ts";
import { PrismaClient } from "@prisma/client";
import { buildCanonicalListing } from "./canonical.ts";
import { buildExportCopy } from "../listingCopy.ts";
import { VINTAGE_WHEN_MADE_DEFAULT, WHEN_MADE_DEFAULT } from "../listingOptions.ts";
import type { AppSettingsData } from "../types.ts";

test("direct publishing carries the same reviewed vintage facts as the Nifty export", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-canonical-facts-"));
  const file = path.join(root, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    await db.$disconnect();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const photos = path.join(root, "listing_photos");
  fs.mkdirSync(photos);
  fs.writeFileSync(path.join(photos, "000001_01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const settings = { minListingPhotos: 1 } as AppSettingsData;
  const row = await db.item.create({ data: { sku: "000001", status: "Ready for Nifty", brand: "Quiksilver",
    itemType: "T-shirt", category: "Clothing", department: "Men", size: "L", condition: "Good", listedPrice: 25, readyFolderPath: root } });
  // This copy-facts test needs a prepared photo, just as a real approved item does.
  const filename = path.join(photos, "000001_01.jpg");
  const sha256 = createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  const photo = await db.photo.create({ data: { itemId: row.id, originalFilename: "source.jpg", storedPath: filename, sha256 } });
  const stat = fs.statSync(filename, { bigint: true });
  const receipt = { size: String(stat.size), mtimeNs: String(stat.mtimeNs), sha256 };
  fs.writeFileSync(path.join(root, "item.json"), JSON.stringify({ photoSnapshot: { version: 1, itemId: row.id, sku: row.sku,
    directory: root, recipe: photoRecipe(row.sku, [photo]), sources: [receipt], files: [receipt] } }));
  for (const fields of [
    { trueVintage: true, etsyEligible: "none", whenMade: WHEN_MADE_DEFAULT },
    { trueVintage: false, etsyEligible: "vintage", whenMade: null },
    { trueVintage: true, etsyEligible: "none", whenMade: "1990s (Vintage)" },
    { trueVintage: false, etsyEligible: "none", whenMade: WHEN_MADE_DEFAULT, material: "100% Wool", customTitle: "Vintage-inspired wool shirt" },
  ]) {
    const item = await db.item.update({ where: { id: row.id }, data: fields, include: { photos: true } });
    const copy = buildExportCopy(item);
    const result = buildCanonicalListing(item, settings);
    assert.deepEqual(result.issues, []);
    assert.equal(result.listing?.trueVintage, copy.trueVintage);
    assert.equal(result.listing?.whenMade, copy.whenMade);
    assert.equal(result.listing?.title, copy.title);
    assert.equal(result.listing?.description, copy.description);
    assert.equal(result.listing?.quantity, 1);
    if (fields.etsyEligible === "vintage") assert.equal(result.listing?.whenMade, VINTAGE_WHEN_MADE_DEFAULT);
    if (fields.customTitle) assert.equal(result.listing?.trueVintage, false);
    assert.equal((await db.item.findUniqueOrThrow({ where: { id: row.id } })).whenMade, fields.whenMade);
  }
});
