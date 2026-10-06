"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { draftIdentity,listItemDrafts,type ItemDraft } from '@/lib/itemDrafts';
import { CostEditor,COST_DRAFT_EVENT,nextCostObservation,type CostItem } from './CostEditor';
import { usePolledRead } from './usePolledRead';

export function useCostDraftCount(){
  const read=useCallback(async()=>{
    const rows=await listItemDrafts('earnings');
    return rows.map(draft=>({draft,...draftIdentity(draft.key,'earnings')}))
      .sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id-b.id).map(row=>row.draft);
  },[]),view=usePolledRead(read,null);
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const changed=()=>{view.invalidate();clearTimeout(timer);timer=setTimeout(()=>void view.load(),150);};window.addEventListener(COST_DRAFT_EVENT,changed);window.addEventListener('focus',changed);
    return()=>{clearTimeout(timer);window.removeEventListener(COST_DRAFT_EVENT,changed);window.removeEventListener('focus',changed);};
  },[view.load,view.invalidate]);
  return {drafts:view.data??[],error:view.error,ready:view.fresh};
}
export function CostDrafts({drafts,ready,onSafety,navigate,onFigures}:{drafts:ItemDraft[];ready:boolean;onSafety:(key:string,busy:boolean,unsafe?:boolean)=>void;navigate:(action:()=>void)=>void;onFigures:()=>Promise<unknown>}){
  const [page,setPage]=useState(1),[attempt,setAttempt]=useState(0),[items,setItems]=useState<{draft:ItemDraft;item:CostItem|null;error?:string}[]>([]),[loading,setLoading]=useState(true);
  const pages=Math.max(1,Math.ceil(drafts.length/10)),shown=Math.min(page,pages);
  useEffect(()=>{if(page!==shown)setPage(shown);},[page,shown]);
  const keys=drafts.slice((shown-1)*10,shown*10).map(draft=>draft.key).join('\n');
  const currentKeys=useRef(keys),figures=useRef(onFigures),waiters=useRef<(()=>void)[]>([]);currentKeys.current=keys;figures.current=onFigures;
  useEffect(()=>()=>{for(const resolve of waiters.current.splice(0))resolve();},[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);
    const selected=drafts.slice((shown-1)*10,shown*10);
    void Promise.all(selected.map(async draft=>{
      try{
        const identity=draftIdentity(draft.key,'earnings');
        const readVersion=nextCostObservation();
        const response=await fetch(`/api/items/${identity.id}`,{signal:controller.signal,cache:'no-store'});
        const data=await response.json(),item=data?.item;
        if(!response.ok||!item||item.id!==identity.id||item.createdAt!==identity.createdAt||typeof item.status!=='string'||typeof item.sku!=='string'
          ||item.itemCost!==null&&(typeof item.itemCost!=='number'||!Number.isFinite(item.itemCost)))throw Error('The original item could not be confirmed. Its local cost draft has been kept.');
        return {draft,item:{...item,readVersion} as CostItem};
      }catch(error){return {draft,item:null,error:error instanceof Error?error.message:'Could not read the original item.'};}
    })).then(rows=>{if(!controller.signal.aborted){setItems(rows);setLoading(false);for(const resolve of waiters.current.splice(0))resolve();}});
    return()=>controller.abort();
    // New revisions do not reset a visible editor; the draft hook checks them before saving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[keys,attempt,shown]);
  const refresh=useCallback(async()=>{const local=new Promise<void>(resolve=>{waiters.current.push(resolve);setAttempt(value=>value+1);});await Promise.all([local,figures.current()]);},[]);
  return <div>
    <p className="muted">These cost edits are kept locally, oldest inventory first, and may be outside the selected period. They do not change inventory until saved.</p>
    <button className="btn" onClick={()=>navigate(()=>{window.dispatchEvent(new Event(COST_DRAFT_EVENT));setAttempt(value=>value+1);})}>Refresh unfinished costs</button>
    {(loading||!ready)&&<p role="status">Loading unfinished costs…</p>}
    {!loading&&ready&&!drafts.length&&<p>No unfinished cost edits.</p>}
    {items.map(({draft,item,error})=><article key={draft.key} className="card" style={{padding:16,marginTop:12}}>
      {item?<><h3 style={{marginTop:0}}><Link href={`/inventory/${item.id}`}>{item.sku}</Link> · {item.status}</h3><CostEditor item={item} isCurrent={()=>currentKeys.current===keys&&keys.split('\n').includes(draft.key)} onRefresh={refresh} onSafety={onSafety}/></>
        :<p role="alert">{error} Draft cost: {String(draft.changes.itemCost??'Unknown')}. Refresh to try again.</p>}
    </article>)}
    <nav aria-label="Unfinished cost pages" style={{display:'flex',gap:12,alignItems:'center',marginTop:14,flexWrap:'wrap'}}>
      <button className="btn" disabled={loading||shown<=1} onClick={()=>navigate(()=>setPage(shown-1))}>Previous drafts</button><span>Page {shown} / {pages}</span><button className="btn" disabled={loading||shown>=pages} onClick={()=>navigate(()=>setPage(shown+1))}>Next drafts</button>
    </nav>
  </div>;
}
