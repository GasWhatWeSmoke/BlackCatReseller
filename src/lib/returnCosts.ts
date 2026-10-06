import type { EarningsReport } from "./earnings.ts";
import { orderReviewData } from "./publish/orderReviews.ts";
import { MARKETPLACE_NAMES } from "./publish/platforms.ts";
const round = (value:number) => Math.round(value*100)/100;
export function applyReturnCosts(report:EarningsReport, entries:{newValue:string|null}[], from:number|null, now:number){
  const result=structuredClone(report);
  let fees=0,postage=0,count=0;
  for(const entry of entries){
    const data=orderReviewData(entry.newValue),at=data?.resolvedAt?Date.parse(data.resolvedAt):NaN;
    if(!data||!Number.isFinite(at)||at>now||(from!==null&&at<from))continue;
    const fee=typeof data.feeLoss==='number'&&Number.isFinite(data.feeLoss)&&data.feeLoss>=0?data.feeLoss:0;
    const shipping=typeof data.postageLoss==='number'&&Number.isFinite(data.postageLoss)&&data.postageLoss>=0?data.postageLoss:0;
    fees+=fee;postage+=shipping;count++;
    const name=MARKETPLACE_NAMES[data.marketplace.toLowerCase() as keyof typeof MARKETPLACE_NAMES]??data.marketplace;
    let platform=result.byPlatform.find(row=>row.platform===name);
    if(!platform){platform={platform:name,count:0,revenue:0,fees:0,shippingIncome:0,shippingProfit:0,netProfit:0};result.byPlatform.push(platform);}
    platform.fees=round(platform.fees+fee);platform.shippingProfit=round(platform.shippingProfit-shipping);
    if(platform.netProfit!==null)platform.netProfit=round(platform.netProfit-fee-shipping);
    const period=data.resolvedAt!.slice(0,7);let month=result.overTime.find(row=>row.period===period);
    if(!month){month={period,revenue:0,netProfit:0,count:0};result.overTime.push(month);}
    month.netProfit=round(month.netProfit-fee-shipping);
  }
  const total=round(fees+postage);result.totals.fees=round(result.totals.fees+fees);result.totals.shipping=round(result.totals.shipping+postage);
  result.totals.shippingProfit=round(result.totals.shippingProfit-postage);result.totals.revenueAfterFees=round(result.totals.revenueAfterFees-total);result.totals.netProfit=round(result.totals.netProfit-total);
  // Profit excludes sales with unknown item costs, so its denominator must use
  // that same set of sales. Missing cost is not zero cost, even without returns.
  const costedRevenue=result.soldItems.reduce((sum,item)=>sum+(!item.costMissing&&item.netProfit!==null?item.revenue:0),0);
  result.totals.marginPct=costedRevenue>0?round(result.totals.netProfit/costedRevenue*100):null;
  result.overTime.sort((a,b)=>a.period.localeCompare(b.period));
  return {...result,returnCosts:{count,fees:round(fees),postage:round(postage),total}};
}
