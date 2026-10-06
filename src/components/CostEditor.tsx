"use client";
import { useEffect,useRef,useState } from 'react';
import type { DraftItem } from '@/lib/itemDrafts';
import { withExpectedItemValues } from '@/lib/itemEdits';
import { useItemDraft } from './useItemDraft';
import { DraftRecovery } from './DraftRecovery';
import { toast } from 'sonner';

export interface CostItem extends DraftItem { sku:string;itemCost:number|null;readVersion?:number }
export const COST_DRAFT_EVENT='blackcat:cost-drafts';
let observation=0;
/** Orders observations within this window so a pre-save read cannot undo a receipt. */
export function nextCostObservation(){return ++observation;}
function costValue(raw:string):{ok:true;cost:number|null}|{ok:false}{
  const text=raw.trim();if(!text)return {ok:true,cost:null};
  const cost=Number(text);
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)&&Number.isFinite(cost)&&cost>=0&&Number.isSafeInteger(Math.round(cost*100))?{ok:true,cost}:{ok:false};
}
export function CostEditor({item:observed,isCurrent,onRefresh,onSafety}:{item:CostItem;isCurrent:()=>boolean;onRefresh:()=>Promise<unknown>;onSafety:(key:string,busy:boolean,unsafe?:boolean)=>void}){
  const [receipt,setReceipt]=useState<CostItem|null>(null);
  const item=receipt&&(observed.readVersion??0)<(receipt.readVersion??0)?receipt:observed;
  const [value,setValue]=useState(item.itemCost==null?'':String(item.itemCost)),[saving,setSaving]=useState(false),[error,setError]=useState<string|null>(null);
  const pending=useRef(false),alive=useRef(true),wasWriting=useRef(false);
  const recovery=useItemDraft('earnings',item,changes=>{
    setValue(Object.hasOwn(changes,'itemCost')?(changes.itemCost==null?'':String(changes.itemCost)):item.itemCost==null?'':String(item.itemCost));
    setError(null);
  });
  const key=`${item.id}:${item.createdAt}`;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{onSafety(key,saving,!recovery.canLeave);return()=>onSafety(key,false,false);},[key,saving,recovery.canLeave,onSafety]);
  useEffect(()=>{if(wasWriting.current&&!recovery.writing)window.dispatchEvent(new Event(COST_DRAFT_EVENT));wasWriting.current=recovery.writing;},[recovery.writing]);
  useEffect(()=>{if(!recovery.dirty)setValue(item.itemCost==null?'':String(item.itemCost));},[item.itemCost,recovery.dirty]);
  async function save(){
    if(pending.current||!recovery.canSave||!recovery.dirty||item.status!=='Sold'||!isCurrent())return;
    const parsed=costValue(value);
    if(!parsed.ok){const message='Enter a nonnegative cost within the supported currency range, such as 4.50, or leave it blank for unknown.';setError(message);toast.error(message,{id:`cost-${item.id}`});return;}
    const cost=parsed.cost;
    pending.current=true;setSaving(true);setError(null);onSafety(key,true,!recovery.canLeave);
    try{
      const token=await recovery.prepareSave();
      if(!alive.current||!isCurrent())return;
      const response=await fetch(`/api/items/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(withExpectedItemValues(token.expected,{itemCost:cost}))});
      const result=await response.json().catch(()=>null);
      if(!response.ok){if(response.status===409)await onRefresh();throw Error(result?.error||'The cost could not be saved. Your draft is kept.');}
      const saved=result?.item;
      if(!saved||saved.id!==item.id||saved.createdAt!==item.createdAt||saved.itemCost!==cost||saved.status!=='Sold')
        throw Error('The saved cost could not be confirmed. Your draft is kept; refresh before retrying.');
      setReceipt({...item,itemCost:cost,readVersion:nextCostObservation()});
      await recovery.saved(token,saved);setValue(cost===null?'':String(cost));
      toast.success(`${item.sku} cost saved`,{id:`cost-${item.id}`});
      window.dispatchEvent(new Event(COST_DRAFT_EVENT));
      await onRefresh();
    }catch(error){const message=error instanceof Error?error.message:'Could not confirm this cost. Your draft is kept.';if(alive.current)setError(message);toast.error(message,{id:`cost-${item.id}`,duration:8000});}
    finally{pending.current=false;setSaving(false);onSafety(key,false);}
  }
  return <div data-cost-editor={item.id} style={{minWidth:140,maxWidth:330}}>
    <div style={{display:'flex',gap:7,alignItems:'center',flexWrap:'wrap'}}>
      <input className="input" type="text" inputMode="decimal" maxLength={32} aria-label={`Cost for ${item.sku}`} value={value}
        disabled={!recovery.ready||recovery.discarding||saving||item.status!=='Sold'} placeholder="$ cost"
        style={{width:90,borderColor:item.itemCost===null?'var(--warn)':undefined}}
        onChange={event=>{const raw=event.target.value,parsed=costValue(raw),draft=parsed.ok&&!raw.trim().endsWith('.')?parsed.cost:raw;
          if(recovery.change({itemCost:draft})){setValue(raw);setError(null);}}}
        onKeyDown={event=>{if(event.key==='Enter'&&!event.repeat&&!event.nativeEvent.isComposing){event.preventDefault();void save();}}}
        onBlur={event=>{if((event.relatedTarget as Element|null)?.closest('[data-cost-editor]')?.getAttribute('data-cost-editor')===String(item.id))return;void save();}}/>
      <button className="btn" disabled={saving||!recovery.canSave||!recovery.dirty||item.status!=='Sold'||!isCurrent()} onClick={()=>void save()}>Save cost</button>
    </div>
    {saving&&<p role="status">Saving cost…</p>}
    {error&&<p role="alert" style={{color:'var(--warn)',fontSize:12,overflowWrap:'anywhere'}}>{error}</p>}
    {item.status!=='Sold'&&<p role="status">This item is now {item.status}. Its cost draft is kept; use the item editor to review its current inventory details.</p>}
    <DraftRecovery recovery={recovery} item={item} compact disabled={saving}/>
  </div>;
}
