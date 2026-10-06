import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadRecovery,recoveryGuidance,retryFailedJobs } from './recovery.ts';
import { resolvePublishAttempt } from './attempts.ts';

async function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-recovery-'));
  const database=path.join(root,'test.db');fs.copyFileSync(path.resolve('config/template.db'),database);
  const db=new PrismaClient({datasources:{db:{url:`file:${database.replaceAll('\\','/')}`}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const item=await db.item.create({data:{sku:'RECOVERY-TEST',status:'Ready'}});
  const run=await db.publishRun.create({data:{status:'done',marketplacesJson:'["ebay"]',totalJobs:1}});
  const job=await db.publishJob.create({data:{runId:run.id,itemId:item.id,marketplace:'ebay',status:'failed',errorClass:'retryable',lastError:'Connection timed out before posting'}});
  await db.marketplaceListing.create({data:{itemId:item.id,marketplace:'ebay',status:'not_published'}});
  return {db,item,run,job};
}

test('unknown outcomes require verification and never enter a retry queue',async t=>{
  const {db,item,run,job}=await fixture(t);
  await db.marketplaceListing.update({where:{itemId_marketplace:{itemId:item.id,marketplace:'ebay'}},data:{status:'unknown'}});
  const row=(await loadRecovery(db)).items[0];
  assert.equal(row.needsVerification,true);assert.equal(row.canRetry,false);assert.equal(row.guidance.kind,'verify');
  const retry=await retryFailedJobs(db,run.id,[job.id]);assert.equal(retry.ok,false);
  assert.equal((await db.publishJob.findUniqueOrThrow({where:{id:job.id}})).status,'failed');
  assert.equal((await db.marketplaceListing.findFirstOrThrow()).status,'unknown');
});

test('resolved historical failures do not remain in the attention list',async t=>{
  const {db,item}=await fixture(t);
  await db.marketplaceListing.update({where:{itemId_marketplace:{itemId:item.id,marketplace:'ebay'}},data:{status:'published'}});
  assert.equal((await loadRecovery(db)).items.length,0);
});

test('only the latest attempt is retryable and queueing it clears its error',async t=>{
  const {db,item,run,job}=await fixture(t);
  const nextRun=await db.publishRun.create({data:{status:'done',marketplacesJson:'["ebay"]',totalJobs:1}});
  const next=await db.publishJob.create({data:{runId:nextRun.id,itemId:item.id,marketplace:'ebay',status:'requires_review',validationJson:'{bad',lastError:'Check size'}});
  assert.deepEqual((await loadRecovery(db)).items.map(row=>row.jobId),[next.id]);
  assert.equal((await loadRecovery(db)).items[0].validation,null);
  assert.equal((await retryFailedJobs(db,run.id,[job.id])).ok,false);
  const result=await retryFailedJobs(db,nextRun.id,[next.id]);assert.equal(result.retried,1);
  const saved=await db.publishJob.findUniqueOrThrow({where:{id:next.id}});
  assert.equal(saved.status,'queued');assert.equal(saved.lastError,null);
  assert.equal((await loadRecovery(db)).items.length,0);
});

test('sold items and explicit cancellations never get retried as failed uploads',async t=>{
  const {db,item,run,job}=await fixture(t);
  await db.item.update({where:{id:item.id},data:{status:'Sold'}});
  assert.equal((await retryFailedJobs(db,run.id)).retried,0);
  assert.equal((await loadRecovery(db)).items.length,0);
  await db.item.update({where:{id:item.id},data:{status:'Ready'}});
  await db.publishJob.update({where:{id:job.id},data:{status:'cancelled'}});
  assert.equal((await retryFailedJobs(db,run.id)).retried,0);
  await db.marketplaceListing.update({where:{itemId_marketplace:{itemId:item.id,marketplace:'ebay'}},data:{status:'unknown'}});
  assert.equal((await loadRecovery(db)).items[0].needsVerification,true);
});

test('invalid or empty retry selections do not mean retry everything',async t=>{
  const {db,run}=await fixture(t);
  for(const ids of [[],[0],[-1],[NaN]])assert.equal((await retryFailedJobs(db,run.id,ids)).retried,0);
  assert.equal(await db.publishJob.count({where:{status:'queued'}}),0);
});

test('guidance distinguishes account access, details, and safe retry',()=>{
  assert.equal(recoveryGuidance({needsVerification:false,error:'Sign in required',errorClass:'requires_review'}).kind,'account');
  assert.equal(recoveryGuidance({needsVerification:false,error:'Size is missing',errorClass:'requires_review'}).kind,'details');
  assert.equal(recoveryGuidance({needsVerification:false,error:'Network timeout',errorClass:'retryable'}).kind,'retry');
});

test('an old job touched later cannot own recovery, retry or verification of a newer attempt',async t=>{
  const {db,item,run,job}=await fixture(t);
  const nextRun=await db.publishRun.create({data:{status:'done',marketplacesJson:'["ebay"]',totalJobs:1}});
  const next=await db.publishJob.create({data:{runId:nextRun.id,itemId:item.id,marketplace:'ebay',status:'requires_review'}});
  await db.publishJob.update({where:{id:job.id},data:{updatedAt:new Date('2099-01-01'),lastError:'Historical error updated'}});
  assert.deepEqual((await loadRecovery(db)).items.map(row=>row.jobId),[next.id]);
  assert.equal((await retryFailedJobs(db,run.id,[job.id])).ok,false);
  await db.marketplaceListing.updateMany({where:{itemId:item.id},data:{status:'unknown'}});
  const row=(await loadRecovery(db)).items[0];
  assert.ok(row.verificationRevision);
  const before=await db.marketplaceListing.findMany();
  const jobsBefore=await db.publishJob.findMany();
  const rejected=await resolvePublishAttempt(db,job.id,'not_published',undefined,row.verificationRevision!);
  assert.equal(rejected.ok,false);assert.match(rejected.error!,/newer/);
  assert.deepEqual(await db.marketplaceListing.findMany(),before);
  assert.deepEqual(await db.publishJob.findMany(),jobsBefore);
  assert.equal((await resolvePublishAttempt(db,next.id,'not_published',undefined,row.verificationRevision!)).ok,true);
  assert.equal((await db.marketplaceListing.findFirstOrThrow()).status,'not_published');
  assert.equal(await db.publishJob.count({where:{status:'queued'}}),0);
});

for(const change of ['job revision','listing revision','another attempt','listing replaced'] as const) {
  test(`verification rejects ${change} since the operator loaded recovery without changing records`,async t=>{
    const {db,item,job}=await fixture(t);
    await db.marketplaceListing.updateMany({where:{itemId:item.id},data:{status:'unknown'}});
    const row=(await loadRecovery(db)).items[0];
    const listing=await db.marketplaceListing.findFirstOrThrow();
    if(change==='job revision')await db.publishJob.update({where:{id:job.id},data:{updatedAt:new Date('2099-01-01')}});
    if(change==='listing revision')await db.marketplaceListing.update({where:{id:listing.id},data:{updatedAt:new Date('2099-01-01')}});
    if(change==='another attempt') {
      // Even equal timestamp precision cannot hide a new attempt on the same job.
      await db.publishJob.update({where:{id:job.id},data:{attemptCount:{increment:1},updatedAt:job.updatedAt}});
      await db.marketplaceListing.update({where:{id:listing.id},data:{attemptCount:{increment:1},updatedAt:listing.updatedAt}});
    }
    if(change==='listing replaced') {
      await db.marketplaceListing.delete({where:{id:listing.id}});
      await db.marketplaceListing.create({data:{...listing,id:listing.id+1}});
    }
    const before=await db.marketplaceListing.findMany();
    const jobsBefore=await db.publishJob.findMany();
    for(const outcome of ['published','not_published'] as const) {
      const result=await resolvePublishAttempt(db,job.id,outcome,'https://www.ebay.com/itm/123456789012',row.verificationRevision!);
      assert.equal(result.ok,false);assert.match(result.error!,/changed/);
    }
    assert.deepEqual(await db.marketplaceListing.findMany(),before);
    assert.deepEqual(await db.publishJob.findMany(),jobsBefore);
    const fresh=(await loadRecovery(db)).items[0];
    assert.notEqual(fresh.verificationRevision,row.verificationRevision);
    assert.equal((await resolvePublishAttempt(db,job.id,'not_published',undefined,fresh.verificationRevision!)).ok,true);
  });
}

test('missing confirmation revision cannot clear uncertainty',async t=>{
  const {db,item,job}=await fixture(t);
  await db.marketplaceListing.updateMany({where:{itemId:item.id},data:{status:'unknown'}});
  assert.equal((await resolvePublishAttempt(db,job.id,'not_published',undefined,'')).ok,false);
  assert.equal((await db.marketplaceListing.findFirstOrThrow()).status,'unknown');
});
