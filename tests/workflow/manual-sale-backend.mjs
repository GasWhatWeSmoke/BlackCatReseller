import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import readline from 'node:readline';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
import {inventoryPage,parseInventoryQuery} from '../../src/lib/inventoryQuery.ts';
import {applyItemChanges} from '../../src/lib/itemUpdate.ts';
import {readManualSale} from '../../src/lib/manualSaleStore.ts';
import {loadUploadHistory,parseHistoryQuery} from '../../src/lib/pastUploads.ts';
const root=fileURLToPath(new URL('../..',import.meta.url)),folder=path.resolve(process.argv[2]);
assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('blackcat-manual-sale-workflow-'));
assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'owner.json'),'utf8')).fixture,'manual-sale');
const req=createRequire(import.meta.url),{PrismaClient}=req('@prisma/client');const file=path.join(folder,'fixture.db');assert.ok(!fs.existsSync(file));fs.copyFileSync(path.join(root,'config/template.db'),file);
const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')+'?connection_limit=1'}}});let calls=[];
const snapshot=async()=>({items:await db.item.findMany({orderBy:{id:'asc'}}),listings:await db.marketplaceListing.findMany(),logs:await db.syncLog.findMany(),calls});
try{for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 const message=JSON.parse(line),a=message.args||{};let data;
 if(message.op==='seed'){
  assert.equal(await db.item.count(),0);
  for(let i=1;i<=5;i++){
   const item=await db.item.create({data:{sku:String(i).padStart(6,'0'),status:'Listed',brand:'Fixture archive',itemType:'T-Shirt',size:'M',color:'Black',listedPrice:50,itemCost:3}});
   if(i===1)await db.marketplaceListing.create({data:{itemId:item.id,marketplace:'depop',externalListingId:'fixture-shirt',externalUrl:'https://www.depop.com/products/fixture-shirt/',status:'published'}});
  }data=await snapshot();
 }else if(message.op==='page')data=await inventoryPage(db,parseInventoryQuery(new URLSearchParams(a.params)));
 else if(message.op==='history')data=await loadUploadHistory(db,parseHistoryQuery(new URLSearchParams(a.params)));
 else if(message.op==='item'){const item=await db.item.findUniqueOrThrow({where:{id:a.id},include:{marketplaceListings:true}});data={item,manualSale:await readManualSale(db,item)};}
 else if(message.op==='count')data={count:await db.item.count({where:{status:'Sold',shippedAt:null}})};
 else if(message.op==='change'){assert.ok(a.body.manualSale||typeof a.body.shipped==='boolean');calls.push({id:a.id,body:a.body});data=await applyItemChanges(db,a.id,a.body);}
 else if(message.op==='mutate'){const item=await db.item.findUniqueOrThrow({where:{id:a.id}});data=await db.item.update({where:{id:a.id},data:{notes:'Concurrent fixture edit',updatedAt:new Date(item.updatedAt.getTime()+1000)}});}
 else if(message.op==='snapshot')data=await snapshot();
 else if(message.op==='close'){data=await snapshot();await db.$disconnect();await new Promise(resolve=>process.stdout.write(JSON.stringify({id:message.id,ok:true,data})+'\n',resolve));break;}
 else throw Error('Unexpected manual-sale fixture operation');
 await new Promise(resolve=>process.stdout.write(JSON.stringify({id:message.id,ok:true,data})+'\n',resolve));
}}finally{await db.$disconnect()}process.exit(0);
