import assert from "node:assert/strict";
import test from "node:test";
import { unlistedBrands } from "./unlistedBrands.ts";

test("unrelated settings changes retain approvals; an explicit empty list revokes them", () => {
  assert.deepEqual(unlistedBrands({ enabled: true }, ["La Vida"]), ["La Vida"]);
  assert.deepEqual(unlistedBrands({ unlistedBrands: [] }, ["La Vida"]), []);
  assert.deepEqual(unlistedBrands({ unlistedBrands: [" La Vida ", "La Vida"] }), ["La Vida"]);
});

test("reject malformed or unbounded brand approvals", () => {
  for (const value of [null, true, "La Vida", {}, [3], [" "], ["x".repeat(101)], Array(101).fill("Brand")]) {
    assert.throws(() => unlistedBrands({ unlistedBrands: value }));
  }
});
