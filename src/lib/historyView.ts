import type {HistoryPage} from './pastUploads.ts';
export function historyView(input:unknown):HistoryPage {
  const value=input as HistoryPage;
  const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
  const text=(v:unknown)=>v===null||typeof v==='string';
  const money=(v:unknown)=>v===null||typeof v==='number'&&Number.isFinite(v);
  const date=(v:unknown)=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v));
  if(!value||![value.total,value.page,value.pages,value.pageSize,value.requestedPage].every(count)||value.page<1||value.requestedPage<1||value.pageSize<1||value.pageSize>100
    ||value.pages!==Math.max(1,Math.ceil(value.total/value.pageSize))||value.page!==Math.min(value.requestedPage,value.pages)
    ||!value.query||!['sales','history'].includes(value.query.view)||typeof value.query.q!=='string'||value.query.q.length>200
    ||!(value.query.view==='sales'?['all','shipping','shipped','attention']:['all','listed','sold','attention']).includes(value.query.filter)
    ||!value.counts||!count(value.counts.all)||!count(value.counts.shipping)||value.total>value.counts.all||value.counts.shipping>value.counts.all
    ||typeof value.truncated!=='boolean'||!Array.isArray(value.items)||value.items.length!==Math.min(value.pageSize,Math.max(0,value.total-(value.page-1)*value.pageSize))
    ||new Set(value.items.map(item=>item?.id)).size!==value.items.length
    ||value.items.some(item=>!item||!count(item.id)||item.id<1||typeof item.sku!=='string'||typeof item.title!=='string'||typeof item.status!=='string'||typeof item.displayStatus!=='string'
      ||typeof item.createdAt!=='string'||!date(item.createdAt)||typeof item.updatedAt!=='string'||!date(item.updatedAt)||![item.dateSold,item.shippedAt,item.lastUploadAt].every(date)
      ||!(item.manualSale===null||item.manualSale&&typeof item.manualSale.operationId==='string'&&typeof item.manualSale.reference==='string'&&['shipping','pickup'].includes(item.manualSale.fulfillment))
      ||![item.salePrice,item.shippingCharged].every(money)||![item.brand,item.itemType,item.color,item.size,item.removalSummary].every(text)
      ||typeof item.removalNeedsAttention!=='boolean'||!Array.isArray(item.soldPlatforms)||item.soldPlatforms.some(name=>typeof name!=='string')
      ||!Array.isArray(item.photos)||item.photos.length>1||item.photos.some(photo=>!photo||typeof photo.storedPath!=='string'||!text(photo.thumbPath)||typeof photo.isCover!=='boolean'||photo.isMarker!==false||!Number.isFinite(photo.rotation))
      ||!Array.isArray(item.marketplaceListings)||item.marketplaceListings.some(listing=>!listing||typeof listing.marketplace!=='string'||typeof listing.status!=='string'||!text(listing.externalUrl)||!date(listing.publishedAt)||!money(listing.price))
      ||value.query.view==='sales'&&item.status!=='Sold'||value.query.filter==='shipping'&&item.shippedAt!==null||value.query.filter==='shipped'&&item.shippedAt===null
      ||value.query.filter==='sold'&&item.status!=='Sold'||value.query.filter==='listed'&&item.displayStatus!=='Listed'||value.query.filter==='attention'&&!item.removalNeedsAttention))
    throw Error('History returned incomplete information. Refresh before changing shipping status.');
  return value;
}
