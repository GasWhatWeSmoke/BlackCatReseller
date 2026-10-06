/** Presentation state is derived from the item and its marketplace records.
 * Older stored status values remain readable so existing history needs no migration. */
export function inventoryState(item: { status: string; marketplaceListings?: { status: string }[] }) {
  if (["Sold", "Archived", "Problem", "Removed"].includes(item.status)) return item.status;
  if (item.marketplaceListings?.some(row => row.status === "published")) return "Listed";
  if (["Ready", "Ready for Nifty"].includes(item.status)) return "Ready";
  if (item.status === "Uploaded to Nifty") return "Previously listed";
  if (["Photographed", "Needs Info"].includes(item.status)) return "Needs review";
  return item.status;
}

export const READY_STATUSES = ["Ready", "Ready for Nifty"];
export const REVIEW_STATUSES = ["Photographed", "Needs Info"];

export function inventoryStateFilter(state:string): import('@prisma/client').Prisma.ItemWhereInput {
  if(state==='Listed')return {status:{notIn:['Sold','Archived','Problem','Removed']},marketplaceListings:{some:{status:'published'}}};
  if(state==='Ready')return {status:{in:READY_STATUSES},marketplaceListings:{none:{status:'published'}}};
  if(state==='Needs review')return {status:{in:REVIEW_STATUSES},marketplaceListings:{none:{status:'published'}}};
  if(state==='Previously listed')return {status:'Uploaded to Nifty',marketplaceListings:{none:{status:'published'}}};
  return state ? {status:state} : {};
}
