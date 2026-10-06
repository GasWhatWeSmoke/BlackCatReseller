import test,{type TestContext} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {PrismaClient} from '@prisma/client';
import {pricingIds,readPricingIndex,readPricingRows} from './pricingRead.ts';import {pricingIndexView,pricingRowsView} from './pricingReadView.ts';
import {recoverPricingIndex} from './pricingClient.ts';import {changeDraft,draftKey} from './itemDrafts.ts';import {countPricingWork} from './pricingDraft.ts';
async function fixture(t:TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-pricing-read-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')}}});t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return db;}

test('pricing identities preserve eligibility and detailed reads remain bounded and private',async t=>{
 const db=await fixture(t);await db.item.createMany({data:[{id:1,sku:'000001',status:'Needs Info',notes:'PRIVATE',aiRaw:'PRIVATE'},{id:2,sku:'000002',status:'Ready',listedPrice:20},{id:3,sku:'000003',status:'Sold'},{id:4,sku:'000004',status:'Ready',niftyStatus:'Published'},{id:5,sku:'000005',status:'Ready',listedPrice:0}]});
 for(let i=0;i<12;i++)await db.photo.create({data:{itemId:1,originalFilename:`${i}.jpg`,storedPath:`C:/fixture/${i}.jpg`,sha256:String(i),sortOrder:i,isMarker:i===0,isCover:i===11}});
 const before=await db.item.findMany(),index=await readPricingIndex(db);pricingIndexView(index);assert.deepEqual(index.items.map(row=>row.id),[1,5]);assert.ok(!JSON.stringify(index).includes('PRIVATE'));
 const rows=await readPricingRows(db,[1,2,3]);pricingRowsView(rows,[1,2,3]);assert.equal(rows.items.length,3);assert.equal(rows.items[0].photos.length,8);assert.equal(rows.items[0].photos[0].isCover,true);assert.ok(rows.items[0].photos.every(photo=>!photo.isMarker));assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
 const drafts=await readPricingIndex(db,[2,3,999]);pricingIndexView(drafts,[2,3,999]);assert.deepEqual(drafts.items.map(row=>row.id),[2,3]);assert.deepEqual(await db.item.findMany(),before);
});

test('large draft recovery uses bounded metadata batches and preserves unavailable identities',async()=>{
 const initial={id:1,createdAt:'2026-09-20T00:00:00.000Z',sku:'000001',status:'Needs Info',listedPrice:null};
 const drafts=Array.from({length:501},(_,i)=>{const item={...initial,id:i+1,sku:String(i+1).padStart(6,'0')};return changeDraft(draftKey('pricing',item),item,null,{listedPrice:'25.'});});
 let active=0,max=0;const sizes:number[]=[];
 const recovered=await recoverPricingIndex([initial],drafts,async ids=>{sizes.push(ids.length);active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return ids.filter(id=>id!==500).map(id=>({...initial,id,sku:String(id).padStart(6,'0'),createdAt:id===501?'2026-09-21T00:00:00.000Z':initial.createdAt}));});
 assert.equal(recovered.rows.length,499);assert.equal(recovered.unavailable.length,2);assert.ok(sizes.every(n=>n<=100));assert.equal(max,4);assert.equal(countPricingWork([initial],drafts),501);
 const failed=await recoverPricingIndex([],drafts.slice(0,2),async()=>{throw Error('Fixture unavailable');});assert.equal(failed.unavailable.length,2);assert.equal(failed.rows.length,0);
});

test('invalid identities and malformed receipts cannot enable pricing controls',async t=>{
 for(const raw of ['', '0','1,x',Array.from({length:101},(_,i)=>String(i+1)).join(',')])assert.throws(()=>pricingIds(raw));
 assert.deepEqual(pricingIds('1,2,1'),[1,2]);const db=await fixture(t);await db.item.create({data:{id:1,sku:'000001'}});
 const index=await readPricingIndex(db),rows=await readPricingRows(db,[1]);
 assert.throws(()=>pricingIndexView({...index,total:99}));assert.throws(()=>pricingIndexView(index,[1]));assert.throws(()=>pricingRowsView({...rows,requestedIds:[2]},[1]));
 assert.throws(()=>pricingRowsView({...rows,items:[{...rows.items[0],createdAt:'bad'}]},[1]));assert.throws(()=>pricingRowsView({...rows,items:[{...rows.items[0],photos:null}]},[1]));
});

test('20000 unpriced items retain exact draft-aware counts and bounded detail payloads',async t=>{
 const db=await fixture(t);for(let offset=0;offset<20000;offset+=250)await db.item.createMany({data:Array.from({length:250},(_,i)=>({id:offset+i+1,sku:String(offset+i+1).padStart(6,'0'),status:'Needs Info',notes:'PRIVATE '.repeat(200),aiRaw:'PRIVATE '.repeat(200)}))});
 const started=performance.now(),index=await readPricingIndex(db),indexMs=Math.round(performance.now()-started);pricingIndexView(index);assert.equal(index.total,20000);assert.equal(index.items.at(-1)?.sku,'020000');assert.equal(countPricingWork(index.items,[]),20000);
 const rows=await readPricingRows(db,index.items.slice(-50).map(row=>row.id));assert.equal(rows.items.length,50);assert.equal(rows.items.at(-1)?.sku,'020000');
 const bytes=Buffer.byteLength(JSON.stringify(rows)),indexBytes=Buffer.byteLength(JSON.stringify(index));assert.ok(bytes<40000);assert.ok(indexBytes<1600000);assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.equal(await db.item.count(),20000);
 t.diagnostic(`20000 pricing identities: ${indexMs}ms, ${indexBytes} bytes; 50 detail rows: ${bytes} bytes`);
});
