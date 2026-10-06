import type { PrismaClient } from '@prisma/client';
import { detectSubBrand,normalizeBrand,type NormalizedValue } from './normalize.ts';

export const BRAND_CLEANUP_PAGE_SIZE=100;
export interface BrandCleanupChange {
  id:number;createdAt:string;sku:string;status:string;from:string;to:string;fromSubBrand:string|null;toSubBrand:string|null;
}
export interface BrandSuggestion { id:number;sku:string;current:string;suggestion:string }
export interface BrandCleanupPlan {
  scanned:number;totalChanges:number;page:number;pages:number;pageSize:number;changes:BrandCleanupChange[];
  totalSuggestions:number;suggestionPage:number;suggestionPages:number;suggestions:BrandSuggestion[];
}
export interface BrandCleanupResult { ok:true;requested:number;applied:number;appliedIds:number[];skipped:{id:number;sku:string;reason:string}[] }
export class BrandCleanupInputError extends Error {}
interface BrandRow { id:number;createdAt:Date;sku:string;status:string;brand:string|null;subBrand:string|null }

function target(brand:string,subBrand:string|null,result=normalizeBrand(brand)):{brand:string;subBrand:string|null}|null {
  if(!brand||brand==='Unknown')return null;
  if(result.canonical&&result.value!==brand)return {brand:result.value,subBrand:subBrand||detectSubBrand(result.value,brand)||subBrand};
  if(!result.canonical&&result.suggestion)return null;
  return result.value!==brand?{brand:result.value,subBrand}:null;
}
function pageNumber(value:number){if(!Number.isSafeInteger(value)||value<1||value>1_000_000)throw new BrandCleanupInputError('Choose a valid cleanup preview page.');return value;}
export async function previewBrandCleanup(db:Pick<PrismaClient,'item'>,page=1,suggestionPage=1):Promise<BrandCleanupPlan>{
  pageNumber(page);pageNumber(suggestionPage);
  const rows:BrandRow[]=await db.item.findMany({where:{status:{notIn:['Sold','Archived']}},select:{id:true,createdAt:true,sku:true,status:true,brand:true,subBrand:true},orderBy:[{sku:'asc'},{id:'asc'}]});
  const changes:BrandCleanupChange[]=[],suggestions:BrandSuggestion[]=[],cache=new Map<string,NormalizedValue>();
  for(const row of rows){
    const brand=row.brand??'';if(!brand||brand==='Unknown')continue;
    let normalized=cache.get(brand);if(!normalized){normalized=normalizeBrand(brand);cache.set(brand,normalized);}
    const next=target(brand,row.subBrand,normalized);
    if(next)changes.push({id:row.id,createdAt:row.createdAt.toISOString(),sku:row.sku,status:row.status,from:brand,to:next.brand,fromSubBrand:row.subBrand,toSubBrand:next.subBrand});
    else if(!normalized.canonical&&normalized.suggestion)suggestions.push({id:row.id,sku:row.sku,current:brand,suggestion:normalized.suggestion});
  }
  const pages=Math.max(1,Math.ceil(changes.length/BRAND_CLEANUP_PAGE_SIZE)),suggestionPages=Math.max(1,Math.ceil(suggestions.length/BRAND_CLEANUP_PAGE_SIZE));
  page=Math.min(page,pages);suggestionPage=Math.min(suggestionPage,suggestionPages);
  return {scanned:rows.length,totalChanges:changes.length,page,pages,pageSize:BRAND_CLEANUP_PAGE_SIZE,changes:changes.slice((page-1)*BRAND_CLEANUP_PAGE_SIZE,page*BRAND_CLEANUP_PAGE_SIZE),
    totalSuggestions:suggestions.length,suggestionPage,suggestionPages,suggestions:suggestions.slice((suggestionPage-1)*BRAND_CLEANUP_PAGE_SIZE,suggestionPage*BRAND_CLEANUP_PAGE_SIZE)};
}

export function validateBrandChanges(value:unknown,allowEmpty=false):BrandCleanupChange[]{
  const fail=()=>{throw new BrandCleanupInputError('Send the exact reviewed brand changes. Refresh the preview before applying.');};
  if(!Array.isArray(value)||value.length>BRAND_CLEANUP_PAGE_SIZE||(!allowEmpty&&!value.length))return fail();
  const ids=new Set<number>();
  for(const raw of value){
    const row=raw as BrandCleanupChange;
    if(!row||!Number.isSafeInteger(row.id)||row.id<1||ids.has(row.id)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))
      ||[row.sku,row.status,row.from,row.to].some(value=>typeof value!=='string'||value.length>4096)
      ||!row.sku||!row.status||['Sold','Archived'].includes(row.status)
      ||[row.fromSubBrand,row.toSubBrand].some(value=>value!==null&&(typeof value!=='string'||value.length>4096)))return fail();
    const next=target(row.from,row.fromSubBrand);
    if(!next||next.brand!==row.to||next.subBrand!==row.toSubBrand)return fail();
    ids.add(row.id);
  }
  return value as BrandCleanupChange[];
}
export async function applyBrandCleanup(db:Pick<PrismaClient,'$transaction'>,input:unknown):Promise<BrandCleanupResult>{
  const changes=validateBrandChanges(input);
  return db.$transaction(async tx=>{
    const appliedIds:number[]=[],skipped:BrandCleanupResult['skipped']=[];
    for(const change of changes){
      const result=await tx.item.updateMany({where:{id:change.id,createdAt:new Date(change.createdAt),sku:change.sku,status:change.status,brand:change.from,subBrand:change.fromSubBrand},
        data:{brand:change.to,...(change.toSubBrand!==change.fromSubBrand?{subBrand:change.toSubBrand}:{})}});
      if(result.count===1)appliedIds.push(change.id);
      else skipped.push({id:change.id,sku:change.sku,reason:'The item changed, was removed, or is no longer in its previewed status.'});
    }
    return {ok:true,requested:changes.length,applied:appliedIds.length,appliedIds,skipped};
  });
}

export function validateBrandPreview(value:unknown):BrandCleanupPlan{
  const data=value as BrandCleanupPlan,count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
  if(!data||![data.scanned,data.totalChanges,data.page,data.pages,data.totalSuggestions,data.suggestionPage,data.suggestionPages].every(count)
    ||data.pageSize!==BRAND_CLEANUP_PAGE_SIZE||data.page<1||data.suggestionPage<1||data.page>data.pages||data.suggestionPage>data.suggestionPages
    ||data.pages!==Math.max(1,Math.ceil(data.totalChanges/BRAND_CLEANUP_PAGE_SIZE))||data.suggestionPages!==Math.max(1,Math.ceil(data.totalSuggestions/BRAND_CLEANUP_PAGE_SIZE))
    ||data.totalChanges+data.totalSuggestions>data.scanned||!Array.isArray(data.changes)||!Array.isArray(data.suggestions)
    ||data.changes.length!==Math.min(BRAND_CLEANUP_PAGE_SIZE,Math.max(0,data.totalChanges-(data.page-1)*BRAND_CLEANUP_PAGE_SIZE))
    ||data.suggestions.length!==Math.min(BRAND_CLEANUP_PAGE_SIZE,Math.max(0,data.totalSuggestions-(data.suggestionPage-1)*BRAND_CLEANUP_PAGE_SIZE))
    ||data.suggestions.some(row=>!row||!Number.isSafeInteger(row.id)||row.id<1||[row.sku,row.current,row.suggestion].some(value=>typeof value!=='string')))
    throw Error('The brand preview is incomplete. Check brand spellings again before applying.');
  validateBrandChanges(data.changes,true);return data;
}
export function validateBrandResult(value:unknown,changes:BrandCleanupChange[]):BrandCleanupResult{
  const result=value as BrandCleanupResult;
  if(!result||result.ok!==true||result.requested!==changes.length||!Array.isArray(result.appliedIds)||!Array.isArray(result.skipped)||result.applied!==result.appliedIds.length)
    throw Error('The cleanup result could not be confirmed. Check a fresh preview before trying again.');
  const remaining=new Set(changes.map(row=>row.id));
  for(const id of result.appliedIds){if(!remaining.delete(id))throw Error('The cleanup receipt does not match the reviewed items. Refresh the preview.');}
  for(const row of result.skipped){if(!row||!remaining.delete(row.id)||changes.find(change=>change.id===row.id)?.sku!==row.sku||typeof row.reason!=='string')throw Error('The skipped-item receipt is incomplete. Refresh the preview.');}
  if(remaining.size)throw Error('The cleanup receipt is missing reviewed items. Refresh the preview.');
  return result;
}
