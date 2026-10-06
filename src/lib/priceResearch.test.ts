import test from "node:test";
import assert from "node:assert/strict";
import { comparableInput, researchLinks, researchQuery } from "./priceResearch.ts";
test("price references retain source, asking/sold distinction, and missing interest", () => {
  const raw = { url: "https://www.ebay.com/itm/123456789012", title: "Actual listing", kind: "active", price: 24.99 };
  assert.equal(comparableInput(raw).interest, null);
  assert.equal(comparableInput(raw).kind, "active");
  assert.equal(comparableInput({ ...raw, kind: "sold", interest: 0, interestKind: "watchers" }).interest, 0);
  for (const bad of [{ price: -1 }, { url: "https://localhost/itm/123456789012" }, { kind: "guess" }, { interest: 2 }]) assert.throws(() => comparableInput({ ...raw, ...bad }));
  assert.equal(researchQuery({ brand: "Unknown", itemType: "Jacket" }), "Jacket");
  assert.match(researchLinks("Levi's 501").sold, /LH_Sold=1/);
});
