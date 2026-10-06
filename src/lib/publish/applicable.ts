import type { Prisma } from '@prisma/client';

/** Current Etsy resale workflow accepts reviewed vintage items. Other items
 * must not look unfinished forever merely because Etsy is selected. */
export function applicableTo(item:{trueVintage?:boolean|null},marketplace:string) {
  return marketplace!=='etsy' || item.trueVintage===true;
}

export function missingMarketplaceWhere(marketplaces:string[]):Prisma.ItemWhereInput {
  if(!marketplaces.length)return {id:{in:[]}};
  return {OR:marketplaces.map(marketplace=>({
    ...(marketplace==='etsy'?{trueVintage:true}:{}),
    marketplaceListings:{none:{marketplace,status:'published'}},
  }))};
}

/** Approved candidates still missing an applicable target; publishing rechecks details. */
export function readyMarketplaceCandidatesWhere(marketplaces:string[]):Prisma.ItemWhereInput {
  return {status:{in:['Ready','Ready for Nifty']},niftyStatus:{notIn:['Draft','Published','Uploading']},...missingMarketplaceWhere(marketplaces)};
}
