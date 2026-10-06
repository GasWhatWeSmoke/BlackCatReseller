import fs from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import type { AppSettingsData } from './types.ts';
import { computeEarnings,summarizeEarnings,buildEarningsReport } from './earnings.ts';
import { dashboardSales } from './dashboardSales.ts';
import { applyReturnCosts } from './returnCosts.ts';
import { activeProblemsWhere } from './problemMeta.ts';
import { readAutoRun,AUTO_MARKETPLACES } from './publish/autoRun.ts';
import { readyMarketplaceCandidatesWhere } from './publish/applicable.ts';
import { soldListingsNeedingRemovalWhere } from './publish/saleProtection.ts';
import { ORDER_REVIEW_FIELD,orderReviewData } from './publish/orderReviews.ts';

type SettingsRead={ok:boolean;source:'configured'|'defaults'|'fallback';error?:'settings_malformed';settings:Pick<AppSettingsData,'incomingPath'|'feeModel'|'shippingModel'|'publish'>};
type QueueCounts={needsReview:number;unpriced:number;readyToUpload:number|null;openProblems:number;pendingCollisions:number;soldToShip:number;pendingRemovals:number};
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value);
const object=(value:unknown)=>!!value&&typeof value==='object'&&!Array.isArray(value);
function usableSettings(read:SettingsRead){
  const s=read.settings,auto=s?.publish?.autoRun;
  return read.ok&&s&&typeof s.incomingPath==='string'&&!!s.incomingPath.trim()
    &&object(s.feeModel)&&Object.values(s.feeModel).every(fee=>fee&&finite(fee.feePercent)&&finite(fee.fixedFee))
    &&s.shippingModel&&finite(s.shippingModel.default)&&Array.isArray(s.shippingModel.tiers)&&s.shippingModel.tiers.every(tier=>tier&&finite(tier.maxOz)&&finite(tier.cost))
    &&(s.publish===undefined||object(s.publish))
    &&(auto===undefined||object(auto)&&typeof auto.enabled==='boolean'&&Array.isArray(auto.marketplaces)&&auto.marketplaces.every(name=>AUTO_MARKETPLACES.includes(name as typeof AUTO_MARKETPLACES[number])));
}

async function incomingPhotos(folder:string){
  try {const entries=await fs.readdir(folder,{withFileTypes:true});return {ok:true as const,count:entries.filter(entry=>entry.isFile()&&/\.jpe?g$/i.test(entry.name)).length};}
  catch {return {ok:false as const,count:null,error:'incoming_folder_unavailable'};}
}
function topActions(queues:QueueCounts,incoming:number|null){
  const actions=[
    {id:'check-sold-listing-removals',count:queues.pendingRemovals,reason:'Sold items have other listings awaiting verified removal. Check their outcomes to prevent duplicate sales.'},
    {id:'ship-sold-items',count:queues.soldToShip,reason:'Sold items await shipping or pickup handover. Review their order status and fulfillment queue.'},
    {id:'resolve-collisions',count:queues.pendingCollisions,reason:'Pending SKU collisions need resolution before the affected inventory can advance.'},
    {id:'resolve-open-problems',count:queues.openProblems,reason:'Active inventory problems need review before adding more work.'},
    {id:'process-incoming-photos',count:incoming??0,reason:'Imported photos are waiting to be processed into inventory records.'},
    {id:'review-inventory',count:queues.needsReview,reason:'Photographed items need individual review before approval.'},
    {id:'price-inventory',count:queues.unpriced,reason:'Items need a reviewed price before crosslisting.'},
    {id:'upload-ready-items',count:queues.readyToUpload??0,reason:'Approved candidates still need listings on selected marketplaces. Review the crosslisting preflight warnings.'},
  ];
  return actions.filter(action=>action.count>0).slice(0,5);
}

export function unavailablePortfolioSnapshot(now=new Date()){
  return {schemaVersion:1 as const,generatedAt:now.toISOString(),sourceHealth:{ok:false,errors:['database_unavailable'],components:{database:{ok:false,error:'database_unavailable'},incomingPhotos:{ok:false,error:'not_checked'}}},
    inventory:{totalItems:null,byStatus:null,byNiftyStatus:null,byListingStatus:null,incomingPhotoCount:null},
    queues:{needsReview:null,unpriced:null,readyToUpload:null,openProblems:null,pendingCollisions:null,soldToShip:null,pendingRemovals:null},
    queueScope:{marketplaces:null,requiresPreflight:true},
    cashflow:{soldCount:null,revenue:null,knownRevenue:null,netProfit:null,costMissingCount:null,salePriceMissingCount:null,shippingIncomeMissingCount:null,feesEstimatedCount:null,shippingEstimatedCount:null,profitEstimated:null,returnCosts:null,returnCostMissingCount:null},
    recentBatches:null,topActions:null,dataGaps:['portfolio_snapshot_unavailable','unphotographed_inventory_unknown']};
}

/** Aggregate-only read model for the existing Hermes snapshot. No automation is started. */
export async function readPortfolioSnapshot(db:Pick<PrismaClient,'$transaction'>,read:SettingsRead,now=new Date()){
  const settings=read.settings,settingsOk=!!usableSettings(read),platforms=settingsOk?readAutoRun(settings.publish?.autoRun).marketplaces:null;
  const incomingPromise=settingsOk?incomingPhotos(settings.incomingPath):Promise.resolve({ok:false as const,count:null,error:'settings_unavailable'});
  const [rows,photos]=await Promise.all([db.$transaction(async tx=>{
    const [status,legacy,listings,needsReview,unpriced,readyToUpload,openProblems,pendingCollisions,soldToShip,sold,batches,returns,pendingRemovals]=await Promise.all([
      tx.item.groupBy({by:['status'],orderBy:{status:'asc'},_count:{_all:true}}),
      tx.item.groupBy({by:['niftyStatus'],orderBy:{niftyStatus:'asc'},_count:{_all:true}}),
      tx.marketplaceListing.groupBy({by:['status'],orderBy:{status:'asc'},_count:{_all:true}}),
      tx.item.count({where:{status:{in:['Photographed','Needs Info']}}}),
      tx.item.count({where:{status:{in:['Photographed','Needs Info','Ready','Ready for Nifty']},niftyStatus:'Not Uploaded',OR:[{listedPrice:null},{listedPrice:{lte:0}}]}}),
      platforms===null?Promise.resolve(null):tx.item.count({where:readyMarketplaceCandidatesWhere(platforms)}),
      tx.problemLog.count({where:activeProblemsWhere}),tx.collision.count({where:{status:'pending'}}),
      tx.item.count({where:{status:'Sold',shippedAt:null}}),
      tx.item.findMany({where:{status:'Sold'},select:{salePrice:true,platformSold:true,weightOz:true,itemCost:true,marketplaceFees:true,feesEstimated:true,shippingCost:true,shippingEstimated:true,shippingCharged:true}}),
      tx.batch.findMany({orderBy:[{startedAt:'desc'},{id:'desc'}],take:5,select:{id:true,startedAt:true,finishedAt:true,itemsCreated:true,photosProcessed:true,duplicatesSkipped:true,problems:true,collisions:true,durationMs:true}}),
      tx.syncLog.findMany({where:{field:ORDER_REVIEW_FIELD,action:'returned'},select:{newValue:true}}),
      tx.marketplaceListing.count({where:soldListingsNeedingRemovalWhere}),
    ]);
    return {status,legacy,listings,needsReview,unpriced,readyToUpload,openProblems,pendingCollisions,soldToShip,sold,batches,returns,pendingRemovals};
  }),incomingPromise]);
  const byStatus=Object.fromEntries(rows.status.map(row=>[row.status,row._count._all]));
  const queues:QueueCounts={needsReview:rows.needsReview,unpriced:rows.unpriced,readyToUpload:rows.readyToUpload,openProblems:rows.openProblems,pendingCollisions:rows.pendingCollisions,soldToShip:rows.soldToShip,pendingRemovals:rows.pendingRemovals};
  const income=dashboardSales(rows.sold),costMissingCount=rows.sold.filter(row=>row.itemCost==null).length;
  const storedMoneyOk=rows.sold.every(row=>[row.salePrice,row.shippingCharged,row.itemCost,row.marketplaceFees,row.shippingCost].every(value=>value===null||finite(value)));
  const calculations=settingsOk&&storedMoneyOk?rows.sold.map(row=>computeEarnings(row,settings.feeModel,settings.shippingModel)).filter(row=>row!==null):[];
  const totals=summarizeEarnings(calculations);
  // Reuse the exact recorded-return policy without computing unused per-item charts.
  const returnCosts=applyReturnCosts(buildEarningsReport([],[],[],0,{}, {tiers:[],default:0},now.getTime()),rows.returns,null,now.getTime()).returnCosts;
  const returnCostMissingCount=rows.returns.filter(entry=>{
    const value=orderReviewData(entry.newValue),at=value?.resolvedAt?Date.parse(value.resolvedAt):NaN;
    if(value&&Number.isFinite(at)&&at>now.getTime())return false;
    return !value||!Number.isFinite(at)||![value.feeLoss,value.postageLoss].every(amount=>finite(amount)&&Number(amount)>=0);
  }).length;
  const incomeOk=finite(income.totalEarned),financialsOk=storedMoneyOk&&incomeOk&&[totals.netProfit,returnCosts.total].every(finite);
  const completeRevenue=income.missingSalePrices===0&&income.missingShipping===0&&incomeOk;
  const completeProfit=completeRevenue&&costMissingCount===0&&settingsOk&&financialsOk&&returnCostMissingCount===0;
  const feesEstimatedCount=settingsOk&&storedMoneyOk?calculations.filter(row=>row.feesEstimated).length:null,shippingEstimatedCount=settingsOk&&storedMoneyOk?calculations.filter(row=>row.shippingEstimated).length:null;
  const dataGaps=['unphotographed_inventory_unknown','legacy_status_counts_historical_only','ready_candidates_require_preflight'];
  if(costMissingCount)dataGaps.push('sold_cost_basis_missing');if(income.missingSalePrices)dataGaps.push('sold_sale_price_missing');if(income.missingShipping)dataGaps.push('sold_shipping_income_missing');
  if(feesEstimatedCount)dataGaps.push('fees_estimated');if(shippingEstimatedCount)dataGaps.push('shipping_costs_estimated');
  if(returnCostMissingCount)dataGaps.push('return_cost_details_missing');
  if(!photos.ok)dataGaps.push('incoming_photo_count_unavailable');if(!settingsOk)dataGaps.push('settings_unavailable');if(!financialsOk)dataGaps.push('financial_values_invalid');
  const errors:string[]=[];if(!settingsOk)errors.push(read.error??'settings_malformed');if(!photos.ok)errors.push(photos.error);if(!financialsOk)errors.push('financial_values_invalid');
  return {schemaVersion:1 as const,generatedAt:now.toISOString(),sourceHealth:{ok:settingsOk&&photos.ok&&financialsOk,errors,components:{database:{ok:true},settings:settingsOk?{ok:true,source:read.source}:{ok:false,error:read.error??'settings_malformed'},incomingPhotos:photos.ok?{ok:true}:{ok:false,error:photos.error}}},
    inventory:{totalItems:Object.values(byStatus).reduce((sum,count)=>sum+count,0),byStatus,
      // Retained for version-one consumers; never used to recommend legacy automation.
      byNiftyStatus:Object.fromEntries(rows.legacy.map(row=>[row.niftyStatus,row._count._all])),
      byListingStatus:Object.fromEntries(rows.listings.map(row=>[row.status,row._count._all])),incomingPhotoCount:photos.count},
    queues,queueScope:{marketplaces:platforms,requiresPreflight:true},
    cashflow:{soldCount:rows.sold.length,revenue:completeRevenue?income.totalEarned:null,knownRevenue:incomeOk?income.totalEarned:null,
      netProfit:completeProfit?Math.round((totals.netProfit-returnCosts.total)*100)/100:null,costMissingCount,salePriceMissingCount:income.missingSalePrices,shippingIncomeMissingCount:income.missingShipping,
      feesEstimatedCount,shippingEstimatedCount,profitEstimated:completeProfit?!!(feesEstimatedCount||shippingEstimatedCount):null,returnCosts,returnCostMissingCount},
    recentBatches:rows.batches.map(batch=>({...batch,startedAt:batch.startedAt.toISOString(),finishedAt:batch.finishedAt?.toISOString()??null})),
    topActions:topActions(queues,photos.count),dataGaps};
}
