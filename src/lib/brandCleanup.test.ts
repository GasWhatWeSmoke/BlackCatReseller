import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyBrandCleanup,previewBrandCleanup,validateBrandChanges,validateBrandPreview,validateBrandResult } from './brandCleanup.ts';

async function fixture(t:TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-brand-cleanup-')),file=path.join(root,'test.db');fs.copyFileSync('config/template.db',file);
  const options={datasources:{db:{url:`file:${file.replaceAll('\\','/')}`}}},db=new PrismaClient(options),other=new PrismaClient(options);
  t.after(async()=>{await Promise.all([db.$disconnect(),other.$disconnect()]);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return {db,other};
}
const item=(sku:string,brand='Quicksilver')=>({sku,brand,status:'Photographed',listedPrice:25,itemCost:5,customTitle:'Keep my title',notes:'Keep my notes'});

test('only the reviewed snapshot is applied; new eligible items and fuzzy matches are left alone',async t=>{
  const {db}=await fixture(t);
  await db.item.createMany({data:[item('A'),item('B','Lee Dungarees'),item('C','QLIKSILVER'),item('D','Grim Reaper  '),{...item('S'),status:'Sold'},{...item('X'),status:'Archived'}]});
  const plan=await previewBrandCleanup(db);validateBrandPreview(plan);
  assert.deepEqual(plan.changes.map(row=>row.sku),['A','B','D']);assert.deepEqual(plan.suggestions.map(row=>row.sku),['C']);assert.equal(plan.scanned,4);
  const lee=plan.changes.find(row=>row.sku==='B')!;assert.equal(lee.to,'Lee');assert.equal(lee.fromSubBrand,null);assert.equal(lee.toSubBrand,'Dungarees');
  await db.item.create({data:item('NEW')});
  const result=await applyBrandCleanup(db,plan.changes);validateBrandResult(result,plan.changes);assert.equal(result.applied,3);assert.deepEqual(result.skipped,[]);
  const rows=await db.item.findMany({orderBy:{sku:'asc'}});
  assert.equal(rows.find(row=>row.sku==='NEW')!.brand,'Quicksilver');assert.equal(rows.find(row=>row.sku==='C')!.brand,'QLIKSILVER');
  assert.equal(rows.find(row=>row.sku==='S')!.brand,'Quicksilver');assert.equal(rows.find(row=>row.sku==='X')!.brand,'Quicksilver');
  assert.equal(rows.find(row=>row.sku==='B')!.subBrand,'Dungarees');
  for(const row of rows){assert.equal(row.listedPrice,25);assert.equal(row.itemCost,5);assert.equal(row.customTitle,'Keep my title');assert.equal(row.notes,'Keep my notes');}
  const replay=await applyBrandCleanup(db,plan.changes);assert.equal(replay.applied,0);assert.equal(replay.skipped.length,3);
});

test('changed brands, sub-lines, SKUs, identities and sale/archive transitions cannot be overwritten',async t=>{
  const {db,other}=await fixture(t);
  for(let n=0;n<6;n++)await db.item.create({data:item(`ROW-${n}`,'Lee Dungarees')});
  const plan=await previewBrandCleanup(db),patches=[{brand:'Operator brand'},{subBrand:'Operator sub-line'},{sku:'RENAMED'},{createdAt:new Date('2001-01-01')},{status:'Sold'},{status:'Archived'}];
  for(let n=0;n<patches.length;n++)await other.item.update({where:{id:plan.changes[n].id},data:patches[n]});
  const before=await db.item.findMany({orderBy:{id:'asc'}}),result=await applyBrandCleanup(db,plan.changes);
  assert.equal(result.applied,0);assert.equal(result.skipped.length,6);assert.deepEqual(await db.item.findMany({orderBy:{id:'asc'}}),before);
});

test('a failure after an earlier update rolls the entire reviewed batch back',async t=>{
  const {db}=await fixture(t);await db.item.createMany({data:[item('A'),item('B')]});const plan=await previewBrandCleanup(db),before=await db.item.findMany({orderBy:{id:'asc'}});
  let writes=0;
  const failing={$transaction:async(fn:any)=>db.$transaction(async tx=>fn({item:{updateMany:async(args:any)=>{if(++writes===2)throw Error('Fixture write failed');return tx.item.updateMany(args);}}}))} as unknown as Pick<PrismaClient,'$transaction'>;
  await assert.rejects(applyBrandCleanup(failing,plan.changes),/Fixture write failed/);assert.equal(writes,2);
  assert.deepEqual(await db.item.findMany({orderBy:{id:'asc'}}),before);
});

test('missing, forged, duplicate and oversized requests fail before any transaction',async t=>{
  const {db}=await fixture(t);await db.item.create({data:item('A')});const [valid]=(await previewBrandCleanup(db)).changes;
  let transactions=0;const forbidden={$transaction:async()=>{transactions++;throw Error('Must not transact');}} as unknown as Pick<PrismaClient,'$transaction'>;
  for(const input of [undefined,null,{},[],[valid,valid],[{...valid,to:'Invented brand'}],[{...valid,toSubBrand:'Invented sub-line'}],
    [{...valid,from:'QLIKSILVER'}],[{...valid,status:'Sold'}],[{...valid,fromSubBrand:undefined}],Array.from({length:101},(_,n)=>({...valid,id:n+1}))])
    await assert.rejects(applyBrandCleanup(forbidden,input),/reviewed brand changes/);
  assert.equal(transactions,0);assert.equal((await db.item.findUniqueOrThrow({where:{id:valid.id}})).brand,valid.from);
  assert.throws(()=>validateBrandChanges([{...valid,createdAt:'bad'}]),/reviewed/);
});

test('result validation rejects false success, missing items and duplicate receipts',async t=>{
  const {db}=await fixture(t);await db.item.createMany({data:[item('A'),item('B')]});const changes=(await previewBrandCleanup(db)).changes;
  const good={ok:true,requested:2,applied:1,appliedIds:[changes[0].id],skipped:[{id:changes[1].id,sku:changes[1].sku,reason:'Changed'}]};validateBrandResult(good,changes);
  for(const value of [{ok:true}, {...good,applied:2},{...good,skipped:[]},{...good,appliedIds:[changes[1].id]},{...good,skipped:[{...good.skipped[0],sku:'Wrong'}]}])assert.throws(()=>validateBrandResult(value,changes));
  assert.throws(()=>validateBrandPreview({scanned:0,changes:[],suggestions:[]}));
});

test('20000 eligible items have bounded previews and all remaining fixes stay reachable',async t=>{
  const {db}=await fixture(t);
  for(let offset=0;offset<20000;offset+=500)await db.item.createMany({data:Array.from({length:500},(_,n)=>item(String(offset+n+1).padStart(6,'0')))});
  const start=performance.now(),first=await previewBrandCleanup(db),last=await previewBrandCleanup(db,999999),elapsed=Math.round(performance.now()-start);
  assert.equal(first.totalChanges,20000);assert.equal(first.changes.length,100);assert.equal(first.pages,200);assert.equal(last.page,200);assert.equal(last.changes.at(-1)!.sku,'020000');
  const result=await applyBrandCleanup(db,first.changes);assert.equal(result.applied,100);
  const next=await previewBrandCleanup(db);assert.equal(next.totalChanges,19900);assert.equal(next.changes[0].sku,'000101');
  assert.equal(await db.item.count({where:{brand:'Quiksilver'}}),100);assert.equal(await db.item.count(),20000);
  t.diagnostic(`20000-item brand preview: first/last reads ${elapsed}ms; first page ${Buffer.byteLength(JSON.stringify(first))} bytes; 100 mutations only after explicit apply`);
});
