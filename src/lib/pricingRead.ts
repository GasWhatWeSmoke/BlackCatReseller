import type {Prisma,PrismaClient} from '@prisma/client';
export const unpricedWhere={status:{in:['Photographed','Needs Info','Ready','Ready for Nifty']},niftyStatus:'Not Uploaded',OR:[{listedPrice:null},{listedPrice:{lte:0}}]} satisfies Prisma.ItemWhereInput;
export function pricingIds(value:string|null){
  if(value===null)return null;
  const parts=value.split(',');if(!parts.length||parts.length>100||parts.some(part=>!(/^[1-9]\d*$/).test(part)||!Number.isSafeInteger(Number(part))))throw Error('Choose at most 100 valid pricing items.');
  return [...new Set(parts.map(Number))];
}
const ROW_SELECT={id:true,createdAt:true,sku:true,status:true,niftyStatus:true,brand:true,itemType:true,size:true,condition:true,color:true,style:true,fit:true,listedPrice:true,
  photos:{where:{isMarker:false},orderBy:[{isCover:'desc'},{sortOrder:'asc'},{id:'asc'}],take:8,select:{id:true,storedPath:true,thumbPath:true,rotation:true,isCover:true,isMarker:true,includeInListing:true,sortOrder:true}}} satisfies Prisma.ItemSelect;
export async function readPricingIndex(db:Pick<PrismaClient,'item'>,ids:number[]|null=null){
  if(ids!==null)ids=pricingIds(ids.join(','));
  const rows=await db.item.findMany({where:ids===null?unpricedWhere:{id:{in:ids}},orderBy:[{sku:'asc'},{id:'asc'}],select:{id:true,sku:true,createdAt:true}});
  return {items:rows.map(row=>({...row,createdAt:row.createdAt.toISOString()})),total:rows.length,requestedIds:ids};
}
export async function readPricingRows(db:Pick<PrismaClient,'$transaction'>,ids:number[]){
  const requestedIds=pricingIds(ids.join(','))!;
  const rows=await db.$transaction(tx=>tx.item.findMany({where:{id:{in:requestedIds}},orderBy:[{sku:'asc'},{id:'asc'}],select:ROW_SELECT}));
  return {items:rows.map(row=>({...row,createdAt:row.createdAt.toISOString()})),requestedIds};
}
export type PricingIndex=Awaited<ReturnType<typeof readPricingIndex>>['items'][number];
export type PricingRow=Awaited<ReturnType<typeof readPricingRows>>['items'][number];
