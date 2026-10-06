import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyArchiveCleanup,previewArchiveCleanup,runArchiveCleanup,validateArchiveTarget } from './archiveCleanup.ts';
import { archivePreview,archiveResult } from './archiveCleanupView.ts';
import { tryReserveIncomingMutation,releaseIncomingMutation,tryReserveIntake,releaseIntakePrep } from './worker.ts';

async function fixture(t:TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-archive-safe-')),projectRoot=path.join(root,'app'),dataRoot=path.join(root,'data');
  fs.mkdirSync(projectRoot);fs.mkdirSync(dataRoot);const file=path.join(dataRoot,'catalog.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll('\\','/')}`}}});
  const settings={dataRoot,incomingPath:path.join(dataRoot,'incoming'),processingPath:path.join(dataRoot,'processing'),readyPath:path.join(dataRoot,'ready'),needsReviewPath:path.join(dataRoot,'review'),archivePath:path.join(dataRoot,'archive'),backupsPath:path.join(dataRoot,'backups'),exportsPath:path.join(dataRoot,'exports'),logsPath:path.join(dataRoot,'logs'),pythonWorkerPath:path.join(projectRoot,'worker','python.exe')};
  for(const folder of [settings.incomingPath,settings.processingPath,settings.readyPath,settings.needsReviewPath,settings.archivePath,settings.backupsPath,settings.exportsPath,settings.logsPath])fs.mkdirSync(folder);
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('blackcat-archive-safe-'));fs.rmSync(root,{recursive:true,force:true});});
  const photo=(name:string,folder=settings.archivePath)=>{const file=path.join(folder,name);assert.ok(path.resolve(file).startsWith(root+path.sep));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.concat([Buffer.from([255,216,255]),Buffer.from(name)]));return file;};
  return {root,db,settings,context:{projectRoot,databasePath:file},photo};
}

test('archive target rejects filesystem roots, working/backup/program overlaps and changed confirmed paths',async t=>{
  const f=await fixture(t);
  for(const archivePath of [path.parse(f.root).root,f.settings.readyPath,f.settings.backupsPath,f.settings.dataRoot,f.context.projectRoot,path.join(f.context.projectRoot,'src'),path.join(f.settings.readyPath,'nested')])
    await assert.rejects(validateArchiveTarget({...f.settings,archivePath},archivePath,f.context));
  await assert.rejects(validateArchiveTarget(f.settings,f.settings.readyPath,f.context),/location changed/);
  assert.equal((await validateArchiveTarget(f.settings,f.settings.archivePath,f.context)).exists,true);
});

test('only reviewed unreferenced photos are removed; inventory, dedup, collisions, issues and nonphotos are retained',async t=>{
  const f=await fixture(t),remove=f.photo('batch/original.jpg'),photo=f.photo('photo.jpg'),hash=f.photo('hash.jpg'),pending=f.photo('pending.jpg'),issue=f.photo('issue.jpg');
  fs.writeFileSync(path.join(f.settings.archivePath,'backup.db'),'do not remove');fs.writeFileSync(path.join(f.settings.archivePath,'fake.jpg'),'not a photo');
  const item=await f.db.item.create({data:{sku:'KEEP'}});
  await f.db.photo.create({data:{itemId:item.id,originalFilename:'photo.jpg',storedPath:photo,sha256:'photo'}});
  await f.db.fileHash.create({data:{originalFilename:'hash.jpg',processedPath:hash,sha256:'hash'}});
  await f.db.collision.create({data:{sku:'PENDING',incomingPhotosJson:JSON.stringify([{storedPath:pending}])}});
  await f.db.problemLog.create({data:{type:'UNREADABLE_FILE',photoPath:issue,resolved:false}});
  const counts=[await f.db.item.count(),await f.db.photo.count(),await f.db.fileHash.count(),await f.db.collision.count(),await f.db.problemLog.count()];
  const preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);archivePreview(preview);assert.equal(preview.files,1);assert.equal(preview.retained,6);assert.equal(fs.existsSync(remove),true);
  const result=await applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context);archiveResult(result,preview);assert.equal(result.removed,1);assert.equal(result.failed,0);assert.equal(fs.existsSync(remove),false);
  for(const file of [photo,hash,pending,issue,path.join(f.settings.archivePath,'backup.db'),path.join(f.settings.archivePath,'fake.jpg')])assert.equal(fs.existsSync(file),true);
  assert.deepEqual([await f.db.item.count(),await f.db.photo.count(),await f.db.fileHash.count(),await f.db.collision.count(),await f.db.problemLog.count()],counts);
  await assert.rejects(applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context),/changed/);
});

test('new files, changed originals and new references invalidate a preview before deletion',async t=>{
  const f=await fixture(t),first=f.photo('a.jpg');
  let preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);
  f.photo('b.jpg');await assert.rejects(applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context),/changed/);assert.equal(fs.existsSync(first),true);
  preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);fs.appendFileSync(first,'changed');
  await assert.rejects(applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context),/changed/);
  preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);await f.db.problemLog.create({data:{type:'UNREADABLE_FILE',photoPath:first}});
  await assert.rejects(applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context),/changed/);assert.equal(fs.existsSync(first),true);
});

test('linked roots and linked entries cannot redirect cleanup, and shared files stay intact',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);const original=f.photo('outside.jpg',outside);
  const linkedRoot=path.join(f.root,'linked-root');fs.symlinkSync(outside,linkedRoot,process.platform==='win32'?'junction':'dir');
  await assert.rejects(validateArchiveTarget({...f.settings,archivePath:linkedRoot},linkedRoot,f.context),/Linked/);
  fs.symlinkSync(outside,path.join(f.settings.archivePath,'linked'),process.platform==='win32'?'junction':'dir');
  fs.linkSync(original,path.join(f.settings.archivePath,'shared.jpg'));const eligible=f.photo('eligible.jpg');
  const preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);assert.equal(preview.files,1);assert.equal(preview.retained,2);
  const result=await applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context);assert.equal(result.removed,1);assert.equal(fs.existsSync(eligible),false);assert.equal(fs.existsSync(original),true);assert.equal(fs.existsSync(path.join(f.settings.archivePath,'shared.jpg')),true);
});

test('failures and changes during cleanup never inflate the confirmed removal count',async t=>{
  const f=await fixture(t),a=f.photo('a.jpg'),b=f.photo('b.jpg'),c=f.photo('c.jpg'),d=f.photo('d.jpg');
  const preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);
  const result=await applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context,async file=>{
    if(file===a){await fs.promises.unlink(file);fs.appendFileSync(b,'changed after inspection');fs.unlinkSync(d);return;}
    if(file===c)throw Object.assign(Error('fixture access failure'),{code:'EACCES'});
    throw Error('Changed or missing files must not reach removal');
  });
  archiveResult(result,preview);assert.deepEqual([result.requested,result.removed,result.changed,result.failed,result.missing],[4,1,1,1,1]);
  assert.equal(fs.existsSync(b),true);assert.equal(fs.existsSync(c),true);assert.equal(fs.existsSync(a),false);
});

test('malformed reference data, unavailable settings and an active intake leave all files untouched',async t=>{
  const f=await fixture(t),file=f.photo('original.jpg');
  const deps={db:f.db,settings:async()=>f.settings,reserve:tryReserveIncomingMutation,release:releaseIncomingMutation,context:f.context};
  assert.equal(tryReserveIntake(),true);try{await assert.rejects(runArchiveCleanup(deps,{action:'preview',expectedArchivePath:f.settings.archivePath}),/Photo operations/);}finally{releaseIntakePrep();}
  await assert.rejects(runArchiveCleanup({...deps,settings:async()=>{throw Error('settings unavailable');}},{action:'apply',expectedArchivePath:f.settings.archivePath,token:'a'.repeat(64)}),/settings unavailable/);
  assert.equal(tryReserveIncomingMutation(),true);releaseIncomingMutation();
  await f.db.collision.create({data:{sku:'BAD',incomingPhotosJson:'{broken'}});await assert.rejects(previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context));
  assert.equal(fs.existsSync(file),true);
  for(const input of [null,{}, {action:'delete'},{action:['preview']}])await assert.rejects(runArchiveCleanup(deps,input),/Review the archive/);
});

test('missing and empty archives are truthful and result contracts reject incomplete success',async t=>{
  const f=await fixture(t);fs.rmdirSync(f.settings.archivePath);
  const preview=await previewArchiveCleanup(f.db,f.settings,f.settings.archivePath,f.context);assert.equal(preview.missing,true);assert.equal(preview.files,0);archivePreview(preview);
  const result=await applyArchiveCleanup(f.db,f.settings,preview.path,preview.token,f.context);archiveResult(result,preview);assert.equal(result.removed,0);
  assert.throws(()=>archiveResult({ok:true,files:100},preview),/could not be confirmed/);assert.throws(()=>archivePreview({}),/incomplete/);
});

test('cleanup holds the shared reservation against another cleanup or folder-path writer until completion',async t=>{
  const f=await fixture(t);f.photo('original.jpg');let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const deps={db:f.db,settings:async()=>{await held;return f.settings;},reserve:tryReserveIncomingMutation,release:releaseIncomingMutation,context:f.context};
  const first=runArchiveCleanup(deps,{action:'preview',expectedArchivePath:f.settings.archivePath});
  assert.equal(tryReserveIncomingMutation(),false,'folder changes use this same reservation');
  await assert.rejects(runArchiveCleanup(deps,{action:'preview',expectedArchivePath:f.settings.archivePath}),/Photo operations/);
  release();const preview=await first;assert.equal(preview.kind,'preview');assert.equal(tryReserveIncomingMutation(),true);releaseIncomingMutation();
});
