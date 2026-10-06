import type { Prisma,PrismaClient } from '@prisma/client';
import { buildEarningsReport,type EarningsReport,type FeeModel,type ShippingModel } from './earnings.ts';
import { applyReturnCosts } from './returnCosts.ts';
import { ORDER_REVIEW_FIELD } from './publish/orderReviews.ts';

export interface EarningsQuery { days:number|null; page:number; pageSize:number; q:string }
export interface EarningsEstimates {profit:boolean;fees:boolean;shipping:boolean}
export interface ShippingIncomeGaps { count:number; costedCount:number }
export interface EarningsPage extends Omit<ReturnType<typeof applyReturnCosts>,'soldItems'> {
  range:{days:number|null;from:string|null};
  detail:{page:number;pages:number;pageSize:number;total:number;q:string};
  estimates:EarningsEstimates;
  platformEstimates:Record<string,EarningsEstimates>;
  shippingIncomeGaps:ShippingIncomeGaps & {byPlatform:Record<string,ShippingIncomeGaps>};
  soldItems:(EarningsReport['soldItems'][number]&{createdAt:string;status:string;shippingIncomeMissing:boolean})[];
  lastSyncAt:string|null;lastSyncSummary:string|null;
}
export function parseEarningsQuery(params:URLSearchParams):EarningsQuery {
  const positive=(value:string|null,fallback:number,max:number)=>{
    if(value===null||value==='')return fallback;
    const number=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(number)||number<1||number>max)throw Error('Choose a valid earnings range and page.');
    return number;
  };
  const days=params.get('days'),q=(params.get('q')||'').trim();
  if(q.length>32)throw Error('Use a sold SKU of at most 32 characters.');
  return {days:days==='all'?null:positive(days,90,3650),page:positive(params.get('page'),1,1_000_000),pageSize:positive(params.get('pageSize'),50,100),q};
}
const SOLD_SELECT={id:true,sku:true,itemType:true,dateSold:true,createdAt:true,status:true,salePrice:true,platformSold:true,weightOz:true,
  itemCost:true,marketplaceFees:true,feesEstimated:true,shippingCost:true,shippingEstimated:true,shippingCharged:true} satisfies Prisma.ItemSelect;

export async function readEarningsPage(db:Pick<PrismaClient,'$transaction'>,
  settings:{feeModel:FeeModel;shippingModel:ShippingModel;lastSyncAt?:string|null;lastSyncSummary?:string|null},
  query:EarningsQuery,now=new Date()):Promise<EarningsPage> {
  query=parseEarningsQuery(new URLSearchParams({days:query.days===null?'all':String(query.days),page:String(query.page),pageSize:String(query.pageSize),q:query.q}));
  const from=query.days===null?null:new Date(now.getTime()-query.days*86400000);
  return db.$transaction(async tx=>{
    const [soldRows,timing,open,listedCount,returns]=await Promise.all([
      tx.item.findMany({where:{status:'Sold',salePrice:{not:null},...(from?{dateSold:{gte:from}}:{})},orderBy:[{dateSold:'desc'},{id:'desc'}],select:SOLD_SELECT}),
      tx.item.findMany({where:{status:'Sold'},select:{dateSold:true,dateListed:true,createdAt:true}}),
      tx.item.findMany({where:{status:{notIn:['Sold','Archived','Removed']},marketplaceListings:{some:{status:'published'}}},
        select:{sku:true,itemType:true,listedPrice:true,dateListed:true,createdAt:true},orderBy:{createdAt:'asc'}}),
      tx.item.count({where:{OR:[{status:'Sold'},{lastUploadAt:{not:null}},{marketplaceListings:{some:{}}}]}}),
      tx.syncLog.findMany({where:{field:ORDER_REVIEW_FIELD,action:'returned'},select:{newValue:true}}),
    ]);
    const source=buildEarningsReport(soldRows,timing,open,listedCount,settings.feeModel,settings.shippingModel,now.getTime(),from?.getTime()??null);
    // Return-cost margins need all costed sales, never just the visible detail page.
    const report=applyReturnCosts(source,returns,from?.getTime()??null,now.getTime());
    const estimates={profit:report.soldItems.some(row=>!row.costMissing&&(row.feesEstimated||row.shippingEstimated)),
      fees:report.soldItems.some(row=>row.feesEstimated),shipping:report.soldItems.some(row=>row.shippingEstimated)};
    const platformEstimates=Object.fromEntries(report.byPlatform.map(row=>[row.platform,{profit:false,fees:false,shipping:false}]));
    for(const row of report.soldItems){const flags=platformEstimates[row.platform||'Unknown'];flags.fees ||= row.feesEstimated;flags.shipping ||= row.shippingEstimated;flags.profit ||= !row.costMissing&&(row.feesEstimated||row.shippingEstimated);}
    const rows=query.q?report.soldItems.filter(row=>row.sku.toLowerCase().includes(query.q.toLowerCase())):report.soldItems;
    const total=rows.length,pages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,pages);
    const shippingIncomeGaps={count:0,costedCount:0,byPlatform:Object.fromEntries(report.byPlatform.map(row=>[row.platform,{count:0,costedCount:0}]))};
    for(const row of soldRows){
      if(row.shippingCharged!=null)continue;
      shippingIncomeGaps.count++;
      const platform=shippingIncomeGaps.byPlatform[row.platformSold||'Unknown'];platform.count++;
      if(row.itemCost!=null){shippingIncomeGaps.costedCount++;platform.costedCount++;}
    }
    const identity=new Map(soldRows.map(row=>[row.id,{createdAt:row.createdAt.toISOString(),status:row.status,shippingIncomeMissing:row.shippingCharged==null}]));
    return {...report,range:{days:query.days,from:from?.toISOString()??null},detail:{page,pages,pageSize:query.pageSize,total,q:query.q},estimates,platformEstimates,shippingIncomeGaps,
      soldItems:rows.slice((page-1)*query.pageSize,page*query.pageSize).map(row=>({...row,...identity.get(row.id)!})),
      lastSyncAt:settings.lastSyncAt??null,lastSyncSummary:settings.lastSyncSummary??null};
  });
}
