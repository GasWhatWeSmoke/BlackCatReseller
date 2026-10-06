import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { parseEarningsQuery,readEarningsPage } from './earningsPage.ts';
import { earningsView } from './earningsView.ts';
import { buildEarningsReport } from './earnings.ts';
import { applyReturnCosts } from './returnCosts.ts';

const now=new Date('2026-09-20T12:00:00.000Z'),DAY=86400000;
const settings={feeModel:{default:{feePercent:10,fixedFee:0}},shippingModel:{tiers:[],default:5}};
const query=(value='')=>parseEarningsQuery(new URLSearchParams(value));
async function fixture(t:TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-earnings-page-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll('\\','/')}`}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return db;
}
async function seed(db:PrismaClient){
  for(let id=1;id<=4;id++)await db.item.create({data:{id,sku:`SALE-${id}`,status:'Sold',salePrice:100,platformSold:'eBay',dateSold:new Date(now.getTime()-(id===4?20:id+1)*DAY),
    createdAt:new Date(now.getTime()-30*DAY),dateListed:new Date(now.getTime()-25*DAY),itemCost:id===2?null:id===3?0:20,
    marketplaceFees:id===3?null:0,feesEstimated:false,shippingCost:0,shippingEstimated:false,shippingCharged:0}});
  await db.syncLog.create({data:{sku:'RETURN',field:'order_review',action:'returned',source:'manual',newValue:JSON.stringify({key:'return',marketplace:'eBay',reason:'Fixture return',feeLoss:1,postageLoss:3,resolvedAt:new Date(now.getTime()-1000).toISOString()})}});
}
async function reference(db:PrismaClient,from:Date|null){
  const [sold,timing,open,listedCount,returns]=await Promise.all([
    db.item.findMany({where:{status:'Sold',salePrice:{not:null},...(from?{dateSold:{gte:from}}:{})},orderBy:[{dateSold:'desc'},{id:'desc'}]}),
    db.item.findMany({where:{status:'Sold'},select:{dateSold:true,dateListed:true,createdAt:true}}),
    db.item.findMany({where:{status:{notIn:['Sold','Archived','Removed']},marketplaceListings:{some:{status:'published'}}},select:{sku:true,itemType:true,listedPrice:true,dateListed:true,createdAt:true}}),
    db.item.count({where:{OR:[{status:'Sold'},{lastUploadAt:{not:null}},{marketplaceListings:{some:{}}}]}}),
    db.syncLog.findMany({where:{field:'order_review',action:'returned'},select:{newValue:true}}),
  ]);
  return applyReturnCosts(buildEarningsReport(sold,timing,open,listedCount,settings.feeModel,settings.shippingModel,now.getTime(),from?.getTime()??null),returns,from?.getTime()??null,now.getTime());
}
test('pages and SKU filtering preserve full-period totals, return-cost margins and off-page estimates',async t=>{
  const db=await fixture(t);await seed(db);const expected=await reference(db,new Date(now.getTime()-7*DAY));
  assert.equal(expected.totals.revenue,300);assert.equal(expected.totals.netProfit,166);assert.equal(expected.totals.marginPct,83);
  for(const params of ['days=7&pageSize=1','days=7&pageSize=1&page=3','days=7&q=SALE-1','days=7&q=missing']){
    const result=await readEarningsPage(db,settings,query(params),now);
    assert.deepEqual(result.totals,expected.totals);assert.deepEqual(result.byPlatform,expected.byPlatform);assert.deepEqual(result.salesSeries,expected.salesSeries);
    assert.deepEqual(result.sellThrough,expected.sellThrough);assert.deepEqual(result.returnCosts,expected.returnCosts);
    assert.equal(result.estimates.profit,true);assert.equal(result.estimates.fees,true);assert.equal(result.estimates.shipping,false);
    assert.deepEqual(result.platformEstimates.eBay,{profit:true,fees:true,shipping:false});
    assert.equal(result.sellThrough.soldCount,4);assert.equal(result.totals.costMissingCount,1);
    earningsView(JSON.parse(JSON.stringify(result)));
  }
  const zero=await readEarningsPage(db,settings,query('days=7&q=SALE-3'),now);assert.equal(zero.soldItems[0].itemCost,0);
  const missing=await readEarningsPage(db,settings,query('days=7&q=SALE-2'),now);assert.equal(missing.soldItems[0].itemCost,null);
});
test('range changes and returns-only periods retain the existing accounting definitions',async t=>{
  const db=await fixture(t);await seed(db);
  for(const days of ['1','7','30','all']){
    const result=await readEarningsPage(db,settings,query(`days=${days}&pageSize=1&page=999`),now);
    const expected=await reference(db,days==='all'?null:new Date(now.getTime()-Number(days)*DAY));
    assert.deepEqual(result.totals,expected.totals);assert.deepEqual(result.returnCosts,expected.returnCosts);
    assert.equal(result.detail.page,result.detail.pages);earningsView(JSON.parse(JSON.stringify(result)));
  }
  const result=await readEarningsPage(db,settings,query('days=1'),now);assert.equal(result.totals.count,0);assert.equal(result.totals.netProfit,-4);assert.equal(result.totals.marginPct,null);
});
test('invalid queries and incomplete financial views fail rather than invent zero figures',async t=>{
  for(const value of ['days=0','days=-2','days=NaN','days=3651','page=0','page=1.5','pageSize=101',`q=${'x'.repeat(33)}`])assert.throws(()=>query(value));
  for(const value of [null,{}, {totals:{},soldItems:[]}])assert.throws(()=>earningsView(value),/incomplete/);
  const db=await fixture(t),valid=JSON.parse(JSON.stringify(await readEarningsPage(db,settings,query(),now)));
  for(const mutate of [(d:any)=>{d.totals.revenue=null;},(d:any)=>{delete d.estimates;},(d:any)=>{d.detail.total=1;},(d:any)=>{d.lastSyncSummary={};}]){
    const broken=structuredClone(valid);mutate(broken);assert.throws(()=>earningsView(broken),/incomplete/);
  }
});
test('20000 sales retain complete totals with 50-row payloads and access to the oldest sale',async t=>{
  const db=await fixture(t);
  for(let offset=0;offset<20000;offset+=250)await db.item.createMany({data:Array.from({length:250},(_,n)=>{
    const id=offset+n+1;return {id,sku:`BIG-${String(id).padStart(6,'0')}`,status:'Sold',salePrice:20,platformSold:'eBay',itemCost:5,marketplaceFees:2,feesEstimated:false,shippingCost:3,shippingEstimated:false,shippingCharged:0,
      createdAt:new Date(now.getTime()-60*DAY),dateListed:new Date(now.getTime()-30*DAY),dateSold:new Date(now.getTime()-id*1000),notes:'Unrelated listing copy '.repeat(20)};
  })});
  const before=await db.item.aggregate({_count:true,_sum:{itemCost:true,salePrice:true}}),start=performance.now();
  const first=await readEarningsPage(db,settings,query('days=all'),now),elapsed=Math.round(performance.now()-start);
  const last=await readEarningsPage(db,settings,query('days=all&page=400'),now),found=await readEarningsPage(db,settings,query('days=all&q=BIG-020000'),now);
  assert.equal(first.soldItems.length,50);assert.equal(first.detail.pages,400);assert.equal(last.soldItems.at(-1)?.sku,'BIG-020000');assert.equal(found.detail.total,1);
  assert.equal(first.totals.count,20000);assert.equal(first.totals.revenue,400000);assert.equal(first.totals.netProfit,200000);assert.equal(first.totals.marginPct,50);
  assert.deepEqual(last.totals,first.totals);assert.deepEqual(found.totals,first.totals);assert.deepEqual(found.estimates,{profit:false,fees:false,shipping:false});
  const bytes=Buffer.byteLength(JSON.stringify(first));assert.ok(bytes<40000);earningsView(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(await db.item.aggregate({_count:true,_sum:{itemCost:true,salePrice:true}}),before);
  t.diagnostic(`20000 sales: first full-period summary/page ${elapsed}ms, ${bytes} bytes, 50 detail rows`);
});

test('shipping income gaps preserve zero and actual income, cover off-page sales and never rewrite amounts',async t=>{
  const db=await fixture(t);
  for(let id=1;id<=5;id++)await db.item.create({data:{id,sku:`INCOME-${id}`,status:'Sold',salePrice:20,
    platformSold:id===5?'':id>=3?'Depop':'eBay',dateSold:new Date(now.getTime()-(id===5?20:id)*DAY),itemCost:id===3?null:0,
    marketplaceFees:2,feesEstimated:false,shippingCost:3,shippingEstimated:false,shippingCharged:id===1?0:id===4?4:null}});
  const before=await db.item.findMany(),expected=await reference(db,new Date(now.getTime()-7*DAY));
  for(const params of ['days=7&pageSize=1','days=7&q=INCOME-1','days=7&q=absent','days=7&pageSize=1&page=4']){
    const result=await readEarningsPage(db,settings,query(params),now);earningsView(JSON.parse(JSON.stringify(result)));
    assert.deepEqual(result.shippingIncomeGaps,{count:2,costedCount:1,byPlatform:{Depop:{count:1,costedCount:0},eBay:{count:1,costedCount:1}}});
    assert.deepEqual(result.totals,expected.totals);assert.deepEqual(result.byPlatform,expected.byPlatform);
    assert.deepEqual(result.estimates,{profit:false,fees:false,shipping:false});
  }
  const detail=await readEarningsPage(db,settings,query('days=7'),now);
  assert.deepEqual(detail.soldItems.map(row=>[row.sku,row.shippingIncome,row.shippingIncomeMissing]),[
    ['INCOME-1',0,false],['INCOME-2',0,true],['INCOME-3',0,true],['INCOME-4',4,false],
  ]);
  const lifetime=await readEarningsPage(db,settings,query('days=all'),now);
  assert.equal(lifetime.shippingIncomeGaps.count,3);assert.deepEqual(lifetime.shippingIncomeGaps.byPlatform.Unknown,{count:1,costedCount:1});
  earningsView(JSON.parse(JSON.stringify(lifetime)));assert.deepEqual(await db.item.findMany(),before);
  await db.item.update({where:{id:2},data:{shippingCharged:0}});
  const recorded=await readEarningsPage(db,settings,query('days=7'),now);
  assert.equal(recorded.shippingIncomeGaps.count,1);assert.equal(recorded.shippingIncomeGaps.costedCount,0);
  assert.deepEqual(recorded.totals,detail.totals);assert.equal(recorded.soldItems[1].shippingIncomeMissing,false);
});

test('missing or contradictory shipping-income coverage is not accepted as complete earnings',async t=>{
  const db=await fixture(t);await seed(db);await db.item.update({where:{id:1},data:{shippingCharged:null}});
  const valid=JSON.parse(JSON.stringify(await readEarningsPage(db,settings,query('days=7'),now)));
  earningsView(valid);
  for(const mutate of [(d:any)=>{delete d.shippingIncomeGaps;},(d:any)=>{delete d.soldItems[0].shippingIncomeMissing;},
    (d:any)=>{d.shippingIncomeGaps.count=-1;},(d:any)=>{d.shippingIncomeGaps.costedCount=2;},
    (d:any)=>{delete d.shippingIncomeGaps.byPlatform.eBay;},(d:any)=>{d.shippingIncomeGaps.byPlatform.eBay.count=0;}]){
    const broken=structuredClone(valid);mutate(broken);assert.throws(()=>earningsView(broken),/incomplete/);
  }
});
