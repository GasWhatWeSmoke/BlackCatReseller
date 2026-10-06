import {pricingIndexView,pricingRowsView} from './pricingReadView.ts';
import type {PricingIndex} from './pricingRead.ts';
import {draftIdentity,type ItemDraft} from './itemDrafts.ts';
import {recoverPricingRows} from './pricingDraft.ts';
export async function fetchPricingIndex(signal:AbortSignal,ids:number[]|null=null){
  const params=new URLSearchParams({view:'pricing-index'});if(ids)params.set('ids',ids.join(','));
  const response=await fetch('/api/items?'+params,{signal,cache:'no-store'});
  if(!response.ok)throw Error('Pricing identities could not load. Retry without discarding drafts.');
  return pricingIndexView(await response.json(),ids);
}
export async function fetchPricingRows(signal:AbortSignal,ids:number[]){
  if(!ids.length)return {items:[],requestedIds:[]};
  const response=await fetch('/api/items?'+new URLSearchParams({view:'pricing-rows',ids:ids.join(',')}),{signal,cache:'no-store'});
  if(!response.ok)throw Error('Pricing details could not load. Your drafts are kept.');
  return pricingRowsView(await response.json(),ids);
}
export async function recoverPricingIndex(unpriced:PricingIndex[],drafts:ItemDraft[],read:(ids:number[])=>Promise<PricingIndex[]>){
  const known=new Set(unpriced.map(row=>row.id)),missing=[...new Set(drafts.map(draft=>draftIdentity(draft.key,'pricing').id).filter(id=>!known.has(id)))];
  const fetched=new Map<number,PricingIndex>(),errors=new Map<number,string>();let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,Math.ceil(missing.length/100))},async()=>{
    while(cursor<missing.length){const ids=missing.slice(cursor,cursor+100);cursor+=100;
      try{for(const row of await read(ids))fetched.set(row.id,row);}catch(error){for(const id of ids)errors.set(id,error instanceof Error?error.message:'Draft identities could not load.');}
    }
  }));
  return recoverPricingRows(unpriced,drafts,async id=>{if(errors.has(id))throw Error(errors.get(id));return fetched.get(id)??null;});
}
