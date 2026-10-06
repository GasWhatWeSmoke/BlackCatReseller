// A progress bar that sits at 1% for six minutes reads as a hung app, and the operator's
// only recovery instinct is to kill a batch that was working fine. These tests pin the
// property that actually matters: every phase the worker reports moves the bar, and it
// moves in one direction. The regression they guard is real — hashing, EXIF and decoding
// a 429-photo drop used to map to nothing at all.
import test from "node:test";
import assert from "node:assert/strict";
import { intakeStage } from "./intake.ts";

const progress = (stage: string, extra: Record<string, unknown> = {}) =>
  intakeStage({ type: "progress", stage, ...extra });

test("every pre-grouping phase reports a distinct, advancing percent", () => {
  const points = [
    progress("scan", { total: 429 }),
    progress("hash", { done: 1, total: 429 }),
    progress("hash", { done: 429, total: 429 }),
    progress("exif", { done: 1, total: 429 }),
    progress("exif", { done: 429, total: 429 }),
    progress("sort", { orderSource: "filename" }),
    progress("decode", { done: 1, total: 429 }),
    progress("decode", { done: 429, total: 429 }),
    progress("group", { items: 103 }),
  ];
  for (const p of points) assert.ok(p, "every pre-grouping stage must map to a display state");
  const pcts = points.map((p) => p!.pct as number);
  for (const pct of pcts) assert.equal(typeof pct, "number");
  for (let i = 1; i < pcts.length; i += 1) {
    assert.ok(pcts[i] > pcts[i - 1], `stage ${i} (${pcts[i]}%) must advance past ${pcts[i - 1]}%`);
  }
});

test("the slow read phases are not collapsed into a single tick", () => {
  // The bug: hash/exif/decode each read every photo, so each needs real travel.
  const travel = (stage: string) =>
    (progress(stage, { done: 429, total: 429 })!.pct as number)
    - (progress(stage, { done: 0, total: 429 })!.pct as number);
  for (const stage of ["hash", "exif", "decode"]) {
    assert.ok(travel(stage) >= 5, `${stage} must span a visible slice of the bar`);
  }
});

test("counted phases show their own counts", () => {
  assert.equal(progress("hash", { done: 7, total: 429 })!.sub, "7/429");
  assert.equal(progress("exif", { done: 7, total: 429 })!.sub, "7/429");
  assert.equal(progress("decode", { done: 7, total: 429 })!.sub, "7/429");
  assert.equal(progress("scan", { total: 429 })!.label, "Found 429 photo(s)…");
});

test("a stage percent never runs backwards past the next stage", () => {
  // A miscounted total must not let decode overshoot grouping.
  const over = progress("decode", { done: 900, total: 429 })!.pct as number;
  assert.ok(over <= 42, "decode must stay below the group milestone");
  const under = progress("hash", { done: -5, total: 429 })!.pct as number;
  assert.ok(under >= 3, "a negative count must not drop below the stage floor");
});

test("the AI phase still owns the bulk of the bar", () => {
  const first = progress("enrich", { sku: "000001", i: 1, n: 100 })!.pct as number;
  const last = progress("enrich", { sku: "000100", i: 100, n: 100 })!.pct as number;
  assert.ok(first >= 42 && last <= 95);
  assert.ok(last - first > 45, "per-item AI work must remain the dominant slice");
});

test("decode's engine-unavailable warning is shown instead of a bogus count", () => {
  const p = progress("decode", { message: "QR engine unavailable — no stickers can be read" });
  assert.equal(p!.label, "QR engine unavailable — no stickers can be read");
  assert.equal(p!.sub, undefined);
});

test("unknown stages keep the previous display state", () => {
  assert.equal(progress("enrich_done", { sku: "000001", ok: true }), null);
  assert.equal(intakeStage({ type: "done" }), null);
  assert.deepEqual(intakeStage({ type: "persisting" }), { label: "Saving items…", pct: 96 });
});
