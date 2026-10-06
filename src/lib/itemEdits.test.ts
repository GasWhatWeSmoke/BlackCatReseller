import test from "node:test";
import assert from "node:assert/strict";
import { itemEditError, editedEvidence, evidenceForValue, withExpectedItemValues, expectedItemValuesError, conflictingItemFields } from "./itemEdits.ts";
import { ITEM_STATUSES } from './types.ts';

test('status edits accept supported stored states and reject display labels or arbitrary values', () => {
  for (const status of ITEM_STATUSES) assert.equal(itemEditError({ status }, 'Photographed'), null);
  for (const status of [null, undefined, '', ' ', 'ready', 'Needs review', 'Previously listed', 'not-a-real-inventory-state', 1, true, [], {}])
    assert.match(itemEditError({ status }, 'Photographed')!, /supported inventory status/);
  assert.equal(itemEditError({ notes: 'Keep history readable' }, 'Unknown historical status'), null);
  assert.match(itemEditError({ status: 'Archived' }, 'Sold')!, /Use Returns/);
});

test('creation identity survives client serialization and does not bind unrelated update timestamps', () => {
  const createdAt = new Date('2026-09-01T10:00:00.000Z');
  for (const value of [createdAt, createdAt.toISOString()]) {
    const request = withExpectedItemValues({ createdAt: value, status: 'Needs Info', brand: 'Before' }, { brand: 'After' });
    assert.equal(request.expectedValues.createdAt, createdAt.toISOString());
    assert.deepEqual(conflictingItemFields({ createdAt, status: 'Needs Info', brand: 'Before', updatedAt: new Date() }, request.expectedValues), []);
    assert.deepEqual(conflictingItemFields({ createdAt: new Date('2026-09-02T10:00:00.000Z'), status: 'Needs Info', brand: 'Before' }, request.expectedValues), ['createdAt']);
  }
});

test("edit expectations detect a sale recorded after an editor loaded", () => {
  const before = { status: "Ready", brand: "Old", salePrice: null };
  const request = withExpectedItemValues(before, { brand: "Corrected" });
  assert.deepEqual(request.expectedValues, { brand: "Old", status: "Ready" });
  assert.equal("salePrice" in request, false);
  assert.deepEqual(conflictingItemFields({ ...before, status: "Sold", salePrice: 27 }, request.expectedValues), ["status"]);
});

test("field expectations reject conflicting text but allow unrelated photo timestamps", () => {
  const request = withExpectedItemValues({ status: "Needs Info", brand: "Old", updatedAt: "before" }, { brand: "Corrected" });
  assert.deepEqual(conflictingItemFields({ status: "Needs Info", brand: "Old", updatedAt: "after" }, request.expectedValues), []);
  assert.deepEqual(conflictingItemFields({ status: "Needs Info", brand: "Another edit" }, request.expectedValues), ["brand"]);
});

test("explicit clears and nullable money do not collapse into the same expectation", () => {
  const request = withExpectedItemValues({ status: "Needs Info", keyDetails: null, itemCost: null }, { keyDetails: "", itemCost: 0 });
  assert.equal(request.expectedValues.keyDetails, null);
  assert.equal(request.expectedValues.itemCost, null);
  assert.deepEqual(conflictingItemFields({ status: "Needs Info", keyDetails: "", itemCost: 0 }, request.expectedValues), ["keyDetails", "itemCost"]);
});

test("shipping expectations use the stored fulfillment timestamp", () => {
  const at = "2026-09-19T12:00:00.000Z";
  const request = withExpectedItemValues({ status: "Sold", shippedAt: at }, { shipped: false });
  assert.deepEqual(request.expectedValues, { shippedAt: at, status: "Sold" });
  assert.deepEqual(conflictingItemFields({ status: "Sold", shippedAt: new Date(at) }, request.expectedValues), []);
});

test("malformed or unrelated expected-value fields are rejected", () => {
  const allowed = ["brand", "status", "itemCost"];
  assert.equal(expectedItemValuesError(undefined, allowed), null);
  assert.equal(expectedItemValuesError({ brand: "Old", itemCost: null }, allowed), null);
  for (const value of [null, [], "bad", { unknown: 1 }, { brand: {} }, { itemCost: Infinity }, JSON.parse('{"__proto__":"bad"}')])
    assert.ok(expectedItemValuesError(value, allowed));
});

test("item money and fulfillment rules are enforced independently of the screen", () => {
  for (const value of [-1, NaN, Infinity, "no", true, [], {}, " "]) assert.ok(itemEditError({ itemCost: value }, "Sold"));
  assert.equal(itemEditError({ salePrice: 0, itemCost: null }, "Sold"), null);
  assert.ok(itemEditError({ shipped: true }, "Ready"));
  assert.ok(itemEditError({ shipped: true, status: "Ready" }, "Sold"));
  assert.ok(itemEditError({ status: "Needs Info" }, "Sold"));
  assert.equal(itemEditError({ shipped: false }, "Ready"), null);
  assert.equal(itemEditError({ shipped: true }, "Sold"), null);
});

test("buyer-paid shipping accepts unknown, explicit zero and valid amounts while rejecting invalid money", () => {
  for (const shippingCharged of [null, "", 0, "0", 7.5, "7.50"]) assert.equal(itemEditError({ shippingCharged }, "Sold"), null);
  for (const shippingCharged of [-1, NaN, Infinity, "no", true, [], {}, " "]) assert.ok(itemEditError({ shippingCharged }, "Sold"));
});

test("operator corrections retain old evidence as history without certifying a new value from an old tag", () => {
  const before = { brand: "Gildan", evidenceJson: JSON.stringify({ brand: { value: "Gildan", status: "verified", rawOcr: "Gildan", sources: ["ocr"] } }) };
  const result = JSON.parse(editedEvidence(before, { brand: "Nike" })!);
  assert.equal(result.brand.value, "Nike"); assert.equal(result.brand.status, "confirmed");
  assert.equal(result.brand.rawOcr, undefined); assert.equal(result.brand.previous.rawOcr, "Gildan");
  assert.equal(evidenceForValue(result.brand, "Adidas")?.rawOcr, undefined);
  assert.equal(editedEvidence(before, { brand: "Gildan" }), undefined);
});
