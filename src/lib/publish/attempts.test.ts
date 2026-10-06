import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyRelistPrice } from "./relistPricing.ts";
import type { CanonicalListing } from "./types.ts";
import {
  beginPublishAttempt, completePublishAttempt, listingIdentity, publishBlockReason,
  recordUnsubmittedAttempt, recoverPublishAttempts, resolvePublishAttempt, publicationVerificationRevision,
} from "./attempts.ts";

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-publish-recovery-"));
  const database = path.join(dir, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), database);
  const db = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    await db.$disconnect();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const item = await db.item.create({ data: { sku: "RECOVERY-TEST" } });
  const run = await db.publishRun.create({ data: { status: "running", marketplacesJson: '["depop"]', totalJobs: 1 } });
  const job = await db.publishJob.create({ data: { itemId: item.id, runId: run.id, marketplace: "depop", status: "publishing", attemptCount: 1 } });
  const listing = () => db.marketplaceListing.findUnique({ where: { itemId_marketplace: { itemId: item.id, marketplace: "depop" } } });
  const revision = async () => publicationVerificationRevision(await db.publishJob.findUniqueOrThrow({ where: { id: job.id } }), (await listing())!);
  return { db, item, run, job, listing, revision };
}

test("a preserved marketplace price survives an unsubmitted retry and links to the verified replacement", async t => {
  const { db, item, job, listing } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { listedPrice: 44.99 } });
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "depop", status: "ended", price: 31.49,
    externalListingId: "seller-old", externalUrl: "https://www.depop.com/products/seller-old/" } });
  const copy = { itemId: item.id, sku: item.sku, price: 44.99, title: "Reviewed title" } as CanonicalListing;
  assert.equal(applyRelistPrice(copy, await listing(), "preserve_marketplace").price, 31.49);
  assert.equal(await beginPublishAttempt(db, job.id), null);
  await recordUnsubmittedAttempt(db, job.id, "Form stopped before submission");
  const retryCopy = applyRelistPrice(copy, await listing(), "preserve_marketplace");
  assert.equal(retryCopy.price, 31.49);
  assert.equal(await beginPublishAttempt(db, job.id), null);
  await completePublishAttempt(db, job.id, { ok: true, externalListingId: "seller-new",
    externalUrl: "https://www.depop.com/products/seller-new/" }, retryCopy);
  const published = await listing();
  assert.equal(published?.price, 31.49); assert.equal(published?.externalListingId, "seller-new");
  assert.equal(published?.title, "Reviewed title");
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).listedPrice, 44.99);
});

test("a crash after a browser reservation blocks another publication, including after recovery runs twice", async (t) => {
  const { db, job, listing } = await fixture(t);
  assert.equal(await beginPublishAttempt(db, job.id), null);
  assert.equal((await listing())?.status, "unknown");
  assert.ok(await beginPublishAttempt(db, job.id));
  assert.equal(await recoverPublishAttempts(db), 1);
  assert.equal(await recoverPublishAttempts(db), 0);
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "requires_review");
  assert.ok(publishBlockReason(await listing()));
});

test("legacy interrupted jobs with no listing record also require verification", async (t) => {
  const { db, job, listing } = await fixture(t);
  assert.equal(await listing(), null);
  await recoverPublishAttempts(db);
  assert.equal((await listing())?.status, "unknown");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "requires_review");
});

test("an explicitly unsubmitted attempt survives restart and permits retry", async (t) => {
  const { db, job, listing } = await fixture(t);
  await beginPublishAttempt(db, job.id);
  await recordUnsubmittedAttempt(db, job.id, "Browser was busy before the worker started");
  await recoverPublishAttempts(db);
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "queued");
  assert.equal(publishBlockReason(await listing()), null);
});

test("a saved success recovers a legacy unfinished job without reposting", async (t) => {
  const { db, item, job, listing } = await fixture(t);
  await db.marketplaceListing.create({ data: {
    itemId: item.id, marketplace: "depop", status: "published", externalListingId: "seller-shirt",
    externalUrl: "https://www.depop.com/products/seller-shirt/",
  } });
  await recoverPublishAttempts(db);
  const recovered = await db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(recovered.status, "published");
  assert.equal(recovered.externalUrl, (await listing())?.externalUrl);
  assert.ok(publishBlockReason(await listing()));
});

test("failure saving the job rolls back listing success and leaves a recoverable unknown attempt", async (t) => {
  const { db, job, listing } = await fixture(t);
  await beginPublishAttempt(db, job.id);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_job_success BEFORE UPDATE ON PublishJob
    WHEN NEW.status = 'published' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  await assert.rejects(completePublishAttempt(db, job.id, {
    ok: true, externalListingId: "seller-shirt", externalUrl: "https://www.depop.com/products/seller-shirt/",
  }, { price: 25, title: "Shirt" }));
  assert.equal((await listing())?.status, "unknown");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "publishing");
  await recoverPublishAttempts(db);
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "requires_review");
});

test("verified marketplace success commits both records and one attempt", async (t) => {
  const { db, job, listing } = await fixture(t);
  await beginPublishAttempt(db, job.id);
  await completePublishAttempt(db, job.id, {
    ok: true, externalListingId: "seller-shirt", externalUrl: "https://www.depop.com/products/seller-shirt/",
  }, { price: 25, title: "Shirt" });
  assert.equal((await listing())?.status, "published");
  assert.equal((await listing())?.attemptCount, 1);
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "published");
  assert.equal(await recoverPublishAttempts(db), 0);
});

test("platform-specific published copy is stored without changing shared inventory facts", async (t) => {
  const { db, item, job, listing } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { listedPrice: 24.99 } });
  await beginPublishAttempt(db, job.id);
  await completePublishAttempt(db, job.id, {
    ok: true, externalListingId: "seller-shirt", externalUrl: "https://www.depop.com/products/seller-shirt/",
    publishedPrice: 25, publishedTitle: "Platform title",
  }, { price: 24.99, title: "Shared title" });
  assert.equal((await listing())?.price, 25);
  assert.equal((await listing())?.title, "Platform title");
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).listedPrice, 24.99);
});

test("a wrong-site success cannot clear the unknown state", async (t) => {
  const { db, job, listing } = await fixture(t);
  await beginPublishAttempt(db, job.id);
  await assert.rejects(completePublishAttempt(db, job.id, {
    ok: true, externalListingId: "seller-shirt", externalUrl: "https://www.depop.com.evil.test/products/seller-shirt/",
  }, { price: 25, title: "Shirt" }), /valid listing identity/);
  assert.equal((await listing())?.status, "unknown");
});

test("a run paused during preparation cannot reserve a new browser submission", async (t) => {
  const { db, job, run, listing } = await fixture(t);
  await db.publishRun.update({ where: { id: run.id }, data: { status: "paused" } });
  assert.match((await beginPublishAttempt(db, job.id))!, /paused/);
  assert.equal(await listing(), null);
});

test("operator verification records a live listing and cannot resolve it a second time", async (t) => {
  const { db, job, listing, revision } = await fixture(t);
  await beginPublishAttempt(db, job.id);
  assert.equal((await resolvePublishAttempt(db, job.id, "not_published", undefined, await revision())).ok, false);
  await recoverPublishAttempts(db);
  assert.equal((await resolvePublishAttempt(db, job.id, "published", "https://www.ebay.com/itm/123456789012", await revision())).ok, false);
  assert.equal((await listing())?.status, "unknown");
  assert.equal((await resolvePublishAttempt(db, job.id, "published", "https://www.depop.com/products/seller-shirt/?tracking=ignored", await revision())).ok, true);
  assert.equal((await listing())?.externalUrl, "https://www.depop.com/products/seller-shirt/");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "published");
  assert.equal((await resolvePublishAttempt(db, job.id, "not_published", undefined, await revision())).ok, false);
});

test("confirming an absent listing permits an explicit retry without starting one", async (t) => {
  const { db, job, listing, revision } = await fixture(t);
  await beginPublishAttempt(db, job.id);
  await recoverPublishAttempts(db);
  assert.equal((await resolvePublishAttempt(db, job.id, "not_published", undefined, await revision())).ok, true);
  assert.equal(publishBlockReason(await listing()), null);
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "failed");
});

test("listing identities reject lookalike hosts, login/create pages, credentials and unrelated paths", () => {
  for (const value of [
    "https://depop.com.evil.test/products/item/", "https://evil.test/products/item/", "http://depop.com/products/item/",
    "https://user:pass@depop.com/products/item/", "https://depop.com:9443/products/item/", "https://depop.com/login/",
    "https://depop.com/products/create/", "https://depop.com/products/item/edit/",
  ]) assert.equal(listingIdentity("depop", value), null, value);
  assert.equal(listingIdentity("ebay", "https://www.ebay.com/itm/shirt/123456789012")?.id, "123456789012");
  assert.equal(listingIdentity("etsy", "https://www.etsy.com/listing/123456/shirt")?.id, "123456");
  assert.ok(listingIdentity("poshmark", "https://poshmark.com/listing/shirt-abcdef123456789012345678"));
  assert.ok(publishBlockReason({ status: "unexpected-state" }));
});

test("Poshmark completion stores its stable native id with listing and job success together", async (t) => {
  const { db, job } = await fixture(t);
  await db.publishJob.update({ where: { id: job.id }, data: { marketplace: "poshmark" } });
  assert.equal(await beginPublishAttempt(db, job.id), null);
  await completePublishAttempt(db, job.id, {
    ok: true, externalListingId: "abcdef123456789012345678",
    externalUrl: "https://poshmark.com/listing/Reviewed-Shirt-abcdef123456789012345678",
  }, { price: 25, title: "Reviewed Shirt" });
  const record = await db.marketplaceListing.findFirstOrThrow({ where: { itemId: job.itemId, marketplace: "poshmark" } });
  assert.equal(record.status, "published");
  assert.equal(record.externalListingId, "abcdef123456789012345678");
  assert.equal((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status, "published");
});
