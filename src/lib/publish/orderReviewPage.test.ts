import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { parseOrderReviewQuery,readOrderReviewPage } from './orderReviewPage.ts';

async function fixture(t:TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-return-page-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll('\\','/')}`}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  return db;
}
const query=(value='')=>parseOrderReviewQuery(new URLSearchParams(value));
const row=(id:number,action='pending_review')=>({id,itemId:id,sku:String(id).padStart(6,'0'),field:'order_review',action,source:'manual',
  newValue:JSON.stringify({key:`fixture-${id}`,marketplace:'Depop',reason:'Fixture review',feeLoss:0,postageLoss:0})});

test('pending reviews remain reachable behind resolved history and unreadable records remain visible',async t=>{
  const db=await fixture(t);
  await db.syncLog.createMany({data:[row(1),...Array.from({length:220},(_,n)=>row(n+2,'review_resolved')),
    {...row(222),newValue:'{broken'},{...row(223),itemId:null},
    {...row(224),newValue:JSON.stringify({key:'identity',marketplace:'Depop',reason:'Real row identity wins',id:9999,itemId:9999,url:'javascript:alert(1)'})}]});
  const pending=await readOrderReviewPage(db,query());
  assert.equal(pending.pending,4);assert.equal(pending.resolved,220);assert.equal(pending.total,4);
  assert.deepEqual(pending.entries.map(entry=>entry.id),[224,223,222,1]);
  assert.equal(pending.entries[0].itemId,224);assert.equal(pending.entries[0].url,null);
  assert.equal(pending.entries[1].unavailable,true);assert.equal(pending.entries[2].unavailable,true);
  assert.equal(pending.entries[3].unavailable,false);
  const history=await readOrderReviewPage(db,query('view=history&page=999'));
  assert.equal(history.page,9);assert.equal(history.entries.length,20);assert.equal(history.entries.at(-1)?.id,2);
});

test('pagination, SKU search and empty results retain correct global pending totals',async t=>{
  const db=await fixture(t);await db.syncLog.createMany({data:Array.from({length:76},(_,i)=>row(i+1))});
  const found:number[]=[];
  for(let page=1;page<=4;page++){
    const result=await readOrderReviewPage(db,query(`page=${page}`));assert.equal(result.pages,4);assert.equal(result.total,76);
    assert.ok(result.entries.length<=25);found.push(...result.entries.map(entry=>entry.id));
  }
  assert.equal(new Set(found).size,76);assert.equal(found.at(-1),1);
  const filtered=await readOrderReviewPage(db,query('q=000001'));
  assert.equal(filtered.total,1);assert.equal(filtered.pending,76);assert.equal(filtered.entries[0].id,1);
  const empty=await readOrderReviewPage(db,query('q=missing&page=99'));
  assert.equal(empty.page,1);assert.equal(empty.pages,1);assert.equal(empty.total,0);assert.equal(empty.pending,76);assert.deepEqual(empty.entries,[]);
});

test('review query bounds reject invalid views, pages, sizes and oversized SKU searches',()=>{
  assert.deepEqual(query(),{view:'pending',q:'',page:1,pageSize:25});
  for(const input of ['view=all','page=0','page=-1','page=1.5','page=1000001','pageSize=101','pageSize=0',`q=${'x'.repeat(33)}`])assert.throws(()=>query(input));
});

test('a 20000-entry ledger has bounded pages and can reach the oldest pending and resolved records',async t=>{
  const db=await fixture(t);
  for(let offset=0;offset<20000;offset+=500)await db.syncLog.createMany({data:Array.from({length:500},(_,i)=>row(offset+i+1,(offset+i)%2?'review_resolved':'pending_review'))});
  const before=await db.syncLog.aggregate({_count:true,_sum:{id:true}}),start=performance.now();
  const newest=await readOrderReviewPage(db,query()),oldest=await readOrderReviewPage(db,query('page=400'));
  const history=await readOrderReviewPage(db,query('view=history&page=400'));
  assert.equal(newest.total,10000);assert.equal(newest.resolved,10000);assert.equal(newest.entries.length,25);
  assert.equal(oldest.entries.at(-1)?.id,1);assert.equal(history.entries.at(-1)?.id,2);
  assert.ok(Buffer.byteLength(JSON.stringify(newest))<20000);
  assert.deepEqual(await db.syncLog.aggregate({_count:true,_sum:{id:true}}),before);
  t.diagnostic(`20000-row ledger: three bounded reads ${Math.round(performance.now()-start)}ms; first page ${Buffer.byteLength(JSON.stringify(newest))} bytes`);
});
