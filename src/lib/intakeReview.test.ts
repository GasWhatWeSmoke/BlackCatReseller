import test from "node:test";
import assert from "node:assert/strict";
import { validateIntakeCorrections, type IntakeManifest } from "./intakeReview.ts";
const manifest: IntakeManifest = { version: 1, photos: ["a", "b", "c", "d"].map((id, sequenceIndex) => ({ id, sequenceIndex, originalFilename: id + ".jpg", storedPath: "/sources/" + id })) };
test("corrections persist strict end marker readings and explicit order verification", () => {
  const first = validateIntakeCorrections({ expectedRevision: 0, markers: { b: "BC-000042" }, orderVerified: true }, manifest, null);
  const second = validateIntakeCorrections({ expectedRevision: 1, markers: { d: null } }, manifest, first);
  assert.equal(second.revision, 2); assert.equal(second.markers.b, "BC-000042"); assert.equal(second.markers.d, null); assert.equal(second.orderVerified, true);
});
test("stale corrections, cross-batch IDs and fabricated SKUs are rejected", () => {
  for (const input of [
    { expectedRevision: 3, markers: {} }, { expectedRevision: 0, markers: { other: "BC-000042" } },
    { expectedRevision: 0, markers: { b: "000042" } }, { expectedRevision: 0, markers: { b: "CODE-BC-000042-X" } },
    { expectedRevision: 0, markers: {}, order: ["a", "a", "c", "d"] },
  ]) assert.throws(() => validateIntakeCorrections(input, manifest, null));
});
test("changing photo order requires a new confirmation and explicit unchecking clears it", () => {
  const verified = validateIntakeCorrections({ expectedRevision: 0, markers: {}, orderVerified: true }, manifest, null);
  const reordered = validateIntakeCorrections({ expectedRevision: 1, markers: {}, order: ["b", "a", "c", "d"] }, manifest, verified);
  assert.equal(reordered.orderVerified, false);
  const unchecked = validateIntakeCorrections({ expectedRevision: 1, markers: {}, orderVerified: false }, manifest, verified);
  assert.equal(unchecked.orderVerified, false);
});
test("committed ranges cannot be reordered, relabelled or crossed during recovery", () => {
  const committed = new Set(["b", "c"]);
  assert.throws(() => validateIntakeCorrections({ expectedRevision: 0, markers: { b: "BC-000042" } }, manifest, null, committed));
  assert.throws(() => validateIntakeCorrections({ expectedRevision: 0, markers: {}, order: ["d", "b", "c", "a"] }, manifest, null, committed));
  assert.doesNotThrow(() => validateIntakeCorrections({ expectedRevision: 0, markers: { d: "BC-000043" } }, manifest, null, committed));
});
