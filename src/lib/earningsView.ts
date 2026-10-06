import type { EarningsPage, ShippingIncomeGaps } from './earningsPage.ts';
export type EarningsView=Pick<EarningsPage,'range'|'detail'|'estimates'|'platformEstimates'|'shippingIncomeGaps'|'totals'|'salesSeries'|'byPlatform'|'sellThrough'|'soldItems'|'returnCosts'|'lastSyncAt'|'lastSyncSummary'>;
export function earningsView(value:unknown):EarningsView {
  const d=value as EarningsView;
  const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value);
  const nullable=(value:unknown)=>value===null||finite(value);
  const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
  const numbers=(obj:unknown,keys:string[])=>!!obj&&keys.every(key=>finite((obj as Record<string,unknown>)[key]));
  const date=(value:unknown)=>value===null||typeof value==='string'&&Number.isFinite(Date.parse(value));
  const text=(value:unknown)=>value===null||typeof value==='string';
  const gaps=(value:ShippingIncomeGaps|undefined,max:number)=>!!value&&count(value.count)&&count(value.costedCount)&&value.costedCount<=value.count&&value.count<=max;
  if(!d||!d.range||!(d.range.days===null||count(d.range.days)&&d.range.days>0)||!date(d.range.from)
    ||!text(d.lastSyncAt)||!text(d.lastSyncSummary)
    ||!numbers(d.totals,['count','revenue','itemPriceTotal','shippingIncome','shippingProfit','fees','shipping','cogs','costMissingCount','netProfit','revenueAfterFees'])
    ||!count(d.totals.count)||!count(d.totals.costMissingCount)||d.totals.costMissingCount>d.totals.count||!nullable(d.totals.marginPct)
    ||!gaps(d.shippingIncomeGaps,d.totals.count)||d.shippingIncomeGaps.costedCount>d.totals.count-d.totals.costMissingCount
    ||!d.shippingIncomeGaps.byPlatform||typeof d.shippingIncomeGaps.byPlatform!=='object'||Array.isArray(d.shippingIncomeGaps.byPlatform)
    ||!d.detail||![d.detail.page,d.detail.pages,d.detail.pageSize,d.detail.total].every(count)||d.detail.page<1||d.detail.pageSize<1||d.detail.pageSize>100
    ||d.detail.pages!==Math.max(1,Math.ceil(d.detail.total/d.detail.pageSize))||d.detail.page>d.detail.pages||d.detail.total>d.totals.count||typeof d.detail.q!=='string'
    ||!d.estimates||[d.estimates.profit,d.estimates.fees,d.estimates.shipping].some(value=>typeof value!=='boolean')
    ||!numbers(d.returnCosts,['count','fees','postage','total'])||!count(d.returnCosts.count)
    ||!d.sellThrough||![d.sellThrough.listedCount,d.sellThrough.soldCount,d.sellThrough.openCount].every(count)
    ||!nullable(d.sellThrough.avgDaysToSell)||!nullable(d.sellThrough.sellThroughPct)||!Array.isArray(d.sellThrough.aged)
    ||d.sellThrough.aged.some(row=>!row||typeof row.sku!=='string'||!text(row.itemType)||!nullable(row.listedPrice)||!finite(row.daysListed))
    ||!d.salesSeries||!['day','week','month'].includes(d.salesSeries.bucket)||!Array.isArray(d.salesSeries.points)
    ||d.salesSeries.points.some(row=>!row||typeof row.date!=='string'||!count(row.count))
    ||!d.platformEstimates||typeof d.platformEstimates!=='object'||Array.isArray(d.platformEstimates)
    ||!Array.isArray(d.byPlatform)||d.byPlatform.some(row=>!row||typeof row.platform!=='string'||!count(row.count)
      ||!numbers(row,['revenue','fees','shippingIncome','shippingProfit'])||!nullable(row.netProfit)
      ||!gaps(d.shippingIncomeGaps.byPlatform[row.platform],row.count)
      ||!d.platformEstimates[row.platform]||[d.platformEstimates[row.platform].profit,d.platformEstimates[row.platform].fees,d.platformEstimates[row.platform].shipping].some(value=>typeof value!=='boolean'))
    ||Object.keys(d.shippingIncomeGaps.byPlatform).length!==d.byPlatform.length
    ||d.byPlatform.reduce((sum,row)=>sum+d.shippingIncomeGaps.byPlatform[row.platform].count,0)!==d.shippingIncomeGaps.count
    ||d.byPlatform.reduce((sum,row)=>sum+d.shippingIncomeGaps.byPlatform[row.platform].costedCount,0)!==d.shippingIncomeGaps.costedCount
    ||!Array.isArray(d.soldItems)||d.soldItems.length!==Math.min(d.detail.pageSize,Math.max(0,d.detail.total-(d.detail.page-1)*d.detail.pageSize))
    ||new Set(d.soldItems.map(row=>row?.id)).size!==d.soldItems.length
    ||d.soldItems.some(row=>!row||!Number.isSafeInteger(row.id)||row.id<1||typeof row.sku!=='string'||typeof row.platform!=='string'||row.status!=='Sold'
      ||typeof row.createdAt!=='string'||!date(row.createdAt)||!date(row.dateSold)||!text(row.itemType)
      ||!numbers(row,['itemPrice','shippingIncome','shippingProfit','revenue','fees','shipping','revenueAfterFees'])
      ||![row.itemCost,row.netProfit,row.marginPct].every(nullable)||[row.costMissing,row.feesEstimated,row.shippingEstimated,row.shippingIncomeMissing].some(value=>typeof value!=='boolean')))
    throw Error('Earnings information is incomplete. Refresh before relying on these figures.');
  return d;
}
