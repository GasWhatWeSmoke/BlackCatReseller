import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { recordOrderReview, resolveOrderReview } from "./orderReviews.ts";
import { recordConfirmedSale } from "./saleProtection.ts";
import { receiptsToRecheck } from "./salesCheckpoint.ts";
import { applyReturnCosts } from "../returnCosts.ts";
import { buildEarningsReport } from "../earnings.ts";
import { readOrderReviewPage, parseOrderReviewQuery } from './orderReviewPage.ts';

async function identityFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-return-identity-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll('\\','/')}?connection_limit=1`}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('blackcat-return-identity-'));fs.rmSync(root,{recursive:true,force:true});});
  const item=await db.item.create({data:{sku:'IDENTITY',status:'Sold',platformSold:'In person',salePrice:20,dateSold:new Date('2026-01-01'),createdAt:new Date('2025-01-01')}});
  const id=(await recordOrderReview(db,{sku:item.sku,reason:'Original return'}))!;
  const page=await readOrderReviewPage(db,parseOrderReviewQuery(new URLSearchParams()));
  return {db,item,id,identity:page.entries[0].identity};
}

test('a stale return confirmation cannot resolve a replacement ledger entry with the same numeric ID',async t=>{
  const {db,item,id,identity}=await identityFixture(t);
  const original=await db.syncLog.findUniqueOrThrow({where:{id}});
  await db.syncLog.delete({where:{id}});
  const replacement=await db.syncLog.create({data:{...original,newValue:JSON.stringify({...JSON.parse(original.newValue!),key:'replacement-order',reason:'A different review'})}});
  for(const decision of ['keep_sold','return_to_review'])await assert.rejects(resolveOrderReview(db,id,{
    decision,reviewIdentity:identity,fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0,
  }),/review changed|original review/i);
  assert.deepEqual(await db.item.findUnique({where:{id:item.id}}),item);
  assert.deepEqual(await db.syncLog.findUnique({where:{id}}),replacement);
});

test('a review cannot return a replacement inventory item even when its ID and SKU are reused',async t=>{
  const {db,item,id,identity}=await identityFixture(t);
  const replacement=await db.item.update({where:{id:item.id},data:{createdAt:new Date('2026-02-01')}});
  await assert.rejects(resolveOrderReview(db,id,{decision:'return_to_review',reviewIdentity:identity,fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0}),/original item|inventory identity/i);
  assert.deepEqual(await db.item.findUnique({where:{id:item.id}}),replacement);
  assert.equal((await db.syncLog.findUniqueOrThrow({where:{id}})).action,'pending_review');
});

test('legacy reviews remain readable but cannot return stock until the operator reports a freshly identified review',async t=>{
  const {db,item,id,identity}=await identityFixture(t);
  const row=await db.syncLog.findUniqueOrThrow({where:{id}}),old=JSON.parse(row.oldValue!);delete old.itemCreatedAt;
  await db.syncLog.update({where:{id},data:{oldValue:JSON.stringify(old)}});
  await assert.rejects(resolveOrderReview(db,id,{decision:'return_to_review',reviewIdentity:identity,fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0}),/older review/);
  assert.deepEqual(await db.item.findUnique({where:{id:item.id}}),item);
  const kept=await resolveOrderReview(db,id,{decision:'keep_sold',reviewIdentity:identity});assert.equal(kept.identity,identity);assert.equal(kept.returned,false);
  const freshId=await recordOrderReview(db,{sku:item.sku,reason:'Fresh operator review'});assert.ok(freshId);assert.notEqual(freshId,id);
  const page=await readOrderReviewPage(db,parseOrderReviewQuery(new URLSearchParams()));
  const result=await resolveOrderReview(db,freshId!,{decision:'return_to_review',reviewIdentity:page.entries[0].identity,fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0});
  assert.equal(result.returned,true);assert.equal(result.identity,page.entries[0].identity);
  assert.equal((await db.item.findUniqueOrThrow({where:{id:item.id}})).status,'Needs Info');
});

test('ordinary cost and shipping updates do not invalidate original-item identity, while renamed SKUs require a new review',async t=>{
  const {db,item,id,identity}=await identityFixture(t);
  await db.item.update({where:{id:item.id},data:{sku:'RENAMED'}});
  await assert.rejects(resolveOrderReview(db,id,{decision:'return_to_review',reviewIdentity:identity,fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0}),/original item/);
  await db.item.update({where:{id:item.id},data:{sku:item.sku,itemCost:7,shippedAt:new Date()}});
  const result=await resolveOrderReview(db,id,{decision:'return_to_review',reviewIdentity:identity,fullRefund:true,itemReceived:true,feeLoss:1,postageLoss:3});
  assert.equal(result.returned,true);assert.equal((await db.item.findUniqueOrThrow({where:{id:item.id}})).itemCost,7);
});

test('observations on an unsold counterpart cannot create or adopt the current sale review',async t=>{
  const {db,item,id}=await identityFixture(t);
  const source=await db.marketplaceListing.create({data:{itemId:item.id,marketplace:'depop',externalListingId:'old-shirt',externalUrl:'https://www.depop.com/products/old-shirt/',status:'ended'}});
  const observation={marketplace:'depop' as const,listingId:'old-shirt',listingUrl:source.externalUrl!,receiptId:'123',reference:'123',classification:'not_sale' as const};
  const before=await db.syncLog.findMany();
  for(const status of ['published','ended','unknown','delist_pending','delisting','delist_unknown','delist_failed','not_published']){
    await db.marketplaceListing.update({where:{id:source.id},data:{status}});
    assert.equal(await recordOrderReview(db,{observation}),null,status);
    assert.deepEqual(await db.syncLog.findMany(),before);
  }
  assert.equal(await recordOrderReview(db,{sku:item.sku}),id,'Explicit manual review remains available');
});

test('a retired listing cannot attach its old cancellation even if a later import marks its source sold',async t=>{
  const {db,item,id}=await identityFixture(t);
  const source=await db.marketplaceListing.create({data:{itemId:item.id,marketplace:'depop',externalListingId:'retired-shirt',externalUrl:'https://www.depop.com/products/retired-shirt/',status:'sold'}});
  await resolveOrderReview(db,id,{decision:'return_to_review',fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0});
  await db.item.update({where:{id:item.id},data:{status:'Sold',platformSold:'In person',salePrice:35,dateSold:new Date()}});
  await db.marketplaceListing.update({where:{id:source.id},data:{status:'sold'}});
  const before=await db.syncLog.findMany();
  assert.equal(await recordOrderReview(db,{observation:{marketplace:'depop',listingId:'retired-shirt',listingUrl:source.externalUrl!,receiptId:'456',reference:'456',classification:'not_sale'}}),null);
  assert.deepEqual(await db.syncLog.findMany(),before);
});

test("returns require both confirmations, preserve history, and cannot be resold by an old receipt replay", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"blackcat-return-")),file=path.join(root,"test.db");fs.copyFileSync("config/template.db",file);
  const db=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll("\\","/")}`}}});
  t.after(async()=>{await db.$disconnect();fs.rmSync(root,{recursive:true,force:true});});
  const item=await db.item.create({data:{sku:"RETURN",status:"Sold",niftyStatus:"Published",platformSold:"eBay",salePrice:20,itemCost:4,shippingCharged:5,earningsReady:true,dateSold:new Date()}});
  await db.marketplaceListing.createMany({data:[{itemId:item.id,marketplace:"ebay",status:"sold",externalListingId:"123456789012",externalUrl:"https://www.ebay.com/itm/123456789012"},{itemId:item.id,marketplace:"depop",status:"ended"}]});
  const observation={marketplace:"ebay" as const,receiptId:"12-12345-12345",reference:"12-12345-12345/123456789012",listingId:"123456789012",listingUrl:"https://www.ebay.com/itm/123456789012",classification:"not_sale" as const};
  const id=await recordOrderReview(db,{observation});assert.ok(id);
  assert.equal(await recordOrderReview(db,{observation}),id);
  assert.equal((await db.item.findUniqueOrThrow({where:{id:item.id}})).status,"Sold");
  await assert.rejects(resolveOrderReview(db,id!,{decision:"return_to_review",fullRefund:true,itemReceived:false,feeLoss:0,postageLoss:0}),/both/);
  await assert.rejects(resolveOrderReview(db,id!,{decision:"return_to_review",fullRefund:true,itemReceived:true}),/fees and postage/);
  await db.marketplaceListing.updateMany({where:{itemId:item.id,marketplace:"depop"},data:{status:"sold"}});
  await assert.rejects(resolveOrderReview(db,id!,{decision:"return_to_review",fullRefund:true,itemReceived:true,feeLoss:0,postageLoss:0}),/multiple-sale conflict/);
  await db.marketplaceListing.updateMany({where:{itemId:item.id,marketplace:"depop"},data:{status:"ended"}});
  await resolveOrderReview(db,id!,{decision:"return_to_review",fullRefund:true,itemReceived:true,feeLoss:1,postageLoss:3});
  const returned=await db.item.findUniqueOrThrow({where:{id:item.id}});assert.equal(returned.status,"Needs Info");assert.equal(returned.itemCost,4);assert.equal(returned.salePrice,null);
  assert.equal(returned.niftyStatus,"Not Uploaded");
  const ledger=await db.syncLog.findUniqueOrThrow({where:{id:id!}});assert.equal(JSON.parse(ledger.oldValue!).salePrice,20);
  assert.equal(JSON.parse(ledger.oldValue!).niftyStatus,"Published");
  await recordConfirmedSale(db,{...observation,classification:"confirmed_sale"});
  assert.equal((await db.item.findUniqueOrThrow({where:{id:item.id}})).status,"Needs Info");
  await assert.rejects(resolveOrderReview(db,id!,{decision:"keep_sold"}),/already resolved/);
  const empty=buildEarningsReport([],[],[],0,{default:{feePercent:0,fixedFee:0}},{tiers:[],default:0},Date.now());
  const report=applyReturnCosts(empty,[ledger],null,Date.now()+1000);assert.equal(report.returnCosts.total,4);assert.equal(report.totals.netProfit,-4);assert.equal(report.byPlatform[0].netProfit,-4);
  assert.equal(applyReturnCosts(empty,[ledger],Date.now()+10_000,Date.now()+20_000).returnCosts.count,0);
});

test("known receipts rotate through bounded rechecks without rereading a fresh receipt",()=>{
  const now=Date.now();
  const receipts=Array.from({length:12},(_,i)=>({marketplace:"depop" as const,receiptId:String(i),observations:[],checkedAt:new Date(now-2*86400_000).toISOString()}));
  receipts[0].checkedAt=new Date(now).toISOString();
  const result=receiptsToRecheck(receipts,now);assert.equal(result.length,10);assert.ok(!result.includes("0"));
});
