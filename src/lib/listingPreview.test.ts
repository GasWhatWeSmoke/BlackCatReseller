import test from "node:test";
import assert from "node:assert/strict";
import { buildTitle } from "./listing.ts";
import { previewListingItem } from "./listingPreview.ts";

const raw = JSON.stringify({ keyDetails: ["Star Wars", "Fleece-Lined"] });
const base = {
  sku: "000144",
  brand: "Disney",
  itemType: "Hoodie",
  color: "Black",
  size: "L",
  aiRaw: raw,
};

test("preview uses raw key details only while the legacy column is unset", () => {
  assert.deepEqual(previewListingItem({ ...base, keyDetails: null }).keyDetails, ["Star Wars", "Fleece-Lined"]);
  assert.deepEqual(previewListingItem(base).keyDetails, ["Star Wars", "Fleece-Lined"]);
});

test("an explicit empty key-details edit suppresses the raw AI fallback", () => {
  const whileEditing = previewListingItem({ ...base, keyDetails: null }, { keyDetails: "" });
  assert.equal(whileEditing.keyDetails, null);
  assert.doesNotMatch(buildTitle(whileEditing), /Star Wars|Fleece-Lined/i);

  // PATCH stores the empty string as the durable operator override. Reopening the
  // item must retain that empty list instead of treating it as an old null column.
  const afterReload = previewListingItem({ ...base, keyDetails: "" });
  assert.equal(afterReload.keyDetails, null);
  assert.doesNotMatch(buildTitle(afterReload), /Star Wars|Fleece-Lined/i);
});
