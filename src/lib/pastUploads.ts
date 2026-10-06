import type { Prisma, PrismaClient } from "@prisma/client";
import { MARKETPLACE_NAMES } from "./publish/platforms.ts";
import { inventoryState } from "./inventoryState.ts";
import { currentManualSale, MANUAL_SALE_FIELD, type ManualSaleInfo } from './manualSale.ts';

export const uploadHistoryWhere = {
  OR: [
    { status: "Sold" },
    { niftyStatus: { in: ["Published", "Draft"] } },
    { lastUploadAt: { not: null } },
    { marketplaceListings: { some: { status: { not: "not_published" } } } },
  ],
} satisfies Prisma.ItemWhereInput;

const marketName = (value: string) => MARKETPLACE_NAMES[value as keyof typeof MARKETPLACE_NAMES] ?? value;

export function saleDateLabel(value: string, locale?: string, timeZone?: string) {
  // Browser receipts that supply only a calendar date are stored at UTC
  // midnight. Display that date without shifting it to the preceding US day.
  const dateOnly = /T00:00:00(?:\.000)?Z$/.test(value);
  return new Date(value).toLocaleDateString(locale, { timeZone: dateOnly ? "UTC" : timeZone });
}

export function uploadHistorySummary(item: {
  status: string; niftyStatus: string; platformSold: string | null;
  marketplaceListings: { marketplace: string; status: string }[];
}) {
  const listings = item.marketplaceListings;
  const legacy = listings.every(row => ["ended", "not_published"].includes(row.status)) && ["Published", "Draft"].includes(item.niftyStatus);
  const soldPlatforms = [...new Set([
    ...(item.platformSold?.trim() ? [marketName(item.platformSold.trim().toLowerCase())] : []),
    ...listings.filter(row => row.status === "sold").map(row => marketName(row.marketplace)),
  ])];
  const other = listings.filter(row => row.status !== "sold" && row.status !== "not_published");
  const outstanding = other.filter(row => row.status !== "ended");
  return {
    legacy,
    soldPlatforms,
    removalSummary: item.status !== "Sold" ? null : legacy ? "Imported sale history" : !listings.length
      ? ["Published", "Draft"].includes(item.niftyStatus) ? "Imported sale history" : "Other listings not linked"
      : outstanding.length
        ? `Removal needs attention: ${outstanding.map(row => marketName(row.marketplace)).join(", ")}`
        : other.length ? `${other.length} other listing${other.length === 1 ? "" : "s"} removed`
          : "No other linked listings",
    removalNeedsAttention: item.status === "Sold" && outstanding.length > 0,
  };
}

export type HistoryFilter='all'|'shipping'|'shipped'|'listed'|'sold'|'attention';
export interface HistoryQuery {view:'sales'|'history';filter:HistoryFilter;q:string;page:number;pageSize:number}
export function parseHistoryQuery(params:URLSearchParams):HistoryQuery {
  const view=params.get('view')??'history',filter=params.get('filter')??'all',q=(params.get('q')??'').trim();
  const number=(key:string,fallback:number,max:number)=>{const raw=params.get(key);if(raw===null)return fallback;const value=Number(raw);if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(value)||value>max)throw Error('Choose a valid history page.');return value;};
  if(!['sales','history'].includes(view)||!(view==='sales'?['all','shipping','shipped','attention']:['all','listed','sold','attention']).includes(filter)||q.length>200)throw Error('Choose a valid history search and filter.');
  return {view:view as HistoryQuery['view'],filter:filter as HistoryFilter,q,page:number('page',1,1_000_000),pageSize:number('pageSize',50,100)};
}
const HISTORY_SELECT={id:true,createdAt:true,updatedAt:true,sku:true,status:true,niftyStatus:true,platformSold:true,salePrice:true,shippingCharged:true,
  dateSold:true,shippedAt:true,lastUploadAt:true,brand:true,itemType:true,color:true,size:true,finalTitle:true,niftyTitle:true,customTitle:true,
  photos:{where:{isMarker:false},orderBy:[{isCover:'desc'},{sortOrder:'asc'},{id:'asc'}],take:1,select:{storedPath:true,thumbPath:true,isCover:true,isMarker:true,rotation:true}},
  marketplaceListings:{orderBy:{id:'asc'},select:{marketplace:true,status:true,externalUrl:true,publishedAt:true,title:true,price:true}}} satisfies Prisma.ItemSelect;
type HistoryRow=Prisma.ItemGetPayload<{select:typeof HISTORY_SELECT}>;
const SEARCH_SELECT={id:true,sku:true,finalTitle:true,niftyTitle:true,customTitle:true,brand:true,itemType:true,color:true,size:true,platformSold:true,
  marketplaceListings:{select:{title:true,marketplace:true,status:true}}} satisfies Prisma.ItemSelect;
const SALE_ORDER:Prisma.ItemOrderByWithRelationInput[]=[{dateSold:{sort:'desc',nulls:'last'}},{updatedAt:'desc'},{id:'desc'}];
const HISTORY_ORDER:Prisma.ItemOrderByWithRelationInput[]=[{updatedAt:'desc'},{id:'desc'}];
export function historyWhere(query:HistoryQuery):Prisma.ItemWhereInput {
  const parts:Prisma.ItemWhereInput[]=[query.view==='sales'?{status:'Sold'}:uploadHistoryWhere];
  if(query.filter==='shipping')parts.push({shippedAt:null});
  if(query.filter==='shipped')parts.push({shippedAt:{not:null}});
  if(query.filter==='sold')parts.push({status:'Sold'});
  if(query.filter==='listed')parts.push({OR:[{status:'Listed'},{status:{notIn:['Sold','Archived','Problem','Removed']},marketplaceListings:{some:{status:'published'}}}]});
  if(query.filter==='attention')parts.push({status:'Sold',marketplaceListings:{some:{status:{notIn:['sold','ended','not_published']}}}});
  return {AND:parts};
}
function historyItem(row:HistoryRow, manualSale:ManualSaleInfo|null){
  const {finalTitle,niftyTitle,customTitle,...item}=row;
  return {...item,...uploadHistorySummary(row),manualSale,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),dateSold:row.dateSold?.toISOString()??null,
    shippedAt:row.shippedAt?.toISOString()??null,lastUploadAt:row.lastUploadAt?.toISOString()??null,
    marketplaceListings:row.marketplaceListings.map(listing=>({...listing,publishedAt:listing.publishedAt?.toISOString()??null})),
    displayStatus:inventoryState(row),title:row.marketplaceListings.find(listing=>listing.status==='published')?.title||finalTitle||niftyTitle||customTitle||[row.brand,row.itemType,row.color,row.size].filter(Boolean).join(' ')};
}
async function historyItems(tx:Prisma.TransactionClient, rows:HistoryRow[]) {
  const logs=await tx.syncLog.findMany({where:{itemId:{in:rows.filter(row=>row.status==='Sold').map(row=>row.id)},field:{in:[MANUAL_SALE_FIELD,'order_review']}},
    select:{id:true,itemId:true,field:true,action:true,newValue:true},orderBy:{id:'desc'}});
  return rows.map(row=>historyItem(row,currentManualSale(row,logs)));
}
export async function loadUploadHistory(db:Pick<PrismaClient,'$transaction'>,input:HistoryQuery=parseHistoryQuery(new URLSearchParams())){
  const query=parseHistoryQuery(new URLSearchParams(Object.entries(input).map(([key,value])=>[key,String(value)])));
  const where=historyWhere(query),base=query.view==='sales'?{status:'Sold'}:uploadHistoryWhere;
  return db.$transaction(async tx=>{
    if(query.q){
      // A lean search projection preserves literal %/_ and Unicode case folding.
      // Only the matching page loads full row details and its thumbnail relation.
      const [all,shipping,candidates]=await Promise.all([
        tx.item.count({where:base}),tx.item.count({where:{AND:[base,{status:'Sold',shippedAt:null}]}}),
        query.view==='sales'?Promise.all([
          tx.item.findMany({where:{AND:[where,{shippedAt:null}]},orderBy:SALE_ORDER,select:SEARCH_SELECT}),
          tx.item.findMany({where:{AND:[where,{shippedAt:{not:null}}]},orderBy:SALE_ORDER,select:SEARCH_SELECT}),
        ]).then(groups=>groups.flat()):tx.item.findMany({where,orderBy:HISTORY_ORDER,select:SEARCH_SELECT}),
      ]);
      const terms=query.q.toLowerCase().split(/\s+/).filter(Boolean);
      const matching=candidates.filter(item=>{
        const text=[item.sku,item.finalTitle,item.niftyTitle,item.customTitle,item.brand,item.itemType,item.color,item.size,item.platformSold,
          ...item.marketplaceListings.flatMap(listing=>[listing.title,...(query.view==='history'||listing.status==='sold'?[marketName(listing.marketplace)]:[])])].filter(Boolean).join(' ').toLowerCase();
        return terms.every(term=>text.includes(term));
      });
      const total=matching.length,pages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,pages),ids=matching.slice((page-1)*query.pageSize,page*query.pageSize).map(item=>item.id);
      const found=await tx.item.findMany({where:{id:{in:ids}},select:HISTORY_SELECT}),byId=new Map(found.map(item=>[item.id,item]));
      return {items:await historyItems(tx,ids.map(id=>byId.get(id)!)),truncated:total>ids.length,total,page,pages,pageSize:query.pageSize,requestedPage:query.page,
        query:{view:query.view,filter:query.filter,q:query.q},counts:{all,shipping}};
    }
    const [total,all,shipping]=await Promise.all([tx.item.count({where}),tx.item.count({where:base}),tx.item.count({where:{AND:[base,{status:'Sold',shippedAt:null}]}})]);
    const pages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,pages),offset=(page-1)*query.pageSize;
    const rows:HistoryRow[]=[];
    if(query.view==='sales'){
      const pending=await tx.item.count({where:{AND:[where,{shippedAt:null}]}});
      if(offset<pending)rows.push(...await tx.item.findMany({where:{AND:[where,{shippedAt:null}]},skip:offset,take:Math.min(query.pageSize,pending-offset),
        orderBy:SALE_ORDER,select:HISTORY_SELECT}));
      if(rows.length<query.pageSize)rows.push(...await tx.item.findMany({where:{AND:[where,{shippedAt:{not:null}}]},skip:Math.max(0,offset-pending),take:query.pageSize-rows.length,
        orderBy:SALE_ORDER,select:HISTORY_SELECT}));
    }else rows.push(...await tx.item.findMany({where,skip:offset,take:query.pageSize,orderBy:HISTORY_ORDER,select:HISTORY_SELECT}));
    return {items:await historyItems(tx,rows),truncated:total>rows.length,total,page,pages,pageSize:query.pageSize,requestedPage:query.page,
      query:{view:query.view,filter:query.filter,q:query.q},counts:{all,shipping}};
  });
}
export type HistoryPage=Awaited<ReturnType<typeof loadUploadHistory>>;
export type HistoryItem=HistoryPage['items'][number];
