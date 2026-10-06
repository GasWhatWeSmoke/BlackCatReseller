import type { PrismaClient } from '@prisma/client';
import { ORDER_REVIEW_FIELD, orderReviewData, orderReviewIdentity } from './orderReviews.ts';

export interface OrderReviewQuery { view:'pending'|'history'; q:string; page:number; pageSize:number }
export interface OrderReviewEntry {
  id:number; itemId:number|null; sku:string; action:string; createdAt:string; identity:string;
  marketplace:string; reason:string; url:string|null; feeLoss:number|null; postageLoss:number|null; unavailable:boolean;
}
export interface OrderReviewPage {
  view:OrderReviewQuery['view']; q:string; page:number; pages:number; pageSize:number; total:number;
  pending:number; resolved:number; entries:OrderReviewEntry[];
}
export function parseOrderReviewQuery(params:URLSearchParams):OrderReviewQuery {
  const view=params.get('view')||'pending',q=(params.get('q')||'').trim();
  const number=(name:string,fallback:number,max:number)=>{
    const raw=params.get(name);if(raw===null||raw==='')return fallback;
    const value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<1||value>max)throw Error('Choose a valid review page and page size.');
    return value;
  };
  if(!['pending','history'].includes(view)||q.length>32)throw Error('Choose Pending or History and a SKU of at most 32 characters.');
  return {view:view as OrderReviewQuery['view'],q,page:number('page',1,1_000_000),pageSize:number('pageSize',25,100)};
}
export async function readOrderReviewPage(db:Pick<PrismaClient,'$transaction'>,query:OrderReviewQuery):Promise<OrderReviewPage> {
  // Validate direct local callers too; count and page rows describe one snapshot.
  query=parseOrderReviewQuery(new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)])));
  return db.$transaction(async tx=>{
    const pendingWhere={field:ORDER_REVIEW_FIELD,action:'pending_review'};
    const historyWhere={field:ORDER_REVIEW_FIELD,action:{not:'pending_review'}};
    const where={...(query.view==='pending'?pendingWhere:historyWhere),...(query.q?{sku:{contains:query.q}}:{})};
    const pending=await tx.syncLog.count({where:pendingWhere}),resolved=await tx.syncLog.count({where:historyWhere});
    const total=query.q?await tx.syncLog.count({where}):query.view==='pending'?pending:resolved;
    const pages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,pages);
    const rows=await tx.syncLog.findMany({where,orderBy:{id:'desc'},skip:(page-1)*query.pageSize,take:query.pageSize,
      select:{id:true,itemId:true,sku:true,action:true,runAt:true,newValue:true}});
    const entries=rows.map(row=>{
      const data=orderReviewData(row.newValue);
      const amount=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
      let url:string|null=null;
      try {const parsed=new URL(data?.url??'');if(['https:','http:'].includes(parsed.protocol))url=parsed.href;}catch{}
      const unavailable=!data||!row.itemId||!['pending_review','returned','review_resolved'].includes(row.action)
        ||row.action==='returned'&&(amount(data.feeLoss)===null||amount(data.postageLoss)===null);
      return {id:row.id,itemId:row.itemId,sku:row.sku,action:row.action,createdAt:row.runAt.toISOString(),
        identity:orderReviewIdentity(row),marketplace:data?.marketplace??'Unknown marketplace',
        reason:unavailable?'Stored order details are incomplete. Refresh this review before making a decision.':data!.reason,
        url,feeLoss:amount(data?.feeLoss),postageLoss:amount(data?.postageLoss),unavailable};
    });
    return {...query,page,pages,total,pending,resolved,entries};
  });
}
