import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "../types.ts";
import { claimBrowser, browserHolder, releaseBrowser } from "../browserCoordinator.ts";
import { processRemovalQueue } from "./removalQueue.ts";
import { createSaleMonitor } from "./saleMonitor.ts";

test("temporary pre-submit failures retain a bounded availability-check retry", async t => {
  const { db, listing, settings } = await fixture(t);
  for (const reason of ["TimeoutError: menu detached", "RuntimeError: Native Chrome connection did not complete",
    "RuntimeError: The Chrome crawler is busy with another item",
    "RuntimeError: Could not verify the existing Chrome session; try again when it responds"]) {
    await db.marketplaceListing.update({ where: { id: listing.id }, data: { status: "delist_pending", attemptCount: 0 } });
    await processRemovalQueue(db, settings, { runWorker: async () => ({ outcome: "failed", verified: false, submissionStarted: false, reason }) });
    const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(saved.status, "delist_unknown");
    assert.equal(saved.lastError, reason);
    const verify = async () => ({ outcome: "ended" as const, verified: true, submissionStarted: false });
    assert.equal((await processRemovalQueue(db, settings, { now: saved.lastAttemptAt!, runWorker: verify })).processed.length, 0);
    assert.equal((await processRemovalQueue(db, settings, { now: new Date(saved.lastAttemptAt!.getTime() + 60_001), runWorker: verify })).processed.length, 1);
    assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "ended");
  }
});

test("startup recovers previously misclassified Chrome failures while preserving attempts and review boundaries", async t => {
  const { db, item, listing, settings } = await fixture(t);
  const reason = "RuntimeError: Could not verify the existing Chrome session; try again when it responds";
  const lastAttemptAt = new Date(Date.now() - 120_000);
  await db.marketplaceListing.update({ where: { id: listing.id }, data: {
    status: "delist_failed", attemptCount: 1, lastAttemptAt, lastError: reason,
  } });
  const blocked = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "ebay",
    externalListingId: "123456789012", externalUrl: "https://www.ebay.com/itm/123456789012",
    status: "delist_failed", attemptCount: 1, lastAttemptAt, lastError: "Sign in required" } });
  const exhausted = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "mercari",
    externalListingId: "m12345678901", externalUrl: "https://www.mercari.com/us/item/m12345678901/",
    status: "delist_failed", attemptCount: 4, lastAttemptAt, lastError: reason } });
  const unsoldItem = await db.item.create({ data: { sku: "RECOVERED-STOCK", status: "Listed" } });
  const unsold = await db.marketplaceListing.create({ data: { itemId: unsoldItem.id, marketplace: "depop",
    externalListingId: "seller-other", externalUrl: "https://www.depop.com/products/seller-other/",
    status: "delist_failed", attemptCount: 1, lastAttemptAt, lastError: reason } });
  const result = await processRemovalQueue(db, settings, { recoverInterrupted: true, runWorker: async (_, request) => {
    assert.equal(request.listingId, listing.id); assert.equal(request.attempt, 2);
    assert.equal(request.externalListingId, listing.externalListingId);
    return { outcome: "ended", verified: true, submissionStarted: false };
  } });
  assert.equal(result.processed.length, 1);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "ended");
  for (const row of [blocked, exhausted, unsold]) {
    const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(saved.status, "delist_failed"); assert.equal(saved.attemptCount, row.attemptCount);
    assert.equal(saved.lastError, row.lastError);
  }
});

test("repeated temporary failures stop after four browser attempts and retain a visible failure", async t => {
  const { db, listing, settings } = await fixture(t);
  let calls = 0;
  const fail = async () => { calls++; return { outcome: "failed" as const, verified: false, submissionStarted: false, reason: "TimeoutError: blocked control" }; };
  for (let attempt = 0; attempt < 5; attempt++) {
    const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
    await processRemovalQueue(db, settings, { now: new Date((saved.lastAttemptAt?.getTime() ?? Date.now()) + 60_001), runWorker: fail });
  }
  const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.equal(calls, 4); assert.equal(saved.attemptCount, 4); assert.equal(saved.status, "delist_failed");
  assert.match(saved.lastError!, /manual review after repeated attempts/);
});

test("a transient removal recovers between twice-daily scans without checking another order", async t => {
  const { db, listing, settings } = await fixture(t);
  let time = Date.now(), reads = 0, calls = 0;
  const monitor = createSaleMonitor({ now: () => time, enabled: async () => true,
    frequency: async () => ({ checksPerDay: 2 }), targets: async () => ["depop"],
    scan: async () => { reads++; return { state: "checked", complete: true, recorded: 0, unmatched: 0, review: 0, confirmedReceipts: 0 }; },
    remove: async (shouldContinue, recoverInterrupted) => processRemovalQueue(db, settings, { shouldContinue, recoverInterrupted, now: new Date(time),
      runWorker: async () => ++calls === 1
        ? { outcome: "failed", verified: false, submissionStarted: false, reason: "TimeoutError: menu detached" }
        : { outcome: "ended", verified: true, submissionStarted: false } }),
  });
  await monitor.tick();
  assert.equal(calls, 1); assert.equal(reads, 1);
  const scheduled = monitor.snapshot().nextCheckAt;
  const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
  time = saved.lastAttemptAt!.getTime() + 60_001;
  await monitor.tick();
  assert.equal(calls, 2); assert.equal(reads, 1);
  assert.equal(monitor.snapshot().nextCheckAt, scheduled);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "ended");
});

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-removal-queue-"));
  const file = path.join(root, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    releaseBrowser();
    await db.$disconnect();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const item = await db.item.create({ data: { sku: "QUEUE-TEST", status: "Sold", niftyTitle: "Preserved" } });
  const listing = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "poshmark",
    status: "delist_pending", externalListingId: "abcdef123456789012345678", externalUrl: "https://poshmark.com/listing/abcdef123456789012345678" } });
  const settings = { dataRoot: root, logsPath: root } as AppSettingsData;
  return { db, item, listing, settings };
}

test("a Nifty upload prevents removal from reserving an attempt or starting a browser", async (t) => {
  const { db, listing, settings } = await fixture(t);
  assert.equal(claimBrowser("Nifty upload"), true);
  const result = await processRemovalQueue(db, settings, { runWorker: async () => { throw new Error("must not start"); } });
  assert.equal(result.busy, true);
  assert.equal(browserHolder(), "Nifty upload");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).attemptCount, 0);
});

test("the queue reserves the exact sold listing, holds the browser and saves verified removal", async (t) => {
  const { db, item, listing, settings } = await fixture(t);
  const result = await processRemovalQueue(db, settings, { runWorker: async (_settings, request) => {
    assert.equal(request.listingId, listing.id);
    assert.equal(request.externalListingId, listing.externalListingId);
    assert.equal(request.attempt, 1);
    assert.equal(claimBrowser("competing upload"), false);
    assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "delisting");
    return { outcome: "ended", verified: true };
  } });
  assert.deepEqual(result.processed, [{ listingId: listing.id, outcome: "ended", saved: true }]);
  assert.equal(browserHolder(), null);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "ended");
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).niftyTitle, "Preserved");
});

test("an interrupted worker remains unknown, waits before retry and then verifies without reposting", async (t) => {
  const { db, listing, settings } = await fixture(t);
  await processRemovalQueue(db, settings, { runWorker: async () => { throw new Error("worker interrupted"); } });
  assert.equal(browserHolder(), null);
  const saved = await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.equal(saved.status, "delist_unknown");
  const retry = async () => ({ outcome: "ended" as const, verified: true });
  assert.equal((await processRemovalQueue(db, settings, { now: saved.lastAttemptAt!, runWorker: retry })).processed.length, 0);
  assert.equal((await processRemovalQueue(db, settings, { now: new Date(saved.lastAttemptAt!.getTime() + 60_001), runWorker: retry })).processed.length, 1);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).attemptCount, 2);
});

test("unsupported targets, manual exceptions and deterministic failures stay out of automatic attempts", async (t) => {
  const { db, item, listing, settings } = await fixture(t);
  const unsupported = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "amazon", status: "delist_pending",
    externalListingId: "unsupported", externalUrl: "https://www.amazon.com/dp/unsupported" } });
  await db.item.update({ where: { id: item.id }, data: { status: "Ready for Nifty" } });
  assert.equal((await processRemovalQueue(db, settings)).processed.length, 0);
  await db.item.update({ where: { id: item.id }, data: { status: "Sold" } });
  await processRemovalQueue(db, settings, { runWorker: async () => ({ outcome: "failed", verified: false, reason: "Sign in required" }) });
  assert.equal((await processRemovalQueue(db, settings)).processed.length, 0);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "delist_failed");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: unsupported.id } })).attemptCount, 0);
});

test("a stale worker cannot end a replaced listing", async (t) => {
  const { db, listing, settings } = await fixture(t);
  const result = await processRemovalQueue(db, settings, { runWorker: async () => {
    await db.marketplaceListing.update({ where: { id: listing.id }, data: {
      status: "published", externalListingId: "bbbbbb123456789012345678", externalUrl: "https://poshmark.com/listing/bbbbbb123456789012345678",
    } });
    return { outcome: "ended", verified: true };
  } });
  assert.equal(result.processed[0].saved, false);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "published");
});

test("a Depop target uses the same durable queue without consuming another platform's attempt", async (t) => {
  const { db, listing, settings } = await fixture(t);
  await db.marketplaceListing.update({ where: { id: listing.id }, data: { marketplace: "depop",
    externalListingId: "seller-shirt", externalUrl: "https://www.depop.com/products/seller-shirt/" } });
  const result = await processRemovalQueue(db, settings, { runWorker: async (_settings, request) => {
    assert.equal(request.marketplace, "depop");
    assert.equal(request.externalListingId, "seller-shirt");
    return { outcome: "ended", verified: true };
  } });
  assert.equal(result.processed[0].saved, true);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "ended");
});

test("pausing between removals finishes the current result without reserving the next listing", async (t) => {
  const { db, listing, settings } = await fixture(t);
  const item = await db.item.create({ data: { sku: "SECOND-SOLD", status: "Sold" } });
  const next = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "depop", status: "delist_pending",
    externalListingId: "seller-other", externalUrl: "https://www.depop.com/products/seller-other/" } });
  let enabled = true;
  const result = await processRemovalQueue(db, settings, { shouldContinue: async () => enabled, runWorker: async () => {
    enabled = false; return { outcome: "ended", verified: true };
  } });
  assert.equal(result.processed.length, 1);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } })).status, "ended");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: next.id } })).attemptCount, 0);
});
