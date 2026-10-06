import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import readline from 'node:readline';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
import {recordOrderReview,resolveOrderReview} from '../../src/lib/publish/orderReviews.ts';
import {readOrderReviewPage,parseOrderReviewQuery} from '../../src/lib/publish/orderReviewPage.ts';
const root=fileURLToPath(new URL('../..',import.meta.url)),folder=path.resolve(process.argv[2]);
assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('blackcat-return-identity-ui-'));
assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'owner.json'),'utf8')).fixture,'return-identity');
const {PrismaClient}=createRequire(import.meta.url)('@prisma/client'),file=path.join(folder,'fixture.db');assert.ok(!fs.existsSync(file));fs.copyFileSync(path.join(root,'config/template.db'),file);
const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')+'?connection_limit=1'}}});let calls=[],armed=null;
const snapshot=async()=>({items:await db.item.findMany({orderBy:{id:'asc'}}),reviews:await db.syncLog.findMany({orderBy:{id:'asc'}}),calls});
try{for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 const message=JSON.parse(line),a=message.args||{};let data;
 if(message.op==='seed'){
  assert.equal(await db.item.count(),0);
  for(let i=1;i<=3;i++){const item=await db.item.create({data:{sku:'RETURN-'+i,status:'Sold',platformSold:'In person',salePrice:20,itemCost:4,dateSold:new Date('2026-01-01'),createdAt:new Date('2025-01-01')}});await recordOrderReview(db,{sku:item.sku,reason:'Fixture return'});}data=await snapshot();
 }else if(message.op==='page')data=await readOrderReviewPage(db,parseOrderReviewQuery(new URLSearchParams(a.params)));
 else if(message.op==='arm'){armed=a.mode;data={armed};}
 else if(message.op==='resolve'){
  calls.push(a);
  if(armed){const row=await db.syncLog.findUniqueOrThrow({where:{id:a.id}});
   if(armed==='review'){await db.syncLog.delete({where:{id:a.id}});await db.syncLog.create({data:{...row,newValue:JSON.stringify({...JSON.parse(row.newValue),key:'replacement-review',reason:'Replacement fixture return'})}});}
   else if(armed==='item')await db.item.update({where:{id:row.itemId},data:{createdAt:new Date('2026-02-01')}});
   armed=null;
  }
  try{assert.equal(typeof a.reviewIdentity,'string');data={status:200,body:{ok:true,id:a.id,...await resolveOrderReview(db,a.id,a)}};}
  catch(error){data={status:400,body:{error:error.message}};}
 }else if(message.op==='snapshot')data=await snapshot();
 else if(message.op==='close'){data=await snapshot();await db.$disconnect();await new Promise(resolve=>process.stdout.write(JSON.stringify({id:message.id,ok:true,data})+'\n',resolve));break;}
 else throw Error('Unexpected return fixture operation');
 await new Promise(resolve=>process.stdout.write(JSON.stringify({id:message.id,ok:true,data})+'\n',resolve));
}}finally{await db.$disconnect()}process.exit(0);
