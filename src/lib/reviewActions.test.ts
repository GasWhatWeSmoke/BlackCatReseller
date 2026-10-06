import test from "node:test";
import assert from "node:assert/strict";
import { saveReviewItem, reviewQueueIndex } from "./reviewActions.ts";
import { withExpectedItemValues } from "./itemEdits.ts";

test("a conflicting review save keeps approval from starting and sends its saved-value guard", async () => {
  const calls: string[] = [];
  await assert.rejects(saveReviewItem(1, withExpectedItemValues({ brand: "Old", status: "Photographed" }, { brand: "Corrected", status: "Needs Info" }), true,
    async (url, init) => {
      calls.push(url);
      assert.deepEqual(JSON.parse(String(init.body)).expectedValues, { brand: "Old", status: "Photographed" });
      return Response.json({ code: "ITEM_EDIT_CONFLICT", error: "Item changed; draft kept" }, { status: 409 });
    }), /Item changed/);
  assert.deepEqual(calls, ["/api/items/1"]);
});
test("a failed item save cannot request approval or report readiness", async () => {
  const calls: string[] = [];
  await assert.rejects(saveReviewItem(1, { brand: "Nike" }, true, async url => {
    calls.push(url); return Response.json({ error: "Save refused" }, { status: 500 });
  }), /Save refused/);
  assert.deepEqual(calls, ["/api/items/1"]);
});
test("approval must finish successfully and draft saves never approve", async () => {
  const request = async (url: string) => url.endsWith("/ready") ? Response.json({ ok: false, error: "GATE_FAILED", missing: ["price"] }, { status: 422 }) : Response.json({ item: { id: 1, updatedAt: "now" } });
  await assert.rejects(saveReviewItem(1, {}, true, request), /approval needs: price/);
  assert.equal((await saveReviewItem(1, {}, false, request)).approved, false);
  assert.equal(reviewQueueIndex(0, 0), 0); assert.equal(reviewQueueIndex(-1, 1), 0);
});
