import test from "node:test";
import assert from "node:assert/strict";
import { createSaleMonitor, SALE_CHECK_INTERVAL_MS } from "./saleMonitor.ts";

const checked = { state: "checked" as const, complete: true, recorded: 0, unmatched: 0, review: 0, confirmedReceipts: 0 };

test("removal-only ticks preserve sale results and frequency, and honor browser ownership and pause", async () => {
  let time = 0, enabled = true, busy = false, removes = 0, reads = 0;
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => enabled,
    frequency: async () => ({ checksPerDay: 2 }), targets: async () => ["depop"],
    scan: async () => { reads++; return { ...checked, recorded: 1 }; },
    remove: async () => { removes++; return { busy }; } });
  await monitor.tick();
  const first = monitor.snapshot();
  time = 30_000; busy = true;
  assert.equal(await monitor.tick(), false);
  assert.equal(reads, 1); assert.equal(removes, 3);
  assert.equal(monitor.snapshot().waitingForBrowser, true);
  time += 30_000; busy = false;
  await monitor.tick();
  assert.equal(reads, 1); assert.equal(removes, 4);
  assert.deepEqual(monitor.snapshot().platforms, first.platforms);
  assert.equal(monitor.snapshot().lastStartedAt, first.lastStartedAt);
  assert.equal(monitor.snapshot().lastFinishedAt, first.lastFinishedAt);
  assert.equal(monitor.snapshot().nextCheckAt, first.nextCheckAt);
  enabled = false; await monitor.tick();
  assert.equal(removes, 4);
});

test("saved frequency changes reschedule an idle monitor without starting a scan", async () => {
  let time = 0, minutes = 10, scans = 0;
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => true,
    frequency: async () => ({ intervalMinutes: minutes }), targets: async () => ["depop"],
    scan: async () => { scans++; return checked; }, remove: async () => ({ busy: false }) });
  await monitor.tick();
  assert.equal(monitor.snapshot().nextCheckAt, new Date(600_000).toISOString());
  time = 120_000;
  assert.equal(await monitor.tick(), false);
  minutes = 3;
  await monitor.reschedule();
  assert.equal(scans, 1);
  assert.equal(monitor.snapshot().nextCheckAt, new Date(180_000).toISOString());
  time = 180_000;
  assert.equal(await monitor.tick(), true);
  minutes = 60;
  time += 180_000;
  assert.equal(await monitor.tick(), false);
  assert.equal(monitor.snapshot().nextCheckAt, new Date(180_000 + 3_600_000).toISOString());
});

test("a frequency edit during an active scan applies after completion without overlap", async () => {
  let time = 0, minutes = 2, release!: () => void, entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => true,
    frequency: async () => ({ intervalMinutes: minutes }), targets: async () => ["depop"],
    scan: async () => { entered(); await gate; return checked; }, remove: async () => ({ busy: false }) });
  const running = monitor.tick(); await began;
  minutes = 30; await monitor.reschedule();
  assert.equal(monitor.snapshot().nextCheckAt, null);
  assert.equal(await monitor.tick(true), false);
  time = 240_000; release(); await running;
  assert.equal(monitor.snapshot().nextCheckAt, new Date(time + 1_800_000).toISOString());
});

test("daily targets reschedule from completion, preserve fractional minutes, and switch back to minutes", async () => {
  let time = 0, checksPerDay: number | null = 4, scans = 0;
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => true,
    frequency: async () => ({ intervalMinutes: 60, checksPerDay }), targets: async () => ["depop"],
    scan: async () => { scans++; time += 90_000; return checked; }, remove: async () => ({ busy: false }) });
  await monitor.tick();
  assert.equal(monitor.snapshot().nextCheckAt, new Date(90_000 + 6 * 3_600_000).toISOString());
  checksPerDay = 7;
  await monitor.reschedule();
  const due = Date.parse(monitor.snapshot().nextCheckAt!);
  assert.equal(due, Math.trunc(90_000 + 86_400_000 / 7));
  assert.equal(scans, 1);
  time = due - 1;
  assert.equal(await monitor.tick(), false);
  time = due;
  assert.equal(await monitor.tick(), true);
  assert.equal(scans, 2);
  checksPerDay = null;
  await monitor.reschedule();
  assert.equal(monitor.snapshot().nextCheckAt, new Date(time + 3_600_000).toISOString());
});

test("closing the desktop window pauses a cycle and reopening resumes on a later tick", async () => {
  let open = true, time = 0, scans = 0;
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => open,
    targets: async () => ["depop", "ebay"], scan: async () => { scans++; open = false; return checked; },
    remove: async () => ({ busy: false }) });
  await monitor.tick();
  assert.equal(scans, 1);
  assert.equal(monitor.snapshot().nextCheckAt, null);
  time = SALE_CHECK_INTERVAL_MS;
  assert.equal(await monitor.tick(), false);
  open = true;
  assert.equal(await monitor.tick(), true);
  assert.equal(scans, 2);
});

test("manual sync waits for an active cycle then checks every enabled marketplace once", async () => {
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["ebay"],
    manualTargets: async () => ["depop", "ebay", "etsy", "poshmark", "mercari"],
    scan: async market => { calls.push(market); if (calls.length === 1) { entered(); await gate; } return { ...checked, recorded: 1 }; },
    remove: async () => ({ busy: false }) });
  const background = monitor.tick(); await began;
  const manual = monitor.checkNow(), duplicate = monitor.checkNow();
  assert.equal(manual, duplicate);
  assert.deepEqual(calls, ["ebay"]);
  release(); await background;
  const result = await manual;
  assert.equal(result.active, false);
  assert.deepEqual(calls, ["ebay", "depop", "poshmark", "ebay", "etsy", "mercari"]);
  assert.equal(result.platforms.mercari.recorded, 1);
});

test("an explicit manual sync works without enabling background monitoring", async () => {
  const calls: string[] = [];
  const monitor = createSaleMonitor({ enabled: async () => false, targets: async () => [], manualTargets: async () => ["ebay"],
    scan: async market => { calls.push(market); return checked; }, remove: async () => ({ busy: false }) });
  await monitor.checkNow();
  assert.deepEqual(calls, ["ebay"]);
  assert.equal(monitor.snapshot().nextCheckAt, null);
  assert.equal(await monitor.tick(), false);
});

test("a busy new sync never reuses sale counts or checked states from the previous cycle", async () => {
  let busy = false;
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["ebay"],
    scan: async () => ({ ...checked, recorded: 1 }), remove: async () => ({ busy }) });
  await monitor.tick();
  assert.equal(monitor.snapshot().platforms.ebay.recorded, 1);
  busy = true;
  const next = await monitor.checkNow();
  assert.equal(next.waitingForBrowser, true);
  assert.equal(next.platforms.ebay.recorded, 0);
  assert.equal(next.platforms.ebay.state, "not_checked");
});

test("disabled monitoring does not scan or remove anything", async () => {
  const monitor = createSaleMonitor({ enabled: async () => false,
    targets: async () => { throw new Error("must not query targets"); },
    scan: async () => { throw new Error("must not scan"); }, remove: async () => { throw new Error("must not remove"); } });
  assert.equal(await monitor.tick(true), false);
  assert.equal(monitor.snapshot().active, false);
  assert.equal(monitor.snapshot().nextCheckAt, null);
});

test("removals take priority and successful limited readers never imply full platform support", async () => {
  const events: string[] = [], recoveries: boolean[] = [];
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["depop", "poshmark", "ebay", "etsy"],
    scan: async (marketplace) => { events.push(marketplace); return checked; },
    remove: async (_continue, recover) => { events.push("remove"); recoveries.push(recover); return { busy: false }; } });
  await monitor.tick();
  assert.deepEqual(events, ["remove", "depop", "remove", "poshmark", "remove", "ebay", "remove", "etsy", "remove"]);
  assert.deepEqual(recoveries, [true, false, false, false, false]);
  const status = monitor.snapshot();
  assert.equal(status.platforms.depop.state, "checked");
  assert.equal(status.platforms.poshmark.state, "limited");
  assert.equal(status.platforms.ebay.state, "limited");
  assert.equal(status.platforms.etsy.state, "limited");
  assert.ok(status.platforms.poshmark.limitation);
});

test("the monitor skips browsers when no direct listings exist", async () => {
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => [],
    scan: async () => { throw new Error("must not open browser"); }, remove: async () => ({ busy: false }) });
  await monitor.tick();
  assert.equal(monitor.snapshot().platforms.depop.state, "waiting");
  assert.equal(monitor.snapshot().platforms.poshmark.lastCheckedAt, null);
});

test("periodic ticks respect pacing while manual checks can run sooner", async () => {
  let time = 0, scans = 0;
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => true, targets: async () => ["depop"],
    scan: async () => { scans++; return checked; }, remove: async () => ({ busy: false }) });
  await monitor.tick();
  time = SALE_CHECK_INTERVAL_MS - 1;
  assert.equal(await monitor.tick(), false); assert.equal(scans, 1);
  await monitor.tick(true); assert.equal(scans, 2);
  time += SALE_CHECK_INTERVAL_MS;
  await monitor.tick(); assert.equal(scans, 3);
});

test("concurrent ticks cannot launch overlapping scans", async () => {
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["depop"],
    scan: async () => { calls++; entered(); await gate; return checked; }, remove: async () => ({ busy: false }) });
  const first = monitor.tick(); await began;
  assert.equal(monitor.snapshot().active, true);
  assert.equal(await monitor.tick(true), false);
  release(); await first;
  assert.equal(calls, 1); assert.equal(monitor.snapshot().active, false);
});

test("pause during a scan stops subsequent removals and the next platform", async () => {
  let enabled = true, removes = 0;
  const monitor = createSaleMonitor({ enabled: async () => enabled, targets: async () => ["depop", "poshmark"],
    scan: async (marketplace, shouldContinue) => {
      assert.equal(marketplace, "depop"); enabled = false;
      assert.equal(await shouldContinue(), false);
      return { state: "paused" };
    }, remove: async () => { removes++; return { busy: false }; } });
  await monitor.tick();
  assert.equal(removes, 1);
  assert.equal(monitor.snapshot().nextCheckAt, null);
  assert.equal(monitor.snapshot().platforms.poshmark.state, "not_checked");
});

test("a failed scanner does not hide its error or prevent another platform from checking", async () => {
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["depop", "poshmark"],
    scan: async (marketplace) => { if (marketplace === "depop") throw new Error("Sign in required"); return checked; },
    remove: async () => ({ busy: false }) });
  await monitor.tick();
  assert.equal(monitor.snapshot().platforms.depop.state, "failed");
  assert.equal(monitor.snapshot().platforms.depop.reason, "Sign in required");
  assert.equal(monitor.snapshot().platforms.poshmark.state, "limited");
});

test("a busy browser is a wait, and interrupted-removal recovery remains pending", async () => {
  let busy = true;
  const recoveries: boolean[] = [];
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => [],
    scan: async () => checked, remove: async (_continue, recover) => { recoveries.push(recover); return { busy }; } });
  await monitor.tick();
  assert.equal(monitor.snapshot().waitingForBrowser, true);
  busy = false; await monitor.tick(true);
  assert.deepEqual(recoveries, [true, true]);
  assert.equal(monitor.snapshot().waitingForBrowser, false);
});
