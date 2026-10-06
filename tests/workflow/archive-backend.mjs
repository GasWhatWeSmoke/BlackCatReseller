import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {inventoryPage,parseInventoryQuery} from '../../src/lib/inventoryQuery.ts';
import {applyItemChanges} from '../../src/lib/itemUpdate.ts';
const root=fileURLToPath(new URL('../..',import.meta.url)),folder=path.resolve(process.argv[2]);
assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));
assert.ok(path.basename(folder).startsWith('blackcat-archive-workflow-'));
assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'owner.json'),'utf8')).fixture,'archive-workflow');
const req=createRequire(import.meta.url),{PrismaClient}=req('@prisma/client'),sharp=req('sharp');
const file=path.join(folder,'fixture.db');assert.ok(!fs.existsSync(file));fs.copyFileSync(path.join(root,'config/template.db'),file);
const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')+'?connection_limit=1'}}});
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let originals=[],photoRows='',listingRows='',jobRows='',calls=[];
const snapshot=async()=>({items:await db.item.findMany({orderBy:{sku:'asc'},select:{id:true,sku:true,status:true,updatedAt:true,createdAt:true,readyFolderPath:true,notes:true}}),calls});
try {
 for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const message=JSON.parse(line),a=message.args||{};let data;
  if(message.op==='seed') {
   assert.equal(await db.item.count(),0);
   const run=await db.publishRun.create({data:{status:'running',marketplacesJson:'["ebay"]',totalJobs:1}});
   for(let i=0;i<100;i++) {
    const sku='ARC-'+String(i+1).padStart(3,'0'),original=path.join(folder,sku+'.jpg');
    await sharp({create:{width:16,height:16,channels:3,background:{r:30,g:50,b:70}}}).jpeg().toFile(original);
    originals.push({path:original,sha256:digest(original)});
    const item=await db.item.create({data:{sku,brand:'Fixture',size:'M',itemType:'T-Shirt',category:'Clothing',condition:'Good',listedPrice:25,itemCost:5,
      status:i===95?'Sold':'Ready',salePrice:i===95?20:null,niftyStatus:i===99?'Published':'Not Uploaded',readyFolderPath:path.join(folder,'prepared-'+sku),aiFields:'[]'}});
    await db.photo.create({data:{itemId:item.id,originalFilename:sku+'.jpg',storedPath:original,sha256:digest(original),isCover:true}});
    if(i===96||i===97)await db.marketplaceListing.create({data:{itemId:item.id,marketplace:i===96?'depop':'ebay',status:i===96?'published':'unknown'}});
    if(i===98)await db.publishJob.create({data:{runId:run.id,itemId:item.id,marketplace:'ebay',status:'queued'}});
   }
   photoRows=JSON.stringify(await db.photo.findMany({orderBy:{id:'asc'}}));listingRows=JSON.stringify(await db.marketplaceListing.findMany({orderBy:{id:'asc'}}));jobRows=JSON.stringify(await db.publishJob.findMany({orderBy:{id:'asc'}}));
   data=await snapshot();
  } else if(message.op==='page') data=await inventoryPage(db,parseInventoryQuery(new URLSearchParams(a.params)));
  else if(message.op==='change') {
   assert.deepEqual(Object.keys(a.body),['bulkArchive']);calls.push({id:a.id,action:a.body.bulkArchive.action});
   data=await applyItemChanges(db,a.id,a.body);
  } else if(message.op==='mutate') {
   const item=await db.item.findUniqueOrThrow({where:{id:a.id}});
   data=await db.item.update({where:{id:a.id},data:{notes:'Fixture concurrent edit',updatedAt:new Date(item.updatedAt.getTime()+1000)}});
  } else if(message.op==='snapshot') data=await snapshot();
  else if(message.op==='close') {
   assert.equal(JSON.stringify(await db.photo.findMany({orderBy:{id:'asc'}})),photoRows);
   assert.equal(JSON.stringify(await db.marketplaceListing.findMany({orderBy:{id:'asc'}})),listingRows);
   assert.equal(JSON.stringify(await db.publishJob.findMany({orderBy:{id:'asc'}})),jobRows);
   assert.ok(originals.every(row=>digest(row.path)===row.sha256));
   data={...(await snapshot()),photoRowsUnchanged:true,originalFilesUnchanged:true,listingsAndJobsUnchanged:true};
   await db.$disconnect();await new Promise(resolve=>process.stdout.write(JSON.stringify({id:message.id,ok:true,data})+'\n',resolve));break;
  } else throw Error('Unexpected archive fixture operation');
  await new Promise(resolve=>process.stdout.write(JSON.stringify({id:message.id,ok:true,data})+'\n',resolve));
 }
}finally{await db.$disconnect()}
process.exit(0);
