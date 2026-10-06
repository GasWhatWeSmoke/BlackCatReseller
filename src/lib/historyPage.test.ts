import test,{type TestContext} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {PrismaClient} from '@prisma/client';
import {loadUploadHistory,parseHistoryQuery} from './pastUploads.ts';import {historyView} from './historyView.ts';
async function fixture(t:TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-history-page-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')}}});
 t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('blackcat-history-page-'));fs.rmSync(root,{recursive:true,force:true});});return db;}
const query=(s='')=>parseHistoryQuery(new URLSearchParams(s));

test('complete filters follow displayed listing state and unresolved removals while search spans item words',async t=>{
 const db=await fixture(t);
 for(const [sku,status] of [['LIVE','Ready'],['PROBLEM','Problem'],['SOLD','Sold'],['ARCHIVED','Archived'],['STORED-LISTED','Listed'],['NEVER','Ready']]){
  const item=await db.item.create({data:{sku,status,brand:'Nike',itemType:'T-shirt',color:'Blue',size:'M',lastUploadAt:sku==='STORED-LISTED'?new Date():null}});
  if(!['NEVER','STORED-LISTED'].includes(sku))await db.marketplaceListing.create({data:{itemId:item.id,marketplace:'ebay',status:'published',title:'Nike Blue Shirt'}});
 }
 const listed=await loadUploadHistory(db,query('filter=listed'));assert.deepEqual(new Set(listed.items.map(row=>row.sku)),new Set(['LIVE','STORED-LISTED']));historyView(listed);
 const sold=await loadUploadHistory(db,query('filter=sold'));assert.deepEqual(sold.items.map(row=>row.sku),['SOLD']);
 const attention=await loadUploadHistory(db,query('filter=attention'));assert.equal(attention.total,1);assert.equal(attention.items[0].removalNeedsAttention,true);
 const words=await loadUploadHistory(db,query('q=Nike+Blue'));assert.equal(words.total,5);assert.equal(words.counts.all,5);
 const missing=await loadUploadHistory(db,query('q=missing'));assert.equal(missing.total,0);assert.equal(missing.counts.all,5);historyView(missing);
});

test('sales paging keeps unshipped groups first, dated sales newest first, and undated sales accessible',async t=>{
 const db=await fixture(t);
 const dates=[null,'2026-09-01','2026-09-10','2026-09-20',null,'2026-09-05'];
 for(let i=0;i<dates.length;i++)await db.item.create({data:{sku:`SALE-${i+1}`,status:'Sold',dateSold:dates[i]?new Date(dates[i]!):null,shippedAt:i>=3?new Date('2026-09-21'):null,updatedAt:new Date(1700000000000+i*1000)}});
 const pages=[];
 for(let page=1;page<=3;page++){const result=await loadUploadHistory(db,query(`view=sales&pageSize=2&page=${page}`));historyView(result);assert.deepEqual(result.counts,{all:6,shipping:3});pages.push(...result.items.map(row=>row.sku));}
 assert.deepEqual(pages,['SALE-3','SALE-2','SALE-1','SALE-4','SALE-6','SALE-5']);
 const pending=await loadUploadHistory(db,query('view=sales&filter=shipping'));assert.equal(pending.total,3);assert.ok(pending.items.every(row=>row.shippedAt===null));
 const shipped=await loadUploadHistory(db,query('view=sales&filter=shipped'));assert.equal(shipped.total,3);assert.ok(shipped.items.every(row=>row.shippedAt!==null));
 const clamped=await loadUploadHistory(db,query('view=sales&pageSize=2&page=999'));assert.equal(clamped.page,3);assert.equal(clamped.requestedPage,999);historyView(clamped);
});

test('history projects only needed row fields and one non-marker cover without changing stored records',async t=>{
 const db=await fixture(t),item=await db.item.create({data:{sku:'PROJECTION',status:'Sold',notes:'PRIVATE',aiRaw:'PRIVATE',shippingCharged:0,salePrice:0}});
 for(const [name,cover,marker,sortOrder] of [['first',false,false,0],['marker',true,true,1],['cover',true,false,5]] as const)await db.photo.create({data:{itemId:item.id,originalFilename:name,storedPath:`C:/fixture/${name}.jpg`,sha256:name,isCover:cover,isMarker:marker,sortOrder}});
 const before=await db.item.findMany(),photos=await db.photo.findMany(),result=await loadUploadHistory(db,query('view=sales'));
 assert.equal(result.items[0].photos.length,1);assert.match(result.items[0].photos[0].storedPath,/cover/);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 assert.equal(result.items[0].salePrice,0);assert.equal(result.items[0].shippingCharged,0);assert.deepEqual(await db.item.findMany(),before);assert.deepEqual(await db.photo.findMany(),photos);
 historyView(result);
});

test('malformed page receipts and invalid filters fail rather than authorize stale shipping controls',async t=>{
 for(const value of ['page=0','page=-1','pageSize=101','view=wrong','view=history&filter=shipping','view=sales&filter=listed',`q=${'x'.repeat(201)}`])assert.throws(()=>query(value));
 const db=await fixture(t);await db.item.create({data:{sku:'VALID',status:'Sold'}});const valid=await loadUploadHistory(db,query('view=sales'));historyView(valid);
 for(const mutate of [(v:any)=>{delete v.page;},(v:any)=>{v.total=99;},(v:any)=>{v.items[0].status='Ready';},(v:any)=>{v.items[0].shippedAt='bad';},(v:any)=>{v.items.push(v.items[0]);},(v:any)=>{v.counts.shipping=2;}]){
  const bad=structuredClone(valid);mutate(bad);assert.throws(()=>historyView(bad));
 }
 await assert.rejects(loadUploadHistory({$transaction:async()=>{throw Error('Unavailable');}} as never),/Unavailable/);
});

test('20000 history records retain the oldest unshipped sale and complete search with 50-row pages',async t=>{
 const db=await fixture(t);
 for(let offset=0;offset<20000;offset+=250)await db.item.createMany({data:Array.from({length:250},(_,i)=>{const id=offset+i+1;return {id,sku:id===1?'OLDEST-SALE':`H-${String(id).padStart(6,'0')}`,status:id===1?'Sold':'Ready',platformSold:id===1?'eBay':null,lastUploadAt:new Date('2026-01-01'),updatedAt:new Date(1700000000000+id*1000),notes:'PRIVATE '.repeat(100)};})});
 const start=performance.now(),first=await loadUploadHistory(db),elapsed=Math.round(performance.now()-start),bytes=Buffer.byteLength(JSON.stringify(first));
 assert.equal(first.total,20000);assert.equal(first.pages,400);assert.equal(first.items.length,50);assert.ok(bytes<70000);historyView(first);
 const last=await loadUploadHistory(db,query('page=400'));assert.equal(last.items.at(-1)?.sku,'OLDEST-SALE');
 const searchStart=performance.now(),found=await loadUploadHistory(db,query('q=OLDEST-SALE')),searchMs=Math.round(performance.now()-searchStart);assert.equal(found.total,1);assert.equal(found.items[0].sku,'OLDEST-SALE');
 const sale=await loadUploadHistory(db,query('view=sales&filter=shipping'));assert.equal(sale.total,1);assert.equal(sale.items[0].sku,'OLDEST-SALE');assert.deepEqual(sale.counts,{all:1,shipping:1});
 assert.equal(await db.item.count(),20000);assert.equal(await db.item.count({where:{status:'Sold',shippedAt:null}}),1);
 t.diagnostic(`20000 history records: ${elapsed}ms first page, ${searchMs}ms full search, ${bytes} bytes, ${first.items.length} rows`);
});

test('history search treats wildcard characters literally and preserves Unicode case matching',async t=>{
 const db=await fixture(t);
 for(const sku of ['HAS%MARK','HAS_MARK','PLAIN','HERMÈS'])await db.item.create({data:{sku,status:'Sold',customTitle:sku}});
 for(const [needle,expected] of [['%','HAS%MARK'],['_','HAS_MARK'],['hermès','HERMÈS']]){
  const result=await loadUploadHistory(db,query('view=sales&q='+encodeURIComponent(needle)));
  assert.equal(result.total,1);assert.equal(result.items[0].sku,expected);historyView(result);
 }
 const punctuation=await loadUploadHistory(db,query('q='+encodeURIComponent("'; --")));assert.equal(punctuation.total,0);assert.equal(await db.item.count(),4);
});
