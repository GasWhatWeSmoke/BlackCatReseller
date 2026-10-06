import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { AppSettingsData } from "../types.ts";
import { claimBrowser, browserHolder, releaseBrowser } from "../browserCoordinator.ts";
import { processSalesPass } from "./salesPass.ts";
import { loadSalesCheckpoint, saveSalesCheckpoint, receiptsToRecheck } from "./salesCheckpoint.ts";
import type { SaleObservation, SalesReport } from "./salesProtocol.ts";
import { createSaleMonitor } from "./saleMonitor.ts";
import { processRemovalQueue } from "./removalQueue.ts";
import { recordOrderReview, resolveOrderReview } from './orderReviews.ts';
import { applyItemChanges } from '../itemUpdate.ts';
import { archiveSelection } from '../bulkArchive.ts';
import { randomUUID } from 'node:crypto';

const observation: SaleObservation = { marketplace: "depop", receiptId: "123", reference: "123", listingId: "seller-shirt",
  listingUrl: "https://www.depop.com/products/seller-shirt/", classification: "confirmed_sale" };
const report: SalesReport = { ok: true, complete: true, observations: [observation], confirmedReceiptIds: ["123"] };
const empty: SalesReport = { ok: true, complete: true, observations: [], confirmedReceiptIds: [] };

test('an old cancellation observed after a manually reviewed return cannot attach to a later in-person sale',async t=>{
  const {db,root,item,settings}=await fixture(t);
  await processSalesPass(db,settings,'depop',{runWorker:async()=>report});
  await db.marketplaceListing.updateMany({where:{itemId:item.id,marketplace:'poshmark'},data:{status:'ended'}});
  const review=(await recordOrderReview(db,{sku:item.sku,reason:'Operator confirmed first sale refunded'}))!;
  await resolveOrderReview(db,review,{decision:'return_to_review',fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0});
  const returned=await db.item.findUniqueOrThrow({where:{id:item.id}});
  const sale=await applyItemChanges(db,item.id,{manualSale:{operationId:randomUUID(),selection:archiveSelection(JSON.parse(JSON.stringify(returned))),
    source:'in_person',fulfillment:'pickup',completed:true,soldAt:new Date().toISOString(),salePriceCents:1234,feeCents:0,
    shippingChargedCents:0,shippingCostCents:0,reference:'Later cash sale',sourceListing:null}});
  assert.equal(sale.status,200);
  const before={item:await db.item.findUnique({where:{id:item.id}}),listings:await db.marketplaceListing.findMany({where:{itemId:item.id}}),logs:await db.syncLog.findMany()};
  const checkpoint=loadSalesCheckpoint(root);checkpoint.receipts[0].checkedAt='2000-01-01T00:00:00.000Z';saveSalesCheckpoint(root,checkpoint);
  const result=await processSalesPass(db,settings,'depop',{recheckKnownReceipts:true,runWorker:async(_settings,_marketplace,known)=>{
    assert.deepEqual(known,[]);return {...empty,observations:[{...observation,classification:'not_sale'}]};
  }});
  assert.equal('review' in result&&result.review,0);
  assert.equal(result.state,'checked');
  assert.deepEqual({item:await db.item.findUnique({where:{id:item.id}}),listings:await db.marketplaceListing.findMany({where:{itemId:item.id}}),logs:await db.syncLog.findMany()},before);
});

test('a changed receipt for the current sold source still creates exactly one operator review',async t=>{
  const {db,item,settings}=await fixture(t);
  await processSalesPass(db,settings,'depop',{runWorker:async()=>report});
  const before=await db.item.findUnique({where:{id:item.id}});
  for(let i=0;i<2;i++){
    const result=await processSalesPass(db,settings,'depop',{runWorker:async()=>({...empty,observations:[{...observation,classification:'not_sale'}]})});
    assert.equal(result.state,'partial');assert.equal('review' in result&&result.review,1);
    assert.equal(await db.syncLog.count({where:{field:'order_review',action:'pending_review'}}),1);
    assert.deepEqual(await db.item.findUnique({where:{id:item.id}}),before);
  }
});

test('a genuine resale on a new listing can still be reviewed while the retired listing cannot adopt its pending review',async t=>{
  const {db,item,settings}=await fixture(t);
  await processSalesPass(db,settings,'depop',{runWorker:async()=>report});
  await db.marketplaceListing.updateMany({where:{itemId:item.id,marketplace:'poshmark'},data:{status:'ended'}});
  const first=(await recordOrderReview(db,{sku:item.sku}))!;
  await resolveOrderReview(db,first,{decision:'return_to_review',fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0});
  const next:SaleObservation={...observation,listingId:'seller-shirt-again',listingUrl:'https://www.depop.com/products/seller-shirt-again/',receiptId:'789',reference:'789',
    financials:{currency:'USD',salePriceCents:3300,shippingChargedCents:0}};
  await db.marketplaceListing.updateMany({where:{itemId:item.id,marketplace:'depop'},data:{status:'published',externalListingId:next.listingId,externalUrl:next.listingUrl}});
  await processSalesPass(db,settings,'depop',{runWorker:async()=>({...report,observations:[next],confirmedReceiptIds:['789']})});
  const before=await db.item.findUniqueOrThrow({where:{id:item.id}});assert.equal(before.salePrice,33);
  const result=await processSalesPass(db,settings,'depop',{runWorker:async()=>({...empty,observations:[{...next,classification:'not_sale'}]})});
  assert.equal('review' in result&&result.review,1);
  const pending=await db.syncLog.findMany({where:{action:'pending_review'}});assert.equal(pending.length,1);assert.equal(JSON.parse(pending[0].newValue!).listingId,next.listingId);
  const stale=await processSalesPass(db,settings,'depop',{runWorker:async()=>({...empty,observations:[{...observation,classification:'not_sale'}]})});
  assert.equal('review' in stale&&stale.review,0);assert.equal(stale.state,'checked');
  assert.deepEqual(await db.syncLog.findMany({where:{action:'pending_review'}}),pending);
  assert.deepEqual(await db.item.findUnique({where:{id:item.id}}),before);
});

test("routine checks skip stale known receipts and do not replay shipped or unlinked sales", async t => {
  const { db, root, item, settings } = await fixture(t);
  await processSalesPass(db, settings, "depop", { runWorker: async () => report });
  await db.item.update({ where: { id: item.id }, data: { shippedAt: new Date() } });
  const checkpoint = loadSalesCheckpoint(root);
  checkpoint.receipts[0].checkedAt = "2000-01-01T00:00:00.000Z";
  checkpoint.receipts[0].observations[0].financials = { currency: "USD", salePriceCents: 1700 };
  checkpoint.receipts.push({ marketplace: "depop", receiptId: "456", observations: [{ ...observation,
    receiptId: "456", reference: "456", listingId: "unlinked-old-sale", listingUrl: "https://www.depop.com/products/unlinked-old-sale/" }] });
  saveSalesCheckpoint(root, checkpoint);
  await db.$executeRawUnsafe("CREATE TRIGGER prevent_old_sale_replay BEFORE UPDATE ON Item BEGIN SELECT RAISE(ABORT, 'old item replayed'); END");
  const result = await processSalesPass(db, settings, "depop", { runWorker: async (_settings, _marketplace, known) => {
    assert.deepEqual(known, ["123", "456"]); return empty;
  } });
  assert.equal(result.state, "checked");
  assert.equal("unmatched" in result && result.unmatched, 0);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).salePrice, null);
  assert.deepEqual(loadSalesCheckpoint(root), checkpoint);
});

test("cached evidence is not applied to an unrecorded listing of an already shipped item", async t => {
  const { db, root, item, settings } = await fixture(t);
  await db.item.update({ where: { id: item.id }, data: { status: "Sold", shippedAt: new Date(), platformSold: "Depop" } });
  saveSalesCheckpoint(root, { version: 1, receipts: [{ marketplace: "depop", receiptId: "123", observations: [observation] }] });
  await db.$executeRawUnsafe("CREATE TRIGGER prevent_shipped_replay BEFORE UPDATE ON Item BEGIN SELECT RAISE(ABORT, 'shipped item replayed'); END");
  const result = await processSalesPass(db, settings, "depop", { runWorker: async () => empty });
  assert.equal(result.state, "checked");
  assert.equal("recorded" in result && result.recorded, 0);
});

test("explicit maintenance rechecks rotate past missing old receipts", async t => {
  const { db, root, settings } = await fixture(t, false);
  saveSalesCheckpoint(root, { version: 1, receipts: Array.from({ length: 12 }, (_,i) => ({ marketplace: "depop", receiptId: String(100+i),
    observations: [{ ...observation, receiptId: String(100+i), reference: String(100+i) }] })) });
  await processSalesPass(db, settings, "depop", { recheckKnownReceipts: true, runWorker: async (_settings, _marketplace, known) => {
    assert.deepEqual(known, ["110", "111"]); return empty;
  } });
  assert.deepEqual(receiptsToRecheck(loadSalesCheckpoint(root).receipts), ["110", "111"]);
});

async function fixture(t: TestContext, linked = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-sales-pass-"));
  const file = path.join(root, "test.db");
  fs.copyFileSync(path.resolve("config/template.db"), file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => {
    releaseBrowser(); await db.$disconnect();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const item = await db.item.create({ data: { sku: "SCAN-TEST", status: "Ready for Nifty", niftyTitle: "Preserved Nifty copy" } });
  if (linked) await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "depop", externalListingId: observation.listingId, externalUrl: observation.listingUrl } });
  const other = await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "poshmark", externalListingId: "abcdef123456789012345678", externalUrl: "https://poshmark.com/listing/abcdef123456789012345678" } });
  return { db, root, item, other, settings: { dataRoot: root, logsPath: root } as AppSettingsData };
}

test("a confirmed receipt records the sale, queues the other listing and checkpoints only after saving", async (t) => {
  const { db, root, item, other, settings } = await fixture(t);
  const result = await processSalesPass(db, settings, "depop", { runWorker: async (_settings, marketplace, known) => {
    assert.equal(marketplace, "depop"); assert.deepEqual(known, []);
    assert.equal(claimBrowser("competing Nifty upload"), false);
    return report;
  } });
  assert.equal(result.state, "checked");
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Sold");
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: other.id } })).status, "delist_pending");
  assert.equal(loadSalesCheckpoint(root).receipts[0].receiptId, "123");
  assert.equal(browserHolder(), null);
  const replay = await processSalesPass(db, settings, "depop", { runWorker: async (_settings, _marketplace, known) => {
    assert.deepEqual(known, ["123"]); return empty;
  } });
  assert.equal("recorded" in replay && replay.recorded, 0);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).niftyTitle, "Preserved Nifty copy");
});

test("unmatched sales do not adopt Nifty items and replay when an exact listing identity arrives", async (t) => {
  const { db, item, settings } = await fixture(t, false);
  await processSalesPass(db, settings, "depop", { runWorker: async () => report });
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: "depop", externalListingId: observation.listingId, externalUrl: observation.listingUrl } });
  await processSalesPass(db, settings, "depop", { runWorker: async () => {
    assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
    return empty;
  } });
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Sold");
});

test("a failed sale transaction cannot checkpoint a receipt and prevent a later retry", async (t) => {
  const { db, root, item, settings } = await fixture(t);
  await db.$executeRawUnsafe("CREATE TRIGGER fail_sale BEFORE UPDATE ON Item BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
  await assert.rejects(processSalesPass(db, settings, "depop", { runWorker: async () => report }));
  assert.deepEqual(loadSalesCheckpoint(root).receipts, []);
  assert.equal(browserHolder(), null);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
  await db.$executeRawUnsafe("DROP TRIGGER fail_sale");
  await processSalesPass(db, settings, "depop", { runWorker: async () => report });
  assert.equal(loadSalesCheckpoint(root).receipts.length, 1);
});

test("pausing during a read prevents later item mutations and receipt checkpoints", async (t) => {
  const { db, root, item, settings } = await fixture(t);
  let enabled = true;
  const result = await processSalesPass(db, settings, "depop", { shouldContinue: async () => enabled,
    runWorker: async () => { enabled = false; return report; } });
  assert.equal(result.state, "paused");
  assert.deepEqual(loadSalesCheckpoint(root).receipts, []);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
});

test("a partial scan applies its verified sales but never reports full coverage", async (t) => {
  const { db, root, settings } = await fixture(t);
  const result = await processSalesPass(db, settings, "depop", { runWorker: async () => ({ ...report, complete: false, reason: "read limit" }) });
  assert.equal(result.state, "partial");
  assert.equal(loadSalesCheckpoint(root).receipts.length, 1);
});

test("pending or unrecognized receipts remain uncached for the next scan", async (t) => {
  const { db, root, item, settings } = await fixture(t);
  const result = await processSalesPass(db, settings, "depop", { runWorker: async () => ({ ...report,
    observations: [{ ...observation, classification: "requires_review" }], confirmedReceiptIds: [] }) });
  assert.equal(result.state, "partial");
  assert.deepEqual(loadSalesCheckpoint(root).receipts, []);
  assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Ready for Nifty");
});

test("a busy Nifty browser prevents scanning and a malformed checkpoint is never overwritten", async (t) => {
  const { db, root, settings } = await fixture(t);
  claimBrowser("Nifty upload");
  assert.equal((await processSalesPass(db, settings, "depop")).state, "busy");
  assert.equal(browserHolder(), "Nifty upload");
  releaseBrowser();
  const file = path.join(root, "direct-sales-checkpoint.json");
  fs.writeFileSync(file, "broken checkpoint");
  await assert.rejects(processSalesPass(db, settings, "depop"), /checkpoint needs review/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken checkpoint");
  assert.equal(browserHolder(), null);
});

test("a complete monitor cycle carries a confirmed sale through verified removal of its other listing", async (t) => {
  const { db, item, other, settings } = await fixture(t);
  let removals = 0;
  const monitor = createSaleMonitor({ enabled: async () => true, targets: async () => ["depop"],
    scan: async (marketplace, shouldContinue) => processSalesPass(db, settings, marketplace, { shouldContinue, runWorker: async () => report }),
    remove: async (shouldContinue, recoverInterrupted) => processRemovalQueue(db, settings, { shouldContinue, recoverInterrupted,
      runWorker: async (_settings, request) => {
        assert.equal(request.listingId, other.id);
        assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status, "Sold");
        removals++; return { outcome: "ended", verified: true };
      } }),
  });
  await monitor.tick();
  assert.equal(removals, 1);
  assert.equal((await db.marketplaceListing.findUniqueOrThrow({ where: { id: other.id } })).status, "ended");
  assert.equal(monitor.snapshot().platforms.depop.state, "checked");
});
