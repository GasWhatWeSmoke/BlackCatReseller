import type { PrismaClient } from '@prisma/client';
import { READY_STATUSES } from '../inventoryState.ts';
import { publicationVerificationRevision, publishBlockReason } from './attempts.ts';
import { applicableTo } from './applicable.ts';

export function recoveryGuidance(problem:{needsVerification:boolean;error:string|null;errorClass:string|null;validation?:unknown}) {
  if(problem.needsVerification)return {kind:'verify',title:'Confirm whether this listing is live',next:'Check the marketplace before another attempt. Record the live listing, or confirm that it was not published.'};
  const message=problem.error ?? '';
  if(/second.monitor|display configuration|monitor.*connect/i.test(message))return {kind:'setup',title:'Reconnect your second monitor',next:'Browser tasks wait for monitor 2. Reconnect it, then retry this listing.'};
  if(/log.?in|sign.?in|authenticat|session.*expir|account.*connect|security check|captcha/i.test(message))return {kind:'account',title:'Your marketplace account needs attention',next:'Open this marketplace in Settings, finish signing in or its security check, then retry.'};
  if(/brand|other fallback/i.test(message))return {kind:'brand',title:'Check the marketplace brand choice',next:'Confirm the brand on the item. If the marketplace does not offer it, allow that brand to use Other in account settings while keeping the real brand in the listing copy.'};
  if(problem.errorClass==='retryable')return {kind:'retry',title:'Ready for a safe retry',next:'The previous attempt did not leave an unresolved live listing. Retry this item; successful listings are skipped.'};
  return {kind:'details',title:'Review this item before retrying',next:'Check the details below, make any correction on the item, then retry only this marketplace.'};
}

/** Latest unresolved attempt per item/platform; historical failures that were
 * subsequently published do not keep resurfacing as work to do. */
export async function loadRecovery(db:Pick<PrismaClient,'publishJob'>) {
  const jobs=await db.publishJob.findMany({where:{status:{in:['failed','requires_review','cancelled']}},orderBy:[{updatedAt:'desc'},{id:'desc'}],take:5000,
    include:{item:{select:{id:true,sku:true,status:true,brand:true,itemType:true,customTitle:true,trueVintage:true,
      photos:{where:{isMarker:false},orderBy:[{isCover:'desc'},{sortOrder:'asc'}],take:1,select:{storedPath:true,thumbPath:true,rotation:true}},
      marketplaceListings:{select:{id:true,marketplace:true,status:true,externalUrl:true,externalListingId:true,updatedAt:true,attemptCount:true,lastAttemptAt:true}},
      publishJobs:{orderBy:{id:'desc'},select:{id:true,marketplace:true,status:true}},
    }}}});
  const items=jobs.flatMap(job=>{
    const latest=job.item.publishJobs.find(other=>other.marketplace===job.marketplace);
    if(latest?.id!==job.id)return [];
    const listing=job.item.marketplaceListings.find(row=>row.marketplace===job.marketplace) ?? null;
    const needsVerification=listing?.status==='unknown';
    if(job.status==='cancelled'&&!needsVerification)return [];
    if(!needsVerification && (!READY_STATUSES.includes(job.item.status) || !applicableTo(job.item,job.marketplace) || publishBlockReason(listing)))return [];
    let validation:{field:string;message:string}[]|null=null;
    try { const value=job.validationJson?JSON.parse(job.validationJson):null;
      if(Array.isArray(value))validation=value.filter(issue=>issue && typeof issue.field==='string' && typeof issue.message==='string');
    } catch {}
    const problem={needsVerification,error:job.lastError,errorClass:job.errorClass,validation};
    return [{jobId:job.id,runId:job.runId,itemId:job.itemId,sku:job.item.sku,
      title:job.item.customTitle || [job.item.brand,job.item.itemType].filter(Boolean).join(' '),marketplace:job.marketplace,
      attemptCount:job.attemptCount,updatedAt:job.updatedAt,photo:job.item.photos[0] ?? null,
      verificationRevision:needsVerification ? publicationVerificationRevision(job,listing!) : null,
      canRetry:!needsVerification && READY_STATUSES.includes(job.item.status),...problem,guidance:recoveryGuidance(problem)}];
  });
  return {items,truncated:jobs.length>=5000};
}

/** Retry changes only eligible latest attempts. Verification, sold state,
 * explicit cancellation, and a newer attempt are never overridden. */
export async function retryFailedJobs(db:Pick<PrismaClient,'$transaction'>,runId:number,jobIds?:number[]) {
  if(!Number.isSafeInteger(runId)||runId<=0 || jobIds!==undefined && (!jobIds.length || jobIds.some(id=>!Number.isSafeInteger(id)||id<=0)))return {ok:false,retried:0,error:'Select valid failed listings to retry.'};
  return db.$transaction(async tx=>{
    const jobs=await tx.publishJob.findMany({where:{runId,status:{in:['failed','requires_review']},...(jobIds?{id:{in:jobIds}}:{})},include:{item:{select:{status:true,trueVintage:true}}}});
    const safe:number[]=[];const skipped:{jobId:number;reason:string}[]=[];
    for(const job of jobs) {
      const latest=await tx.publishJob.findFirst({where:{itemId:job.itemId,marketplace:job.marketplace},orderBy:{id:'desc'},select:{id:true}});
      const listing=await tx.marketplaceListing.findUnique({where:{itemId_marketplace:{itemId:job.itemId,marketplace:job.marketplace}}});
      const reason=latest?.id!==job.id?'A newer attempt already exists.':!READY_STATUSES.includes(job.item.status)?'This item is no longer approved for upload.':!applicableTo(job.item,job.marketplace)?'This marketplace does not apply to this item.':publishBlockReason(listing);
      if(reason)skipped.push({jobId:job.id,reason});else safe.push(job.id);
    }
    if(!safe.length)return {ok:false,retried:0,skipped,error:skipped[0]?.reason || 'No failed listings are ready to retry.'};
    const result=await tx.publishJob.updateMany({where:{id:{in:safe},item:{status:{in:READY_STATUSES}},status:{in:['failed','requires_review']}},
      data:{status:'queued',errorClass:null,lastError:null,validationJson:null,nextAttemptAt:null,finishedAt:null}});
    if(result.count)await tx.publishRun.update({where:{id:runId},data:{status:'running',finishedAt:null,note:null}});
    return {ok:true,retried:result.count,skipped};
  });
}
