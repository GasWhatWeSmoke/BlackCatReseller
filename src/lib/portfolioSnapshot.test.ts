import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import {readPortfolioSnapshot,unavailablePortfolioSnapshot} from './portfolioSnapshot.ts';
import {readDashboardStats} from './dashboardData.ts';
import {readEarningsPage} from './earningsPage.ts';
import {removalBacklog} from './publish/saleProtection.ts';
const now=new Date('2026-09-20T12:00:00Z'),secret='PRIVATE-FIXTURE-DO-NOT-EXPORT';
async function fixture(t:TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-portfolio-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('blackcat-portfolio-'));fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,secret+'.jpg'),'fixture');fs.writeFileSync(path.join(root,'second.JPEG'),'fixture');fs.mkdirSync(path.join(root,'folder.jpg'));
  const settings={incomingPath:root,feeModel:{default:{feePercent:10,fixedFee:0}},shippingModel:{tiers:[],default:5},publish:{autoRun:{enabled:false,marketplaces:['ebay','depop']}}};
  const read={ok:true,source:'configured' as const,settings};return {root,db,read};
}
async function sold(db:PrismaClient){return db.item.create({data:{sku:secret,status:'Sold',salePrice:20,shippingCharged:6,itemCost:5,marketplaceFees:2,feesEstimated:false,shippingCost:3,shippingEstimated:false,platformSold:'eBay',dateSold:now,aiRaw:secret,notes:secret}});}
async function returned(db:PrismaClient,patch:Record<string,unknown>={}){return db.syncLog.create({data:{sku:secret,field:'order_review',action:'returned',source:'manual',newValue:JSON.stringify({key:secret,marketplace:'eBay',reason:secret,feeLoss:1,postageLoss:3,resolvedAt:now.toISOString(),...patch})}});}

test('operational counts match shared queues, prioritize unresolved removals and exclude retired problem types',async t=>{
  const {db,root,read}=await fixture(t),sale=await sold(db);
  const partial=await db.item.create({data:{sku:'PARTIAL',status:'Ready',listedPrice:25}}),full=await db.item.create({data:{sku:'FULL',status:'Ready',listedPrice:25}});
  await db.item.createMany({data:[{sku:'REVIEW',status:'Photographed'},{sku:'LEGACY',status:'Ready',niftyStatus:'Published',listedPrice:25},{sku:'ARCHIVED',status:'Archived'}]});
  await db.marketplaceListing.createMany({data:[{itemId:partial.id,marketplace:'ebay',status:'published'},
    {itemId:full.id,marketplace:'ebay',status:'published'},{itemId:full.id,marketplace:'depop',status:'published'},
    {itemId:sale.id,marketplace:'ebay',status:'sold'},{itemId:sale.id,marketplace:'depop',status:'published',lastError:secret}]});
  await db.problemLog.createMany({data:[{type:'SOLD_STILL_LISTED',message:secret},{type:'UNREADABLE_FILE',photoPath:root,message:secret}]});
  await db.collision.create({data:{sku:secret,incomingPhotosJson:JSON.stringify([{storedPath:root}])}});
  for(let i=0;i<7;i++)await db.batch.create({data:{startedAt:new Date(now.getTime()-i*1000),summaryJson:secret,name:secret,itemsCreated:i}});
  const before=await db.item.findMany(),listings=await db.marketplaceListing.findMany();
  const result=await readPortfolioSnapshot(db,read,now),dashboard=await readDashboardStats(db,read.settings);
  assert.equal(result.queues.readyToUpload,1);assert.equal(result.queues.readyToUpload,dashboard.readyCount);
  assert.equal(result.queues.openProblems,1);assert.equal(result.queues.openProblems,dashboard.problemsOpen);
  assert.equal(result.queues.pendingRemovals,(await removalBacklog(db)).length);assert.equal(result.queues.pendingRemovals,1);
  assert.equal(result.queues.needsReview,1);assert.equal(result.queues.unpriced,1);assert.equal(result.queues.soldToShip,1);
  assert.equal(result.inventory.totalItems,6);assert.equal(result.inventory.incomingPhotoCount,2);assert.equal(result.inventory.byListingStatus.published,4);
  assert.equal(result.inventory.byNiftyStatus.Published,1);assert.equal(result.topActions[0].id,'check-sold-listing-removals');assert.ok(result.topActions.length<=5);
  assert.equal(result.recentBatches.length,5);assert.equal(result.recentBatches[0].itemsCreated,0);
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes(secret));assert.ok(!serialized.includes(root));assert.ok(!serialized.includes('Nifty listing workflow'));
  assert.deepEqual(await db.item.findMany(),before);assert.deepEqual(await db.marketplaceListing.findMany(),listings);assert.equal(await db.publishRun.count(),0);
});

test('recorded shipping and return losses agree with lifetime Insights without rewriting records',async t=>{
  const {db,read}=await fixture(t);await sold(db);await returned(db);
  const before=await db.syncLog.findMany();let result=await readPortfolioSnapshot(db,read,now);
  let report=await readEarningsPage(db,read.settings,{days:null,page:1,pageSize:50,q:''},now);
  assert.equal(result.cashflow.revenue,26);assert.equal(result.cashflow.netProfit,12);assert.equal(result.cashflow.profitEstimated,false);
  assert.equal(result.cashflow.revenue,report.totals.revenue);assert.equal(result.cashflow.netProfit,report.totals.netProfit);assert.deepEqual(result.cashflow.returnCosts,report.returnCosts);
  await db.item.updateMany({data:{marketplaceFees:null,shippingCost:null}});
  result=await readPortfolioSnapshot(db,read,now);report=await readEarningsPage(db,read.settings,{days:null,page:1,pageSize:50,q:''},now);
  assert.equal(result.cashflow.netProfit,report.totals.netProfit);assert.equal(result.cashflow.profitEstimated,true);assert.equal(result.cashflow.feesEstimatedCount,1);assert.equal(result.cashflow.shippingEstimatedCount,1);
  assert.ok(result.dataGaps.includes('fees_estimated'));assert.deepEqual(await db.syncLog.findMany(),before);
});

test('missing income, costs and return details stay unknown while recorded zero remains known',async t=>{
  const {db,read}=await fixture(t),sale=await sold(db);
  await db.item.update({where:{id:sale.id},data:{shippingCharged:0,itemCost:0}});
  let result=await readPortfolioSnapshot(db,read,now);assert.equal(result.cashflow.revenue,20);assert.equal(result.cashflow.netProfit,15);assert.equal(result.cashflow.shippingIncomeMissingCount,0);
  await db.item.update({where:{id:sale.id},data:{shippingCharged:null}});
  result=await readPortfolioSnapshot(db,read,now);assert.equal(result.cashflow.revenue,null);assert.equal(result.cashflow.knownRevenue,20);assert.equal(result.cashflow.netProfit,null);assert.equal(result.cashflow.shippingIncomeMissingCount,1);
  await db.item.update({where:{id:sale.id},data:{shippingCharged:0,itemCost:null}});
  result=await readPortfolioSnapshot(db,read,now);assert.equal(result.cashflow.revenue,20);assert.equal(result.cashflow.netProfit,null);assert.equal(result.cashflow.costMissingCount,1);
  await db.item.update({where:{id:sale.id},data:{salePrice:null}});
  result=await readPortfolioSnapshot(db,read,now);assert.equal(result.cashflow.revenue,null);assert.equal(result.cashflow.salePriceMissingCount,1);
  await db.item.update({where:{id:sale.id},data:{salePrice:20,itemCost:0}});await returned(db,{feeLoss:null});
  result=await readPortfolioSnapshot(db,read,now);assert.equal(result.cashflow.revenue,20);assert.equal(result.cashflow.netProfit,null);assert.equal(result.cashflow.returnCostMissingCount,1);assert.ok(result.dataGaps.includes('return_cost_details_missing'));
});

test('unavailable settings/folders preserve independent counts and failed databases cannot become empty portfolios',async t=>{
  const {db,root,read}=await fixture(t);await sold(db);
  for(const bad of [{...read,ok:false,error:'settings_malformed' as const},
    {...read,settings:{...read.settings,feeModel:null} as never},
    {...read,settings:{...read.settings,publish:{autoRun:{enabled:false,marketplaces:['invalid']}}}}]){
    const result=await readPortfolioSnapshot(db,bad,now);assert.equal(result.sourceHealth.ok,false);assert.equal(result.inventory.totalItems,1);assert.equal(result.inventory.incomingPhotoCount,null);
    assert.equal(result.queues.readyToUpload,null);assert.equal(result.cashflow.netProfit,null);assert.equal(result.cashflow.revenue,26);assert.ok(result.dataGaps.includes('settings_unavailable'));
  }
  const missing=await readPortfolioSnapshot(db,{...read,settings:{...read.settings,incomingPath:path.join(root,'missing')}},now);
  assert.equal(missing.inventory.incomingPhotoCount,null);assert.equal(missing.cashflow.netProfit,16);assert.equal(missing.sourceHealth.ok,false);
  await assert.rejects(readPortfolioSnapshot({$transaction:async()=>{throw Error(secret);}} as never,read,now),new RegExp(secret));
  const unavailable=unavailablePortfolioSnapshot(now);assert.equal(unavailable.inventory.totalItems,null);assert.equal(unavailable.queues.pendingRemovals,null);assert.equal(unavailable.cashflow.revenue,null);assert.equal(unavailable.topActions,null);assert.ok(!JSON.stringify(unavailable).includes(secret));
});

test('Etsy applicability and return-only periods retain their existing rules',async t=>{
  const {db,read}=await fixture(t);await db.item.createMany({data:[{sku:'MODERN',status:'Ready'},{sku:'VINTAGE',status:'Ready',trueVintage:true}]});await returned(db);
  await returned(db,{resolvedAt:new Date(now.getTime()+86400000).toISOString(),feeLoss:null});
  const result=await readPortfolioSnapshot(db,{...read,settings:{...read.settings,publish:{autoRun:{enabled:false,marketplaces:['etsy']}}}},now);
  assert.equal(result.queues.readyToUpload,1);assert.equal(result.cashflow.soldCount,0);assert.equal(result.cashflow.revenue,0);assert.equal(result.cashflow.netProfit,-4);assert.equal(result.cashflow.returnCostMissingCount,0);
  assert.equal(result.cashflow.returnCosts.count,1);assert.ok(result.topActions.some(action=>action.id==='upload-ready-items'));
});

test('20000 stored sales produce complete aggregates in a bounded snapshot',async t=>{
  const {db,read}=await fixture(t);
  for(let offset=0;offset<20000;offset+=250)await db.item.createMany({data:Array.from({length:250},(_,i)=>({sku:`LARGE-${offset+i}`,status:'Sold',salePrice:20,shippingCharged:0,itemCost:5,marketplaceFees:2,feesEstimated:false,shippingCost:3,shippingEstimated:false,notes:secret}))});
  const start=performance.now(),result=await readPortfolioSnapshot(db,read,now),elapsed=Math.round(performance.now()-start),bytes=Buffer.byteLength(JSON.stringify(result));
  assert.equal(result.cashflow.soldCount,20000);assert.equal(result.cashflow.revenue,400000);assert.equal(result.cashflow.netProfit,200000);assert.equal(result.cashflow.profitEstimated,false);assert.ok(bytes<6000);
  assert.ok(!JSON.stringify(result).includes(secret));assert.equal(await db.item.count(),20000);
  t.diagnostic(`20000 sales snapshot: ${elapsed}ms, ${bytes} bytes`);
});
