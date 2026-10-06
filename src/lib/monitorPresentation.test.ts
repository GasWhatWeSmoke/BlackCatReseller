import test from "node:test";
import assert from "node:assert/strict";
import { monitorPresentation } from "./monitorPresentation.ts";
import { createSaleMonitor } from "./publish/saleMonitor.ts";
test("closed-window monitoring is paused even when the preference is on", () => {
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => [], scan: async () => ({ state: "paused" }), remove: async () => ({ busy: false }) });
  const status = { ...monitor.snapshot(), enabled: true, windowOpen: false };
  assert.equal(monitorPresentation(status).tone, "paused");
  assert.equal(monitorPresentation({ ...status, windowOpen: true }).tone, "ready");
  assert.equal(monitorPresentation({ ...status, windowOpen: true, lastError: "Check Chrome" }).tone, "error");
});
