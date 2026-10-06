import test from "node:test";
import assert from "node:assert/strict";
import { changeDraft, draftConflicts, draftExpectedItem, draftKey, parseDraft, resolveDraftField, type DraftItem } from "./itemDrafts.ts";
import { conflictingItemFields, withExpectedItemValues } from "./itemEdits.ts";

const item: DraftItem = { id: 1, createdAt: "2026-09-20T00:00:00.000Z", status: "Needs Info", brand: "Original", keyDetails: null, listedPrice: 10 };
const key = draftKey("review", item);

test("a recovered draft retains its original baseline and rejects a later conflicting save", () => {
  const draft = changeDraft(key, item, null, { brand: "My correction" });
  const recovered = parseDraft(JSON.parse(JSON.stringify(draft)), key)!;
  const later = { ...item, brand: "Newer saved brand" };
  assert.deepEqual(draftConflicts(later, recovered), ["brand"]);
  const patch = withExpectedItemValues(draftExpectedItem(later, recovered), recovered.changes);
  assert.deepEqual(conflictingItemFields(later, patch.expectedValues), ["brand"]);
  assert.equal(changeDraft(key, later, recovered, { brand: "Another correction" }).baseline.brand, "Original");
});

test("unrelated changes and already-saved edits do not cause false conflicts", () => {
  const draft = changeDraft(key, item, null, { brand: "Corrected" });
  const later = { ...item, brand: "Corrected", listedPrice: 40, photoCount: 2 };
  assert.deepEqual(draftConflicts(later, draft), []);
  assert.equal(draftExpectedItem(later, draft).listedPrice, 40);
  assert.deepEqual(conflictingItemFields(later, withExpectedItemValues(draftExpectedItem(later, draft), draft.changes).expectedValues), []);
});

test("empty strings, zero, false and null retain distinct operator intent", () => {
  const draft = changeDraft(key, item, null, { keyDetails: "", itemCost: 0, trueVintage: false, listedPrice: null });
  assert.deepEqual(parseDraft(JSON.parse(JSON.stringify(draft)), key)?.changes, { keyDetails: "", itemCost: 0, trueVintage: false, listedPrice: null });
  assert.equal(draft.baseline.keyDetails, null);
});

test("resolving a field explicitly keeps the draft or adopts the saved value", () => {
  const draft = changeDraft(key, item, null, { brand: "Mine", listedPrice: 20 });
  const later = { ...item, brand: "Theirs", listedPrice: 30 };
  const keep = resolveDraftField(later, draft, "brand", true);
  assert.equal(keep.changes.brand, "Mine"); assert.equal(keep.baseline.brand, "Theirs");
  const saved = resolveDraftField(later, keep, "listedPrice", false);
  assert.equal(Object.hasOwn(saved.changes, "listedPrice"), false);
  assert.deepEqual(draftConflicts(later, saved), []);
  assert.equal(draft.baseline.brand, "Original");
});

test("a sale/status transition always needs review and cannot become an automatic status edit", () => {
  const draft = changeDraft(key, item, null, { brand: "Mine" });
  const sold = { ...item, status: "Sold" };
  assert.deepEqual(draftConflicts(sold, draft), ["status"]);
  const resolved = resolveDraftField(sold, draft, "status", true);
  assert.deepEqual(draftConflicts(sold, resolved), []);
  assert.equal(Object.hasOwn(resolved.changes, "status"), false);
  assert.equal(draftExpectedItem(sold, resolved).status, "Sold");
  assert.throws(() => changeDraft(key, sold, draft, { status: "Ready" }), /Cannot keep/);
});

test("draft identity separates editor scopes and reused numeric item IDs", () => {
  assert.notEqual(key, draftKey("editor", item));
  assert.notEqual(key, draftKey("review", { ...item, createdAt: "2026-09-21T00:00:00.000Z" }));
  assert.throws(() => draftKey("review", { id: 1, createdAt: "" }));
  assert.throws(() => parseDraft(changeDraft(key, item, null, { brand: "Mine" }), draftKey("editor", item)));
});

test("malformed or unsupported stored fields fail without fabricating a blank draft", () => {
  const draft = changeDraft(key, item, null, { brand: "Mine" });
  for (const bad of [{}, { ...draft, version: 2 }, { ...draft, changes: { status: "Ready" } },
    { ...draft, baseline: { ...draft.baseline, photos: [] } }, { ...draft, changes: { brand: {} } }]) assert.throws(() => parseDraft(bad, key));
  assert.equal(parseDraft(null, key), null);
  assert.throws(() => changeDraft(key, item, draft, { listedPrice: Infinity }));
});

test("legacy drafts with unknown original values require an explicit review decision", () => {
  const draft = changeDraft(key, item, null, { brand: "Old draft" });
  draft.baseline.status = "Older draft: original saved values unavailable";
  assert.deepEqual(draftConflicts(item, draft), ["status"]);
  assert.deepEqual(draftConflicts(item, resolveDraftField(item, draft, "status", true)), []);
});

test("empty saved receipts do not block later status changes or retain stale baselines", () => {
  const receipt = changeDraft(key, item, null, {});
  const sold = { ...item, status: "Sold", brand: "Later" };
  assert.deepEqual(draftConflicts(sold, receipt), []);
  assert.equal(draftExpectedItem(sold, receipt).status, "Sold");
  const next = changeDraft(key, sold, receipt, { brand: "Correction" });
  assert.deepEqual(next.baseline, { status: "Sold", brand: "Later" });
});
