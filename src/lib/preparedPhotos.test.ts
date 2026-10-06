import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Photo, Item } from "@prisma/client";
import { photoRecipe, readPhotoSnapshot } from "./preparedPhotos.ts";
import { buildCanonicalListing } from "./publish/canonical.ts";
import type { AppSettingsData } from "./types.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-photo-snapshot-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-photo-snapshot-")); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "listing_photos"));
  const photos = [1, 2].map(id => {
    const storedPath = path.join(root, `source-${id}.jpg`); fs.writeFileSync(storedPath, `fixture ${id}`);
    return { id, itemId: 1, storedPath, sha256: createHash("sha256").update(fs.readFileSync(storedPath)).digest("hex"),
      isCover: false, sortOrder: id, rotation: 0, includeInListing: true, isMarker: false } as Photo;
  });
  const item = { id: 1, sku: "PHOTO", status: "Ready", brand: "Fixture", itemType: "T-shirt", size: "L",
    condition: "Good", listedPrice: 25, photos, readyFolderPath: root } as Item & { photos: Photo[] };
  const recipe = photoRecipe(item.sku, photos);
  const receipt = (file: string) => { const stat = fs.statSync(file, { bigint: true });
    return { size: String(stat.size), mtimeNs: String(stat.mtimeNs), sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }; };
  for (const entry of recipe) fs.copyFileSync(entry.sourcePath, path.join(root, "listing_photos", entry.name));
  const snapshot = { version: 1, itemId: item.id, sku: item.sku, directory: root, recipe,
    sources: recipe.map(p => receipt(p.sourcePath)), files: recipe.map(p => receipt(path.join(root, "listing_photos", p.name))) };
  const manifest = path.join(root, "item.json"); fs.writeFileSync(manifest, JSON.stringify({ photoSnapshot: snapshot }));
  return { item, snapshot, root, manifest };
}

test("only the reviewed ordered selection remains eligible, including zero selected photos", t => {
  const { item, snapshot } = fixture(t);
  const settings = { minListingPhotos: 1 } as AppSettingsData;
  assert.deepEqual(readPhotoSnapshot(item), snapshot);
  assert.ok(buildCanonicalListing(item, settings).listing);
  const edits = [
    item.photos.map(p => ({ ...p, isCover: p.id === 2 })),
    item.photos.map(p => ({ ...p, sortOrder: -p.sortOrder })),
    item.photos.map(p => ({ ...p, rotation: 90 })),
    item.photos.map(p => ({ ...p, includeInListing: false })),
    item.photos.map(p => ({ ...p, id: p.id + 10 })),
    item.photos.map(p => ({ ...p, sha256: "replaced source" })),
  ];
  for (const photos of edits) {
    assert.equal(readPhotoSnapshot({ ...item, photos }), null);
    const result = buildCanonicalListing({ ...item, photos }, settings);
    assert.equal(result.listing, null);
    assert.ok(result.issues.some(issue => issue.field === "photos"));
  }
});

test("legacy, malformed, and another item's receipts require a fresh approval", t => {
  const { item, snapshot, manifest } = fixture(t);
  for (const value of [{}, { photoSnapshot: { ...snapshot, itemId: 2 } }, { photoSnapshot: { ...snapshot, directory: "elsewhere" } },
    { photoSnapshot: { ...snapshot, version: 2 } }, { photoSnapshot: { ...snapshot, sources: [] } }]) {
    fs.writeFileSync(manifest, JSON.stringify(value)); assert.equal(readPhotoSnapshot(item), null);
  }
  fs.writeFileSync(manifest, "bad JSON"); assert.equal(readPhotoSnapshot(item), null);
});

test("missing or visibly changed source/export files invalidate eligibility", t => {
  const { item, root } = fixture(t);
  fs.writeFileSync(item.photos[0].storedPath, "changed source bytes");
  assert.equal(readPhotoSnapshot(item), null);
  const other = fixture(t);
  fs.unlinkSync(path.join(other.root, "listing_photos", other.snapshot.recipe[0].name));
  assert.equal(readPhotoSnapshot(other.item), null);
  assert.ok(fs.existsSync(path.join(root, "item.json")));
});
