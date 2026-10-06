import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_INVENTORY_QUERY, inventoryPage, inventoryNeighbors } from './inventoryQuery.ts';

test('inventory state filters and navigation match visible badges across stored and marketplace states',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-state-filter-'));
  const file=path.join(root,'fixture.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll('\\','/')}`}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const cases=[
    ['Photographed','Needs review','Listed'],['Needs Info','Needs review','Listed'],
    ['Ready','Ready','Listed'],['Ready for Nifty','Ready','Listed'],
    ['Uploaded to Nifty','Previously listed','Listed'],
    ['Problem','Problem','Problem'],['Sold','Sold','Sold'],
    ['Archived','Archived','Archived'],['Removed','Removed','Removed'],
  ];
  const expected=new Map<string,number[]>();let serial=0;
  for(const [stored,withoutLive,withLive] of cases)for(const listingStatus of [null,'ended','unknown','published']) {
    const item=await db.item.create({data:{sku:String(++serial).padStart(6,'0'),status:stored}});
    if(listingStatus)await db.marketplaceListing.create({data:{itemId:item.id,marketplace:'depop',status:listingStatus}});
    const displayed=listingStatus==='published'?withLive:withoutLive;
    expected.set(displayed,[...(expected.get(displayed)??[]),item.id]);
  }
  const before={items:await db.item.findMany(),listings:await db.marketplaceListing.findMany()};
  for(const [state,ids] of expected)await t.test(state,async()=>{
    const query={...DEFAULT_INVENTORY_QUERY,state,pageSize:25};
    const page=await inventoryPage(db,query);
    assert.equal(page.total,ids.length,`${state} total`);
    assert.deepEqual(page.items.map(item=>item.id),ids,`${state} membership`);
    assert.ok(page.items.every(item=>item.displayStatus===state),`${state} badges`);
    const middle=ids[1],nav=await inventoryNeighbors(db,middle,query);
    assert.deepEqual(nav,{prev:ids[0],next:ids[2]??null,index:1,total:ids.length,matches:true});
  });
  assert.deepEqual({items:await db.item.findMany(),listings:await db.marketplaceListing.findMany()},before);
});
