import test from "node:test";
import assert from "node:assert/strict";
import { AI_SKIPPED_BY_OPERATOR, intakeFeedback, isAiSkipped } from "./intakeOutcome.ts";

test("only the saved operator choice is classified as skipped", () => {
  assert.ok(isAiSkipped(AI_SKIPPED_BY_OPERATOR));
  assert.ok(isAiSkipped(` ${AI_SKIPPED_BY_OPERATOR} `));
  for (const error of [null, undefined, "", "Vision unavailable", "Image decode failed", "AI identification skipped unexpectedly"])
    assert.equal(isAiSkipped(error), false);
});

test("intentional no-AI intake is informational and real failures remain warnings", () => {
  const skipped = intakeFeedback({ itemsCreated: 100, aiSkipped: 100, aiTotal: 100 });
  assert.equal(skipped.ok, true); assert.equal(skipped.tone, "message");
  assert.match(skipped.text, /skipped for 100/); assert.doesNotMatch(skipped.text, /failed/i);
  const mixed = intakeFeedback({ itemsCreated: 5, aiTotal: 5, aiSkipped: 3, aiFailed: 1, aiFirstError: "Invalid model output" });
  assert.equal(mixed.ok, false); assert.equal(mixed.tone, "warning");
  assert.match(mixed.text, /failed for 1 of 2 attempted/); assert.match(mixed.text, /Invalid model output/);
  assert.match(mixed.text, /skipped for 3/);
});

test("duplicates are a successful no-op and do not hide remaining work", () => {
  const duplicates = intakeFeedback({ duplicatesSkipped: 300 });
  assert.equal(duplicates.ok, true); assert.equal(duplicates.tone, "message");
  assert.match(duplicates.text, /Skipped 300 identical photo/);
  assert.doesNotMatch(duplicates.text, /No items found|delete|sticker/i);
  const mixed = intakeFeedback({ itemsCreated: 1, duplicatesSkipped: 10, collisions: 2, problems: 1 });
  assert.equal(mixed.ok, false); assert.equal(mixed.tone, "warning");
  for (const text of [/Added 1/, /Skipped 10/, /2 SKU conflict/, /1 problem/]) assert.match(mixed.text, text);
});

test("failed and empty imports receive actionable messages instead of success", () => {
  const failed = intakeFeedback({ problems: 4 });
  assert.equal(failed.ok, false); assert.match(failed.text, /4 problem/);
  assert.doesNotMatch(failed.text, /sticker/);
  const empty = intakeFeedback({});
  assert.equal(empty.ok, false); assert.equal(empty.tone, "warning"); assert.match(empty.text, /SKU sticker/);
});
