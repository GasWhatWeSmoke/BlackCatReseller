import type {readPricingIndex,readPricingRows} from './pricingRead.ts';
type Index=Awaited<ReturnType<typeof readPricingIndex>>;type Rows=Awaited<ReturnType<typeof readPricingRows>>;
const identity=(row:unknown)=>{const value=row as Index['items'][number];return !!value&&Number.isSafeInteger(value.id)&&value.id>0&&typeof value.sku==='string'&&typeof value.createdAt==='string'&&Number.isFinite(Date.parse(value.createdAt));};
const idsMatch=(actual:unknown,expected:number[]|null)=>expected===null?actual===null:Array.isArray(actual)&&actual.length===expected.length&&actual.every((id,index)=>id===expected[index]);
const text=(value:unknown)=>value===null||typeof value==='string';
export function pricingIndexView(input:unknown,ids:number[]|null=null):Index {
  const data=input as Index;
  if(!data||!Array.isArray(data.items)||!Number.isSafeInteger(data.total)||data.total!==data.items.length||!idsMatch(data.requestedIds,ids)
    ||data.items.some(row=>!identity(row)||ids!==null&&!ids.includes(row.id))||new Set(data.items.map(row=>row.id)).size!==data.items.length)
    throw Error('The pricing queue could not be verified. Refresh before continuing.');
  return data;
}
export function pricingRowsView(input:unknown,ids:number[]):Rows {
  const data=input as Rows;
  if(!data||!idsMatch(data.requestedIds,ids)||!Array.isArray(data.items)||data.items.length>ids.length||new Set(data.items.map(row=>row?.id)).size!==data.items.length
    ||data.items.some(row=>!identity(row)||!ids.includes(row.id)||typeof row.status!=='string'||typeof row.niftyStatus!=='string'||typeof row.brand!=='string'
      ||![row.itemType,row.size,row.condition,row.color,row.style,row.fit].every(text)||!(row.listedPrice===null||typeof row.listedPrice==='number'&&Number.isFinite(row.listedPrice))
      ||!Array.isArray(row.photos)||row.photos.length>8||row.photos.some(photo=>!photo||!Number.isSafeInteger(photo.id)||typeof photo.storedPath!=='string'||!text(photo.thumbPath)||!Number.isFinite(photo.rotation)||!Number.isFinite(photo.sortOrder)||photo.isMarker!==false||typeof photo.isCover!=='boolean'||typeof photo.includeInListing!=='boolean')))
    throw Error('Pricing details are incomplete. Refresh before saving prices.');
  return data;
}
