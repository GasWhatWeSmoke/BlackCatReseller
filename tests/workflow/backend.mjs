import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { nativeIntakeCase } from './intake-cases.mjs';
const root=process.cwd(), fixture=path.resolve(process.argv[2]);
if(path.dirname(fixture)!==path.resolve(os.tmpdir())||!path.basename(fixture).startsWith('blackcat-workflow-')||fs.lstatSync(fixture).isSymbolicLink()||!fs.existsSync(path.join(fixture,'fixture-owner.json'))||JSON.parse(fs.readFileSync(path.join(fixture,'fixture-owner.json'),'utf8')).fixture!==true)throw Error('An explicitly owned temporary workflow folder is required.');
const inside=file=>path.resolve(file).startsWith(fixture+path.sep);
const file=path.join(fixture,'inventory.db');
if(!fs.existsSync(file))fs.copyFileSync(path.join(root,'config/template.db'),file);
process.env.DATABASE_URL='file:'+file.replaceAll('\\','/');process.env.BLACKCAT_PREVIEW='1';
const require=createRequire(path.join(root,'package.json')),ts=require('typescript'),{PrismaClient,Prisma}=require('@prisma/client'),sharp=require('sharp');
const output=process.stdout.write.bind(process.stdout);console.log=(...args)=>process.stderr.write(args.map(String).join(' ')+'\n');
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});
const module=async name=>import(pathToFileURL(path.join(root,'src/lib',name+'.ts')).href);
const [listing,archive,outcome,prepared,copy,edit,inventory,canonical,relist,errors,attempts,create,engine,status,recovery,coordinator,types,sale,removals,earnings,vocab,shipping,photos]=await Promise.all([
 'listing','fileArchive','intakeOutcome','preparedPhotos','listingCopy','itemUpdate','inventoryQuery','publish/canonical','publish/relistPricing','publish/errors','publish/attempts','publish/createQueuedRun','publish/engineState','publish/statusRun','publish/recovery','browserCoordinator','publish/types','publish/saleProtection','publish/removalQueue','earningsPage','vocabularyStore','shippingStatus','photoMutations'].map(module));
const base=JSON.parse(fs.readFileSync(path.join(root,'config/defaults.json'),'utf8')).defaults;
function scrub(value){if(!value||typeof value!=='object')return;for(const key of Object.keys(value)){if(/apiKey|clientSecret|accessToken|refreshToken|password|authorization/i.test(key))value[key]='';else scrub(value[key]);}}scrub(base);
const settings={...base,dataRoot:fixture,visionEnabled:false,ocrEnabled:false,requiredFieldsForReady:['size','itemType','color','condition','brand','department'],minListingPhotos:3,
 pythonWorkerPath:path.join(root,'worker/.venv/Scripts/python.exe'),publishAbortAfterConsecutiveFailures:0,
 publish:{...base.publish,allowNiftyOverlap:false,pacingSeconds:0,maxAttempts:1,relistPricing:'preserve_marketplace',autoRun:{enabled:false,marketplaces:['ebay','depop']},
  ebayBrowser:{enabled:true,autoPost:true,shippingPolicyName:'Fixture shipping',returnPolicyName:'Fixture returns',paymentPolicyName:'Fixture payments'},depop:{enabled:true,autoPost:true,boostListings:false,unlistedBrands:[]},poshmark:{enabled:true,autoPost:true}},
 feeModel:{default:{feePercent:10,fixedFee:0},Poshmark:{feePercent:20,fixedFee:0}},shippingModel:{tiers:[],default:5}};
for(const [key,name] of Object.entries({incomingPath:'incoming',processingPath:'processing',archivePath:'archive',needsReviewPath:'needs-review',readyPath:'ready',exportsPath:'exports',backupsPath:'backups',logsPath:'logs'})){settings[key]=path.join(fixture,name);fs.mkdirSync(settings[key],{recursive:true});}
await db.appSettings.upsert({where:{id:1},create:{id:1,data:JSON.stringify(settings)},update:{data:JSON.stringify(settings)}});
const audit={simulatedRecognition:true,simulatedMarketplace:true,realMarketplaceCalls:0,backups:0,exports:0,publishes:[],removals:[],requests:[],unexpected:[]};
const behavior={failKnown:true,failUnknown:true,hold:null,release:null};
function loadActual(relative,deps,allowFixtureEngine=false){
 const source=ts.transpileModule(fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports={};const injectedProcess=allowFixtureEngine?{env:{...process.env,BLACKCAT_PREVIEW:'0'},cwd:()=>root}:process;
 vm.compileFunction(source,['exports','require','process'],{filename:relative})(exports,name=>{if(!Object.hasOwn(deps,name))throw Error('Unapproved fixture dependency: '+name);return deps[name]},injectedProcess);
 return exports;
}
const persist=loadActual('src/lib/persist.ts',{'node:path':path,'./db':{prisma:db},'./listing':listing,'./fileArchive':archive,'./intakeOutcome':outcome,'./backup':{backupDatabase:async()=>{audit.backups++}}}).persistWorkerResult;
const intake=loadActual('src/lib/worker.ts',{'node:child_process':{spawn:(command,args,options)=>spawn(command,args,{...options,windowsHide:true})},'node:path':path,'node:fs':fs,'node:os':os,
 'node:crypto':crypto,'node:string_decoder':{StringDecoder},'./workerResultValidation.ts':await module('workerResultValidation'),'./workRoots.ts':await module('workRoots')});
const importer=await module('importPhoto');
const exportItem=loadActual('src/lib/export-item.ts',{'node:path':path,'node:fs':fs,'node:crypto':crypto,'@/lib/db':{prisma:db},'@/lib/settings':{getRequiredSettings:async()=>settings},'@/lib/listingCopy':copy,'@/lib/listing':listing,'./preparedPhotos':prepared,
 '@/lib/worker':{runExport:async(_settings,spec)=>{
  if(!inside(spec.readyDir)||spec.listingPhotos.some(photo=>!inside(photo.src)))throw Error('Export escaped fixture');
  const specFile=path.join(fixture,'export-'+crypto.randomUUID()+'.json');fs.writeFileSync(specFile,JSON.stringify(spec));
  try{const raw=execFileSync(settings.pythonWorkerPath,['-m','black_cat_worker.export',specFile],{cwd:path.join(root,'worker'),env:{...process.env,PYTHONPATH:'',PYTHONIOENCODING:'utf-8'},windowsHide:true,encoding:'utf8'});
   const receipt=JSON.parse(raw.trim());if(receipt.ok!==true||receipt.readyDir!==spec.readyDir)throw Error('Unconfirmed export');audit.exports++;return receipt.readyDir;
  }finally{if(!inside(specFile))throw Error('Invalid fixture file');fs.unlinkSync(specFile);}
 }}}).exportItemById;
const [ebayMapping,depopMapping,poshMapping]=await Promise.all(['publish/adapters/ebay-browser/mapping','publish/adapters/depop/mapping','publish/adapters/poshmark/mapping'].map(module));
const adapters=['ebay','depop','poshmark'].map(id=>({id,name:id==='ebay'?'eBay':id==='depop'?'Depop':'Poshmark',implemented:true,availability:()=>({configured:true,reason:null}),
 validate:(value,s)=>id==='ebay'?ebayMapping.ebayBrowserValidate(value,s):id==='depop'?depopMapping.depopValidate(value,s):poshMapping.poshmarkValidate(value,s),
 publish:async value=>{
  if(!coordinator.claimBrowser('fixture '+id))throw Error('Fixture browser ownership failed');
  try{
   audit.publishes.push({sku:value.sku,marketplace:id,at:Date.now()});
   if(behavior.hold===value.sku+':'+id)await new Promise(resolve=>{behavior.release=resolve});
   if(value.sku==='900005'&&id==='depop'&&behavior.failKnown)throw new types.PublishError('Fixture form rejected before submission','requires_review',true);
   if(value.sku==='900006'&&id==='ebay'&&behavior.failUnknown)throw new types.PublishError('Fixture response lost after submission','retryable');
   const externalListingId=id==='ebay'?'987654'+value.sku:id==='depop'?'fixture-'+value.sku:Number(value.sku).toString(16).padStart(24,'0');
   return {ok:true,externalListingId,externalUrl:id==='ebay'?'https://www.ebay.com/itm/'+externalListingId:id==='depop'?'https://www.depop.com/products/'+externalListingId:'https://www.poshmark.com/listing/fixture-'+externalListingId,publishedPrice:value.price,publishedTitle:value.title};
  }finally{coordinator.releaseBrowser();}
 }}));
const queue=loadActual('src/lib/publish/queue.ts',{'@prisma/client':{Prisma},'./liveProgress.ts':{currentUploadPhase:()=>null},'./recovery.ts':recovery,'./statusRun.ts':status,'../db.ts':{prisma:db},'../settings.ts':{getSettings:async()=>settings},'./canonical.ts':canonical,'./relistPricing.ts':relist,'./errors.ts':errors,'./adapters/registry.ts':{getAdapter:id=>adapters.find(adapter=>adapter.id===id)},'./createQueuedRun.ts':create,'./engineState.ts':engine,'../browserCoordinator.ts':coordinator,'./types.ts':types,'./attempts.ts':attempts},true);
const past=await module('pastUploads'),mercari=await module('publish/mercariGoal'),eligibility=await module('publish/eligibility'),eligibilityView=await module('publish/eligibilityView');
const marketplaceInfo=()=>adapters.map(({id,name,implemented})=>({id,name,implemented,configured:true,reason:null}));
const item=async id=>{const row=await db.item.findUnique({where:{id},include:{photos:{orderBy:{sortOrder:'asc'}},marketplaceListings:true}});return row?{...row,displayStatus:(await module('inventoryState')).inventoryState(row)}:null};
async function seed(count){
 if(await db.item.count())throw Error('Fixture already contains inventory');if(![50,100].includes(count))throw Error('Use a representative 50 or 100 item batch');
 execFileSync(settings.pythonWorkerPath,[path.join(root,'tests/workflow/photos.py'),fixture,String(count)],{cwd:root,env:{...process.env,PYTHONPATH:'',PYTHONIOENCODING:'utf-8'},windowsHide:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'camera-manifest.json'),'utf8')),byName=new Map(manifest.files.map(row=>[row.filename,row]));
 const importStart=performance.now();
 for(const photo of [...manifest.files].reverse())await importer.writeIncomingPhoto(settings.incomingPath,photo.filename,fs.readFileSync(path.join(fixture,'camera',photo.filename)));
 const importMs=Math.round(performance.now()-importStart),progress=[];
 const result=await intake.runIntake(settings,event=>progress.push(event),{forceNoAi:true});
 if(result.items.length!==count||result.collisions.length||result.needsReview.length||result.problems.length)throw Error('Native intake did not produce the expected complete batch');
 let markers=0,listingPhotos=0;
 for(const row of result.items){
  if(row.originalQrValue!=='BC-'+row.sku||row.grouping?.orderSource!=='exif'||!row.enrichment?.skipped||row.photos.length!==4)throw Error('QR/order/no-AI receipt mismatch');
  for(const [index,photo] of row.photos.entries()){
   const original=byName.get(photo.originalFilename);
   if(!original||original.sku!==row.sku||original.angle!==index||original.marker!==photo.isMarker||photo.sha256!==original.sha256||!inside(photo.storedPath)
    ||crypto.createHash('sha256').update(fs.readFileSync(photo.storedPath)).digest('hex')!==original.sha256)throw Error('A native grouped photo lost its source identity');
   if(photo.isMarker){markers++;if(photo.includeInListing||photo.isCover)throw Error('A QR marker entered listing photos');}
   else{listingPhotos++;if(!photo.includeInListing||!photo.thumbPath||!inside(photo.thumbPath)||!fs.existsSync(photo.thumbPath))throw Error('Native photo or thumbnail missing');}
  }
  // Recognition is intentionally simulated AFTER the real no-AI worker receipt.
  const brand=row.sku==='900001'?'Wrong Brand':'Nike';
  row.enrichment={fields:{brand,size:'M',color:'Blue',itemType:'T-shirt',category:'Tops'},aiFields:['brand','size','color','itemType'],raw:{brand,size:'M',color:'Blue',itemType:'T-shirt',department:'Men',category:'Tops',confidence:.8,evidence:{brand:{value:brand,status:'inferred',sources:['synthetic recognition fixture']}}}};
 }
 const summary=await persist(result,settings);
 if(summary.itemsCreated!==count||fs.readdirSync(settings.incomingPath).length)throw Error('Import did not preserve the expected originals/archive state');
 const receipt={batchId:result.batchId,items:count,markers,listingPhotos,photos:result.counts.photosProcessed,importMs,workerMs:result.durationMs,sourceDimensions:manifest.dimensions,
  realQrDecodes:progress.filter(event=>event.stage==='decode'&&event.sku).length,firstSku:result.items[0].sku,lastSku:result.items.at(-1).sku,order:'exif',ocrEnabled:false,forceNoAi:true};
 fs.writeFileSync(path.join(fixture,'native-intake-proof.json'),JSON.stringify(receipt));return summary;
}
async function dispatch(message){
 const {op,args={}}=message;
 if(op==='intake-case')return nativeIntakeCase(args.stage,{root,fixture,settings,db,intake,importer,persist});
 if(op==='seed')return seed(args.count);
 if(op==='intakeProof')return JSON.parse(fs.readFileSync(path.join(fixture,'native-intake-proof.json'),'utf8'));
 if(op==='reimport'){
  const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'camera-manifest.json'),'utf8'));
  const before=await db.item.findMany({orderBy:{id:'asc'},include:{photos:{orderBy:{id:'asc'}}}});
  for(const photo of manifest.files.filter(row=>row.sku==='900001'))await importer.writeIncomingPhoto(settings.incomingPath,photo.filename,fs.readFileSync(path.join(fixture,'camera',photo.filename)));
  const result=await intake.runIntake(settings,undefined,{forceNoAi:true}),summary=await persist(result,settings);
  if(JSON.stringify(before)!==JSON.stringify(await db.item.findMany({orderBy:{id:'asc'},include:{photos:{orderBy:{id:'asc'}}}}))||fs.readdirSync(settings.incomingPath).length)throw Error('Exact reimport changed inventory or retained incoming originals');
  return summary;
 }
 if(op==='behavior'){const {release,...changes}=args;Object.assign(behavior,changes);if(release&&typeof behavior.release==='function'){const resume=behavior.release;behavior.release=null;behavior.hold=null;resume();}return {ok:true};}
 if(op==='verifyPrepared'){
  const rows=await db.item.findMany({include:{photos:true}});let files=0,archivedOriginals=0;
  const native=JSON.parse(fs.readFileSync(path.join(fixture,'native-intake-proof.json'),'utf8'));
  for(const row of rows){for(const photo of row.photos){const original=path.join(settings.archivePath,native.batchId,photo.originalFilename),camera=path.join(fixture,'camera',photo.originalFilename);if(!inside(original)||crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex')!==photo.sha256||crypto.createHash('sha256').update(fs.readFileSync(camera)).digest('hex')!==photo.sha256)throw Error('Archived/camera original changed or missing');archivedOriginals++;}const folder=row.readyFolderPath;if(!folder||!inside(folder))throw Error('Prepared folder missing');const manifest=JSON.parse(fs.readFileSync(path.join(folder,'item.json'),'utf8'));const snapshot=manifest.photoSnapshot;if(snapshot.itemId!==row.id||snapshot.sku!==row.sku)throw Error('Prepared identity mismatch');
   for(let index=0;index<snapshot.recipe.length;index++){const recipe=snapshot.recipe[index],file=path.join(folder,'listing_photos',recipe.name);if(!inside(file)||!recipe.name.startsWith(row.sku+'_'))throw Error('Photo crossed inventory identity');if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==snapshot.files[index].sha256)throw Error('Prepared bytes changed');files++;}}
  const first=rows[0],manifest=JSON.parse(fs.readFileSync(path.join(first.readyFolderPath,'item.json'),'utf8'));const output=await sharp(path.join(first.readyFolderPath,'listing_photos',manifest.photoSnapshot.recipe[0].name)).metadata();
  return {items:rows.length,files,archivedOriginals,firstRotation:manifest.photoSnapshot.recipe[0].rotation,firstDimensions:[output.width,output.height]};
 }
 if(op==='snapshot'){
  // A run can finish between the jobs read and the final engine check. Never
  // label a snapshot taken during that run as a settled result.
  const activeAtStart=queue.engineActive();
  return {audit,items:await db.item.findMany({orderBy:{id:'asc'},include:{marketplaceListings:true}}),jobs:await db.publishJob.findMany({orderBy:{id:'asc'}}),runs:await db.publishRun.findMany(),photos:await db.photo.count(),pendingOriginals:fs.readdirSync(settings.incomingPath).length,engineActive:activeAtStart||queue.engineActive()};
 }
 if(op==='sale'){
  const listing=await db.marketplaceListing.findUniqueOrThrow({where:{itemId_marketplace:{itemId:args.itemId,marketplace:args.marketplace}}});
  return sale.recordConfirmedSale(db,{marketplace:args.marketplace,listingId:listing.externalListingId,listingUrl:listing.externalUrl,reference:'FIXTURE-ORDER-'+args.itemId,classification:'confirmed_sale',financials:{currency:'USD',salePriceCents:3000,shippingChargedCents:0,soldAt:new Date(Math.floor(Date.now()/1000)*1000).toISOString()}});
 }
 if(op==='remove')return removals.processRemovalQueue(db,settings,{recoverInterrupted:true,now:new Date(Date.now()+120000),runWorker:async(_s,attempt)=>{audit.removals.push(attempt);return {outcome:args.unknown?'unknown':'ended',verified:!args.unknown,reason:'Fixture marketplace observation'};}});
 if(op==='request'){
  const {url:raw,method='GET',body=null}=args,url=new URL(raw,'http://fixture.invalid');audit.requests.push({path:url.pathname,method});
  if(url.pathname==='/api/settings')return {settings};
  if(url.pathname==='/api/ship-queue')return shipping.readShippingCount(db);
  if(url.pathname==='/api/vocab')return method==='POST'?vocab.saveVocabularyEntry(db,body):vocab.readVocabulary(db);
  if(url.pathname==='/api/items'&&url.searchParams.get('view')==='inventory')return inventory.inventoryPage(db,inventory.parseInventoryQuery(url.searchParams));
  if(url.pathname==='/api/items'&&url.searchParams.get('view')==='pricing-index'){const pricing=await module('pricingRead');return pricing.readPricingIndex(db,pricing.pricingIds(url.searchParams.get('ids')));}
  if(url.pathname==='/api/items'&&url.searchParams.get('view')?.startsWith('review-')){const review=await module('reviewQueueRead'),view=url.searchParams.get('view');return view==='review-index'?review.readReviewIndex(db):view==='review-signatures'?review.readReviewSignatures(db,review.reviewIds(url.searchParams.get('ids'))):review.readReviewDetails(db,review.reviewIds(url.searchParams.get('ids')));}
  if(url.pathname==='/api/items'&&url.searchParams.get('view')==='pricing-rows'){const pricing=await module('pricingRead');return pricing.readPricingRows(db,pricing.pricingIds(url.searchParams.get('ids')));}
  const neighbor=/^\/api\/items\/(\d+)\/neighbors$/.exec(url.pathname);if(neighbor)return inventory.inventoryNeighbors(db,Number(neighbor[1]),inventory.parseInventoryQuery(url.searchParams));
  if(url.pathname==='/api/items'){
   const where=url.searchParams.has('needsInfo')?{status:{in:['Photographed','Needs Info']}}:url.searchParams.has('unpriced')?{status:{notIn:['Sold','Archived','Removed']},listedPrice:null}:{};
   return {items:await db.item.findMany({where,orderBy:{sku:'asc'},include:{photos:{orderBy:{sortOrder:'asc'}},marketplaceListings:true}}),truncated:false};
  }
  if(url.pathname==='/api/items/bulk-delete'&&method==='POST'){const deletion=await module('itemDelete');return deletion.deleteSelectedItems(body?.ids,body?.expectedItems,{store:db,settings});}
  const itemPath=/^\/api\/items\/(\d+)$/.exec(url.pathname);if(itemPath){
   if(method==='PATCH')return edit.applyItemChanges(db,Number(itemPath[1]),body);
   if(method==='DELETE'){const deletion=await module('itemDelete'),selection=await module('itemDeleteSelection');const expected=selection.parseItemDeleteExpectation(body?.expected);
    const result=await deletion.deleteItem(Number(itemPath[1]),{store:db,settings,expected,force:url.searchParams.get('force')==='1'});return {status:result.ok?200:result.error==='not found'?404:409,body:result};}
   return {item:await item(Number(itemPath[1]))};
  }
  const ready=/^\/api\/items\/(\d+)\/ready$/.exec(url.pathname);if(ready){const result=await exportItem(Number(ready[1]),body||{});return {status:result.ok?200:result.error==='GATE_FAILED'?422:409,body:result};}
  if(/\/price-research$/.test(url.pathname))return {past:[],comparables:[]};
  if(url.pathname==='/api/publish/auto-run')return {config:settings.publish.autoRun,state:'off',needsAttention:0,error:null,runId:null};
  if(url.pathname==='/api/publish/status')return {...await queue.runStatus(),marketplaces:marketplaceInfo(),browserBusyWith:coordinator.browserHolder()};
  if(url.pathname==='/api/publish/eligible')return eligibility.readPublishEligibility(db,settings,adapters,eligibilityView.parseEligibilityQuery(url.searchParams));
  if(url.pathname==='/api/publish/runs'&&method==='POST')return queue.createRun(body.itemIds,body.marketplaces);
  const run=/^\/api\/publish\/runs\/(\d+)$/.exec(url.pathname);if(run&&method==='POST')return body.action==='retry'?queue.retryJobs(Number(run[1]),body.jobIds):queue.controlRun(Number(run[1]),body.action);
  if(url.pathname==='/api/publish/removals'){if(method==='POST'){const result=await dispatch({op:'remove',args:{unknown:behavior.unknownRemoval===true}});return {ok:true,started:!result.busy};}return {active:false,lastError:null,lastFinishedAt:null,waitingForBrowser:false,backlog:(await sale.removalBacklog(db)).map(row=>({...row,supported:true}))};}
  if(url.pathname==='/api/publish/mercari-goal')return mercari.mercariGoal(settings.publish.mercariListingLimit,await db.item.findMany({where:{status:'Sold'},include:{marketplaceListings:true}}));
  if(url.pathname==='/api/publish/recovery')return recovery.loadRecovery(db);
  if(url.pathname==='/api/past-uploads')return past.loadUploadHistory(db,past.parseHistoryQuery(url.searchParams));
  if(url.pathname==='/api/earnings')return earnings.readEarningsPage(db,settings,earnings.parseEarningsQuery(url.searchParams));
  const photo=/^\/api\/photos\/(\d+)$/.exec(url.pathname);if(photo&&method==='PATCH')return photos.editPhoto(db,Number(photo[1]),body);
  audit.unexpected.push({path:url.pathname,method});throw Error('Unsupported fixture UI operation: '+method+' '+url.pathname);
 }
 throw Error('Unknown fixture operation');
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){let message;try{message=JSON.parse(line);if(message.op==='close'){await db.$disconnect();input.close();process.stdin.destroy();output(JSON.stringify({id:message.id,ok:true,data:{closed:true}})+'\n',()=>process.exit(0));break;}const data=await dispatch(message);output(JSON.stringify({id:message.id,ok:true,data})+'\n');}catch(error){output(JSON.stringify({id:message?.id,ok:false,error:error instanceof Error?error.stack:String(error)})+'\n');}}
await db.$disconnect();
