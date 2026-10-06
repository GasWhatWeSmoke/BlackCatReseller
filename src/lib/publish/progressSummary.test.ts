import test from "node:test";
import assert from "node:assert/strict";
import { progressSummary, uploadStageLabel, elapsedTime } from "./progressSummary.ts";
import type { StatusPayload } from "./uiTypes.ts";
import { beginUploadProgress, currentUploadPhase } from "./liveProgress.ts";
const run = { id: 1, status: "done", note: null, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:05:00Z" };

test("a finished run with an uncertain listing stays below 100% published", () => {
  const status: StatusPayload = { run: { ...run, totalJobs: 4, marketplaces: ["ebay", "depop"] }, marketplaces: [],
    byMarketplace: { ebay: { published: 2 }, depop: { published: 1, requires_review: 1 } },
    jobs: [{ jobId: 1, itemId: 1, sku: "000001", marketplace: "ebay", status: "published" },
      { jobId: 2, itemId: 1, sku: "000001", marketplace: "depop", status: "published" },
      { jobId: 3, itemId: 2, sku: "000002", marketplace: "ebay", status: "published" },
      { jobId: 4, itemId: 2, sku: "000002", marketplace: "depop", status: "requires_review" }] };
  const summary = progressSummary(status);
  assert.equal(summary.percent, 75); assert.equal(summary.attention, 1);
  assert.equal(summary.completedPieces, 1); assert.equal(summary.totalPieces, 2);
  assert.equal(summary.queued, 0); assert.equal(summary.active, 0);
});

test("retrying and cancelled listings do not count as successful publication", () => {
  const status: StatusPayload = { run: { ...run, totalJobs: 5, marketplaces: ["mercari"] }, marketplaces: [],
    byMarketplace: { mercari: { published: 1, publishing: 1, retrying: 1, cancelled: 1, failed: 1 } } };
  const p = progressSummary(status);
  assert.equal(p.percent, 20); assert.equal(p.queued, 1); assert.equal(p.cancelled, 1);
  assert.equal(p.active, 1); assert.equal(p.attention, 1);
  assert.equal(progressSummary({ run: null, marketplaces: [] }).percent, 0);
  assert.equal(uploadStageLabel("photos", 8), "Uploading 8 photos");
  assert.equal(uploadStageLabel("unknown"), "Preparing marketplace upload");
  assert.equal(elapsedTime("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:02:05Z")), "2m 5s");
});

test("split telemetry is scoped to its worker and removed at close", () => {
  const first = beginUploadProgress("ebay", "test-progress");
  try {
    first.feed('noise\nBLACKCAT_PROG'); first.feed('RESS {"stage":"photos","photoCount":8}\n');
    assert.equal(currentUploadPhase("ebay", "test-progress")?.stage, "photos");
    assert.equal(currentUploadPhase("ebay", "test-progress")?.photoCount, 8);
    first.feed('BLACKCAT_PROGRESS null\nBLACKCAT_PROGRESS {"stage":"made-up"}\n');
    assert.equal(currentUploadPhase("ebay", "test-progress")?.stage, "photos");
    assert.equal(currentUploadPhase("depop", "test-progress"), null);
    const newer = beginUploadProgress("ebay", "test-progress");
    first.close(); assert.equal(currentUploadPhase("ebay", "test-progress")?.stage, "opening");
    newer.close(); assert.equal(currentUploadPhase("ebay", "test-progress"), null);
  } finally { first.close(); }
});
