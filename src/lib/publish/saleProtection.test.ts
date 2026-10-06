import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { beginDelistAttempt, finishDelistAttempt, recordConfirmedSale, recoverDelistAttempts, removalBacklog, type ConfirmedSaleObservation } from "./saleProtection.ts";
import { beginPublishAttempt, completePublishAttempt, recoverPublishAttempts, resolvePublishAttempt, publicationVerificationRevision, publishBlockReason } from "./attempts.ts";
import { processRemovalQueue } from "./removalQueue.ts";
import type { AppSettingsData } from "../types.ts";

const observation: ConfirmedSaleObservation = {
  marketplace: "depop", listingId: "seller-shirt", listingUrl: "https://www.depop.com/products/seller-shirt/",
  reference: "receipt-123", classification: "confirmed_sale",
};
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-sale-protection-"));
  const file = path.join(dir, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    await db.$disconnect();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const item = await db.item.create({ data: { sku: "SALE-TEST", status: "Ready for Nifty", listedPrice: 25, itemCost: 6, niftyTitle: "Preserved Nifty copy" } });
  const source = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "depop", externalListingId: observation.listingId, externalUrl: observation.listingUrl } });
  const ebay = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "ebay", externalListingId: "123456789012", externalUrl: "https://www.ebay.com/itm/123456789012", attemptCount: 3 } });
  const poshmark = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "poshmark", externalListingId: "abcdef123456789012345678", externalUrl: "https://poshmark.com/listing/abcdef123456789012345678" } });
  const run = await db.publishRun.create({ data: { status: "running", marketplacesJson: '["etsy"]', totalJobs: 1 } });
  const queued = await db.publishJob.create({ data: { itemId: item.id, runId: run.id, marketplace: "etsy", status: "queued" } });
  return { db, item, source, ebay, poshmark, run, queued };
}

test("one confirmed sale atomically records Sold, cancels future uploads, and queues the other listings", async (t) => {
  const { db, item, source, ebay, poshmark, queued } = await fixture(t);
  const result = await recordConfirmedSale(db, observation);
  assert.equal(result.outcome, "recorded");
  assert.deepEqual(result.pending, [ebay.id, poshmark.id]);
  const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.status, "Sold"); assert.equal(saved.platformSold, "Depop");
  for (const key of ["niftyStatus", "niftyTitle", "listedPrice", "salePrice", "itemCost", "uploadCount"] as const) assert.equal(saved[key], item[key]);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: source.id } })).status, "sold");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: queued.id } })).status, "cancelled");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).attemptCount, 0);
});

test("receipt actuals feed earned revenue without asking-price substitution or replay overwrites", async (t) => {
  const { db, item, poshmark } = await fixture(t);
  const financials = { currency: "USD" as const, salePriceCents: 1999, shippingChargedCents: 589, soldAt: "2026-09-11T00:00:00.000Z" };
  await recordConfirmedSale(db, { ...observation, financials });
  let saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.salePrice, 19.99); assert.equal(saved.shippingCharged, 5.89);
  assert.equal(saved.dateSold?.toISOString(), financials.soldAt); assert.equal(saved.earningsReady, true);
  assert.equal(saved.listedPrice, 25); assert.equal(saved.itemCost, 6);
  await db.item.update({ where: { id: item.id }, data: { salePrice: 18, shippingCharged: 0 } });
  await recordConfirmedSale(db, { ...observation, financials });
  await recordConfirmedSale(db, { marketplace: "poshmark", listingId: poshmark.externalListingId!, listingUrl: poshmark.externalUrl!, reference: "second-sale", classification: "confirmed_sale", financials: { ...financials, salePriceCents: 5000 } });
  saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.salePrice, 18); assert.equal(saved.shippingCharged, 0); assert.equal(saved.platformSold, "Depop");
});

test("later verified receipt amounts fill blanks without resetting removals", async t => {
  const { db, item, ebay } = await fixture(t);
  await recordConfirmedSale(db, observation);
  const attempt = await beginDelistAttempt(db, ebay.id);
  await recordConfirmedSale(db, { ...observation, financials: { currency: "USD", salePriceCents: 1599 } });
  const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.salePrice, 15.99); assert.equal(saved.shippingCharged, null); assert.equal(saved.dateSold, null);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).attemptCount, attempt!.attempt);
});

test("sale-platform case and outer whitespace do not create a second sale or discard receipt actuals", async t => {
  const variants = [['depop', 'depop'], ['ebay', ' EBAY '], ['poshmark', 'pOsHmArK'], ['etsy', ' ETSY'], ['mercari', 'mercari ']] as const;
  for (const [marketplace, storedName] of variants) await t.test(marketplace, async t => {
    const { db, item } = await fixture(t);
    let source = await db.marketplaceListing.findUnique({ where: { itemId_marketplace: { itemId: item.id, marketplace } } });
    if (!source) source = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace,
      externalListingId: marketplace === 'mercari' ? 'm12345678901' : '123456789012',
      externalUrl: marketplace === 'mercari' ? 'https://www.mercari.com/us/item/m12345678901/' : 'https://www.etsy.com/listing/123456789012' } });
    const shippedAt = new Date('2026-09-20T12:00:00.000Z');
    await db.item.update({ where: { id: item.id }, data: { status: 'Sold', platformSold: storedName, shippedAt } });
    const result = await recordConfirmedSale(db, { marketplace, listingId: source.externalListingId!, listingUrl: source.externalUrl!,
      reference: 'received-sale', classification: 'confirmed_sale', financials: { currency: 'USD', salePriceCents: 1999, shippingChargedCents: 0, soldAt: '2026-09-19T12:00:00.000Z' } });
    assert.equal(result.outcome, 'recorded'); assert.equal(result.doubleSale, false);
    assert.equal(await db.problemLog.count({ where: { type: 'DIRECT_DOUBLE_SALE' } }), 0);
    const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(saved.platformSold, storedName); assert.equal(saved.salePrice, 19.99); assert.equal(saved.shippingCharged, 0);
    assert.equal(saved.dateSold?.toISOString(), '2026-09-19T12:00:00.000Z'); assert.deepEqual(saved.shippedAt, shippedAt);
    assert.equal(saved.itemCost, 6); assert.equal(saved.listedPrice, 25);
    assert.equal(await db.marketplaceListing.count({ where: { itemId: item.id, id: { not: source.id }, status: 'delist_pending' } }),
      await db.marketplaceListing.count({ where: { itemId: item.id } }) - 1);
  });
});

test("cosmetic platform differences allow missing actuals on a replay while preserving corrections and removal attempts", async t => {
  const { db, item, ebay } = await fixture(t);
  await recordConfirmedSale(db, observation);
  await db.item.update({ where: { id: item.id }, data: { platformSold: ' dEpOp ' } });
  const attempt = (await beginDelistAttempt(db, ebay.id))!;
  const financials = { currency: 'USD' as const, salePriceCents: 1600, shippingChargedCents: 400, soldAt: '2026-09-19T00:00:00.000Z' };
  assert.equal((await recordConfirmedSale(db, { ...observation, financials })).outcome, 'already_recorded');
  let saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.salePrice, 16); assert.equal(saved.shippingCharged, 4);
  await db.item.update({ where: { id: item.id }, data: { salePrice: 0, shippingCharged: 0 } });
  await recordConfirmedSale(db, { ...observation, financials });
  saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(saved.salePrice, 0); assert.equal(saved.shippingCharged, 0); assert.equal(saved.platformSold, ' dEpOp ');
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).attemptCount, attempt.attempt);
  assert.equal(await db.problemLog.count(), 0);
});

test("different or ambiguous sale-platform labels retain double-sale protection", async t => {
  for (const storedName of [' EBAY ', 'Depop / eBay', 'Depop shop']) await t.test(storedName, async t => {
    const { db, item } = await fixture(t);
    await db.item.update({ where: { id: item.id }, data: { status: 'Sold', platformSold: storedName } });
    const result = await recordConfirmedSale(db, { ...observation, financials: { currency: 'USD', salePriceCents: 5000 } });
    assert.equal(result.doubleSale, true);
    assert.equal(await db.problemLog.count({ where: { type: 'DIRECT_DOUBLE_SALE' } }), 1);
    const saved = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(saved.platformSold, storedName); assert.equal(saved.salePrice, null);
  });
});

test("an eBay sale queues and verifies removal on all three other native marketplaces", async (t) => {
  const { db, item, ebay } = await fixture(t);
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'etsy', externalListingId: '123456789012', externalUrl: 'https://www.etsy.com/listing/123456789012' } });
  const result = await recordConfirmedSale(db, { marketplace: 'ebay', listingId: ebay.externalListingId!, listingUrl: ebay.externalUrl!, reference: '12-12345-12345/123456789012', classification: 'confirmed_sale' });
  assert.equal(result.outcome, 'recorded');
  const calls: string[] = [];
  const removed = await processRemovalQueue(db, {} as AppSettingsData, { runWorker: async (_settings, request) => {
    calls.push(request.marketplace); return { outcome: 'ended', verified: true, submissionStarted: true };
  } });
  assert.deepEqual(new Set(calls), new Set(['depop', 'poshmark', 'etsy']));
  assert.equal(removed.processed.length, 3);
  assert.equal(await db.marketplaceListing.count({ where: { itemId: item.id, status: 'ended' } }), 3);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).status, 'sold');
});

test("a confirmed Mercari sale queues all four other marketplaces for removal", async t => {
  const { db, item } = await fixture(t);
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'etsy', externalListingId: '1234567890', externalUrl: 'https://www.etsy.com/listing/1234567890' } });
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'mercari', externalListingId: 'm12345678901', externalUrl: 'https://www.mercari.com/us/item/m12345678901/' } });
  const result = await recordConfirmedSale(db, { marketplace: 'mercari', listingId: 'm12345678901', listingUrl: 'https://www.mercari.com/us/item/m12345678901/', reference: 'm12345678901/m12345678901', classification: 'confirmed_sale' });
  assert.equal(result.outcome, 'recorded'); assert.equal(result.pending.length, 4);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).platformSold, 'Mercari');
  const targets = await db.marketplaceListing.findMany({ where: { itemId: item.id, status: 'delist_pending' }, select: { marketplace: true } });
  assert.deepEqual(new Set(targets.map(row => row.marketplace)), new Set(['depop','ebay','etsy','poshmark']));
});

test("replaying a receipt does not reset active removal attempts or override a manual exception", async (t) => {
  const { db, item, ebay } = await fixture(t);
  await recordConfirmedSale(db, observation);
  const attempt = (await beginDelistAttempt(db, ebay.id))!;
  assert.equal((await recordConfirmedSale(db, observation)).outcome, "already_recorded");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).attemptCount, attempt.attempt);
  await db.item.update({ where: { id: item.id }, data: { status: "Ready for Nifty" } });
  await recordConfirmedSale(db, observation);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
});

test("unknown identities remain visible in the removal backlog", async (t) => {
  const { db, item } = await fixture(t);
  const unknown = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "etsy", status: "unknown" } });
  const result = await recordConfirmedSale(db, observation);
  assert.deepEqual(result.unresolved, [unknown.id]);
  assert.ok((await removalBacklog(db)).some((row) => row.id === unknown.id && row.status === "unknown"));
  assert.equal(await db.problemLog.count({ where: { type: "DIRECT_DELIST_IDENTITY_MISSING" } }), 1);
  await recordConfirmedSale(db, observation);
  assert.equal(await db.problemLog.count(), 1);
});

test("a failed target transition rolls the sale and item status back together", async (t) => {
  const { db, item, source, queued } = await fixture(t);
  await db.$executeRawUnsafe("CREATE TRIGGER fail_removal BEFORE UPDATE ON MarketplaceListing WHEN NEW.status='delist_pending' BEGIN SELECT RAISE(ABORT, 'injected removal failure'); END");
  await assert.rejects(recordConfirmedSale(db, observation));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: source.id } })).status, "published");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: queued.id } })).status, "queued");
  await db.$executeRawUnsafe("DROP TRIGGER fail_removal");
  assert.equal((await recordConfirmedSale(db, observation)).outcome, "recorded");
});

test("a timed-out removal remains uncertain and only verified unavailability can finish it", async (t) => {
  const { db, ebay } = await fixture(t);
  assert.equal(await beginDelistAttempt(db, ebay.id), null);
  await recordConfirmedSale(db, observation);
  const attempt = (await beginDelistAttempt(db, ebay.id))!;
  assert.equal(await beginDelistAttempt(db, ebay.id), null);
  await finishDelistAttempt(db, { ...attempt, outcome: "ended", verified: false });
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).status, "delist_unknown");
  const retry = (await beginDelistAttempt(db, ebay.id))!;
  assert.equal(retry.attempt, 2);
  assert.equal(await finishDelistAttempt(db, { ...attempt, outcome: "ended", verified: true }), false);
  assert.equal(await finishDelistAttempt(db, { ...retry, outcome: "ended", verified: true }), true);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).status, "ended");
});

test("restart recovery preserves uncertainty without a second active claim", async (t) => {
  const { db, ebay } = await fixture(t);
  await recordConfirmedSale(db, observation);
  await beginDelistAttempt(db, ebay.id);
  assert.equal(await recoverDelistAttempts(db), 1);
  assert.equal(await recoverDelistAttempts(db), 0);
  assert.equal((await beginDelistAttempt(db, ebay.id))?.attempt, 2);
});

test("a later response cannot end a replacement listing identity", async (t) => {
  const { db, ebay } = await fixture(t);
  await recordConfirmedSale(db, observation);
  const attempt = (await beginDelistAttempt(db, ebay.id))!;
  await db.marketplaceListing.update({ where: { id: ebay.id }, data: { externalListingId: "999999999999" } });
  assert.equal(await finishDelistAttempt(db, { ...attempt, outcome: "ended", verified: true }), false);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).status, "delisting");
});

test("unmatched receipts and non-sale observations cannot choose an item by title", async (t) => {
  const { db, item } = await fixture(t);
  assert.equal((await recordConfirmedSale(db, { ...observation, listingId: "other-shirt", listingUrl: "https://depop.com/products/other-shirt/" })).outcome, "unmatched");
  await assert.rejects(recordConfirmedSale(db, { ...observation, classification: "not_sale" } as unknown as ConfirmedSaleObservation));
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
});

test("a second actual platform sale raises one fulfillment conflict and preserves the first platform", async (t) => {
  const { db, item, poshmark } = await fixture(t);
  await recordConfirmedSale(db, observation);
  const second: ConfirmedSaleObservation = { marketplace: "poshmark", listingId: poshmark.externalListingId!, listingUrl: poshmark.externalUrl!, reference: "other-order", classification: "confirmed_sale" };
  assert.equal((await recordConfirmedSale(db, second)).doubleSale, true);
  await recordConfirmedSale(db, second);
  assert.equal(await db.problemLog.count({ where: { type: "DIRECT_DOUBLE_SALE" } }), 1);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).platformSold, "Depop");
});

test("a publication reported after a sale is queued for removal immediately", async (t) => {
  const { db, item, queued } = await fixture(t);
  await db.publishJob.update({ where: { id: queued.id }, data: { status: "publishing" } });
  await beginPublishAttempt(db, queued.id);
  await recordConfirmedSale(db, observation);
  await completePublishAttempt(db, queued.id, { ok: true, externalListingId: "12345", externalUrl: "https://www.etsy.com/listing/12345/shirt" }, { price: 25, title: "Shirt" });
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { itemId_marketplace: { itemId: item.id, marketplace: "etsy" } } })).status, "delist_pending");
});

test("operator verification after a sale also queues removal and recovery preserves it", async (t) => {
  const { db, item, queued } = await fixture(t);
  await db.publishJob.update({ where: { id: queued.id }, data: { status: "publishing" } });
  await beginPublishAttempt(db, queued.id);
  await recoverPublishAttempts(db);
  await recordConfirmedSale(db, observation);
  const revision = publicationVerificationRevision(await db.publishJob.findUniqueOrThrow({ where: { id: queued.id } }),
    await db.marketplaceListing.findUniqueOrThrow({ where: { itemId_marketplace: { itemId: item.id, marketplace: "etsy" } } }));
  assert.equal((await resolvePublishAttempt(db, queued.id, "published", "https://www.etsy.com/listing/12345/shirt", revision)).ok, true);
  await db.publishJob.update({ where: { id: queued.id }, data: { status: "publishing" } });
  await recoverPublishAttempts(db);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { itemId_marketplace: { itemId: item.id, marketplace: "etsy" } } })).status, "delist_pending");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: queued.id } })).status, "cancelled");
  assert.ok(publishBlockReason({ status: "sold" }));
  assert.ok(publishBlockReason({ status: "delist_unknown" }));
});

test("a late publish response cannot overwrite an already confirmed sale on that listing", async (t) => {
  const { db, item, source, run } = await fixture(t);
  const job = await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: "depop", status: "publishing" } });
  await recordConfirmedSale(db, observation);
  await completePublishAttempt(db, job.id, { ok: true, externalListingId: observation.listingId, externalUrl: observation.listingUrl }, { price: 25, title: "Shirt" });
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: source.id } })).status, "sold");
});

test("repeated unverifiable removals stop for review rather than claiming success", async (t) => {
  const { db, ebay } = await fixture(t);
  await recordConfirmedSale(db, observation);
  const attempt = (await beginDelistAttempt(db, ebay.id, 1))!;
  await finishDelistAttempt(db, { ...attempt, outcome: "unknown" });
  assert.equal(await beginDelistAttempt(db, ebay.id, 1), null);
  const listing = await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } });
  assert.equal(listing.status, "delist_failed");
  assert.equal(listing.endedAt, null);
});

test("publication recovery neither reopens an ended sold-item listing nor claims an old ID was newly posted", async (t) => {
  const { db, item, ebay, run } = await fixture(t);
  await recordConfirmedSale(db, observation);
  const attempt = (await beginDelistAttempt(db, ebay.id))!;
  await finishDelistAttempt(db, { ...attempt, outcome: "ended", verified: true });
  const job = await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: "ebay", status: "publishing" } });
  await recoverPublishAttempts(db);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: ebay.id } })).status, "ended");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "cancelled");
});
