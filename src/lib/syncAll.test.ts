import test from "node:test";
import assert from "node:assert/strict";
import { syncAll } from "./syncAll.ts";
import { createSaleMonitor } from "./publish/saleMonitor.ts";

test("unified sync applies confirmed sales and removals before reporting completion", async () => {
  const events: string[] = [];
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["ebay", "mercari"],
    scan: async market => { events.push(market); return { state: "checked", complete: true, recorded: 1, unmatched: 0, review: 0, confirmedReceipts: 1 }; },
    remove: async () => { events.push("remove"); return { busy: false }; } });
  let saved = "";
  const result = await syncAll({ scan: () => monitor.checkNow(),
    backlog: async () => 0,
    saveSummary: async (_at, summary) => { saved = summary; } });
  assert.deepEqual(events, ["remove", "ebay", "remove", "mercari", "remove"]);
  assert.equal(result.ok, true);
  assert.equal(result.sold, 2);
  assert.equal(result.pendingRemovals, 0);
  assert.match(saved, /eBay, Mercari checked/);
});

test("partial scans and pending removals cannot be reported as a successful sync", async () => {
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["ebay"],
    scan: async () => ({ state: "failed", reason: "Sign in required", recorded: 0 }), remove: async () => ({ busy: false }) });
  const result = await syncAll({ scan: () => monitor.checkNow(),
    backlog: async () => 1, saveSummary: async () => {} });
  assert.equal(result.ok, false);
  assert.match(result.error!, /Sign in required/);
  assert.match(result.error!, /need removal/);
});

test("older unlinked receipts remain visible without counting them as new sales", async () => {
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["ebay"],
    scan: async () => ({ state: "checked", complete: true, recorded: 0, unmatched: 1, review: 0, confirmedReceipts: 0 }),
    remove: async () => ({ busy: false }) });
  const result = await syncAll({ scan: () => monitor.checkNow(), backlog: async () => 0, saveSummary: async () => {} });
  assert.equal(result.ok,true);
  assert.equal(result.sold,0);
  assert.equal(result.unlinkedReceipts,1);
  assert.match(result.summary,/1 older or unlinked receipt/);
});
