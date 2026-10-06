import test from "node:test";
import assert from "node:assert/strict";
import { intakeRunning, tryReserveIntake, releaseIntakePrep,
  tryReserveIncomingMutation, releaseIncomingMutation } from "./worker.ts";

test("an incoming writer excludes processing and other writers until released", () => {
  assert.equal(tryReserveIncomingMutation(), true);
  try {
    assert.equal(tryReserveIncomingMutation(), false);
    assert.equal(tryReserveIntake(), false);
    assert.equal(intakeRunning(), false, "an upload must not be reported as a running worker");
  } finally { releaseIncomingMutation(); }
  assert.equal(tryReserveIntake(), true);
  releaseIntakePrep();
});

test("both preparing and running intake exclude incoming changes", () => {
  assert.equal(tryReserveIntake(), true);
  try { assert.equal(tryReserveIncomingMutation(), false); }
  finally { releaseIntakePrep(); }
  const state = globalThis as unknown as { __bcaIntake?: unknown };
  const previous = state.__bcaIntake;
  state.__bcaIntake = {};
  try { assert.equal(tryReserveIncomingMutation(), false); }
  finally { state.__bcaIntake = previous; }
  assert.equal(tryReserveIncomingMutation(), true);
  releaseIncomingMutation();
});
