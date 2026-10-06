import test from "node:test";
import assert from "node:assert/strict";
import { countPricingWork, priceDecision, pricingConfig, pricingEligible, recoverPricingRows } from "./pricingDraft.ts";
import { changeDraft, draftIdentity, draftKey } from "./itemDrafts.ts";

const down = { style: "down" as const, min: 5, max: 500 };
const item = { id: 1, createdAt: "2026-09-20T00:00:00.000Z", sku: "000001", status: "Needs Info", listedPrice: null as number | null };
const draft = changeDraft(draftKey("pricing", item), item, null, { listedPrice: "25." });

test("the Pricing badge includes unfinished drafts without double-counting unpriced rows", () => {
  assert.equal(countPricingWork([], [draft]), 1);
  assert.equal(countPricingWork([item], [draft]), 1);
  assert.equal(countPricingWork([{ ...item, id: 2 }], [draft]), 2);
  assert.equal(countPricingWork([{ ...item, createdAt: "2026-09-21T00:00:00.000Z" }], [draft]), 2);
  assert.equal(countPricingWork([], []), 0);
});

test("whole entries use the saved rounding preference while explicit decimals keep their price", () => {
  assert.deepEqual(priceDecision("25", down, null), { kind: "ready", price: 24.99 });
  assert.deepEqual(priceDecision("25", { ...down, style: "up" }, null), { kind: "ready", price: 25.99 });
  assert.deepEqual(priceDecision("25", { ...down, style: "off" }, null), { kind: "ready", price: 25 });
  for (const raw of ["25.00", "25.", " 25.0 "]) assert.deepEqual(priceDecision(raw, down, null), { kind: "ready", price: 25 });
  assert.deepEqual(priceDecision("25.01", down, null), { kind: "ready", price: 25.01 });
});

test("unusual prices require a confirmation for the exact value and settings", () => {
  const first = priceDecision("1", down, null); assert.equal(first.kind, "confirm");
  if (first.kind !== "confirm") throw new Error("Expected a confirmation");
  assert.deepEqual(priceDecision("1", down, first.token), { kind: "ready", price: 0.99 });
  assert.equal(priceDecision("2", down, first.token).kind, "confirm");
  assert.equal(priceDecision("1", { ...down, style: "up" }, first.token).kind, "confirm");
  assert.equal(priceDecision("1", { ...down, min: 10 }, first.token).kind, "confirm");
  assert.equal(priceDecision("0.01", down, null).kind, "confirm");
});

test("empty, malformed, zero, excessive precision and unsafe money inputs never save", () => {
  assert.equal(priceDecision(" ", down, null).kind, "empty");
  for (const raw of ["0", "0.00", "-1", ".", "0.004", "25.999", "NaN", "Infinity", "1e3", "0x10", "1,000", "999999999999999999999999"])
    assert.equal(priceDecision(raw, down, null).kind, "invalid", raw);
});

test("missing or failed pricing settings cannot silently enable a default rounding rule", () => {
  assert.deepEqual(pricingConfig({ priceNinetyNine: "off", priceWarnMin: 0, priceWarnMax: 900 }), { style: "off", min: 0, max: 900 });
  for (const bad of [null, {}, { priceNinetyNine: "bad", priceWarnMin: 5, priceWarnMax: 500 },
    { priceNinetyNine: "down", priceWarnMin: 10, priceWarnMax: 1 }]) assert.throws(() => pricingConfig(bad), /could not be verified/);
});

test("pricing eligibility preserves the pre-publication workflow and excludes sold history", () => {
  for (const status of ["Photographed", "Needs Info", "Ready", "Ready for Nifty"]) assert.ok(pricingEligible({ status }));
  for (const status of ["Sold", "Archived", "Removed", "Uploaded to Nifty"]) assert.equal(pricingEligible({ status }), false);
  assert.equal(pricingEligible({ status: "Ready", niftyStatus: "Published" }), false);
});

test("draft keys recover exact item identities without crossing editor scopes", () => {
  assert.deepEqual(draftIdentity(draft.key, "pricing"), { id: item.id, createdAt: item.createdAt });
  for (const key of ["pricing:01:" + item.createdAt, "pricing:NaN:bad", "review:1:" + item.createdAt])
    assert.throws(() => draftIdentity(key, "pricing"));
});

test("a price draft remains visible after another edit removes its item from unpriced results", async () => {
  const existing = { ...item, id: 2, sku: "000002" };
  const fetched: number[] = [];
  const result = await recoverPricingRows([existing], [draft], async id => { fetched.push(id); return { ...item, listedPrice: 40 }; });
  assert.deepEqual(fetched, [1]); assert.deepEqual(result.rows.map(row => row.id), [1, 2]);
  assert.equal(result.rows[0].listedPrice, 40); assert.deepEqual(result.unavailable, []);
});

test("missing, reused and unreadable saved items preserve separately identifiable local drafts", async () => {
  for (const read of [async () => null, async () => ({ ...item, createdAt: "2026-09-21T00:00:00.000Z" }),
    async () => { throw new Error("Database unavailable"); }]) {
    const result = await recoverPricingRows<typeof item>([], [draft], read);
    assert.equal(result.rows.length, 0); assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0].draft, draft);
  }
});

test("100 local price drafts recover in SKU order with at most four concurrent item reads", async () => {
  const items = Array.from({ length: 100 }, (_, n) => ({ ...item, id: n + 1, sku: String(n + 1).padStart(6, "0") }));
  const drafts = items.map(row => changeDraft(draftKey("pricing", row), row, null, { listedPrice: String(row.id) })).reverse();
  let active = 0, maxActive = 0;
  const result = await recoverPricingRows(items.slice(0, 20), drafts, async id => {
    active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return items[id - 1];
  });
  assert.equal(maxActive, 4); assert.equal(result.rows.length, 100); assert.deepEqual(result.rows, items);
  assert.deepEqual(result.unavailable, []);
});
