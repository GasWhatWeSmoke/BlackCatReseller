"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { RefreshCw,PackageCheck,Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import type { OrderReviewEntry,OrderReviewPage } from '@/lib/publish/orderReviewPage';
import { usePolledRead } from './usePolledRead';
import { useReturnDraft } from './useReturnDraft';
import styles from './OrderReviews.module.css';

function confirmedPage(value:unknown):OrderReviewPage {
  const data=value as OrderReviewPage;
  const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
  if(!data||!['pending','history'].includes(data.view)||typeof data.q!=='string'
    ||![data.page,data.pages,data.pageSize,data.total,data.pending,data.resolved].every(count)
    ||data.page<1||data.pages<1||data.page>data.pages||data.pageSize<1||data.pageSize>100
    ||data.pages!==Math.max(1,Math.ceil(data.total/data.pageSize))||!Array.isArray(data.entries)
    ||data.total>(data.view==='pending'?data.pending:data.resolved)
    ||new Set(data.entries.map(entry=>entry?.id)).size!==data.entries.length
    ||data.entries.length!==Math.min(data.pageSize,Math.max(0,data.total-(data.page-1)*data.pageSize))
    ||data.entries.some(entry=>!entry||!Number.isSafeInteger(entry.id)||entry.id<1
      ||entry.itemId!==null&&(!Number.isSafeInteger(entry.itemId)||entry.itemId<1)
      ||[entry.sku,entry.marketplace,entry.reason,entry.action,entry.identity,entry.createdAt].some(value=>typeof value!=='string')
      ||!entry.identity||!Number.isFinite(Date.parse(entry.createdAt))
      ||typeof entry.unavailable!=='boolean'||entry.url!==null&&typeof entry.url!=='string'
      ||[entry.feeLoss,entry.postageLoss].some(value=>value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))
      ||!entry.unavailable&&(!entry.itemId||entry.action==='returned'&&(entry.feeLoss===null||entry.postageLoss===null))
      ||(data.view==='pending')!==(entry.action==='pending_review')))
    throw Error('Order review information is incomplete. Refresh before making a decision.');
  return data;
}
export function OrderReviews(){
  const [tab,setTab]=useState<'pending'|'history'>('pending'),[page,setPage]=useState(1),[search,setSearch]=useState(''),[q,setQ]=useState('');
  const [sku,setSku]=useState(''),[busy,setBusy]=useState(false),[actionError,setActionError]=useState<string|null>(null);
  const [unsafeDrafts,setUnsafeDrafts]=useState<Record<string,boolean>>({});
  const unsafeKeys=useRef(new Set<string>());
  const working=useRef(false),unsafe=Object.values(unsafeDrafts).some(Boolean);
  const draftSafety=useCallback((key:string,unsafe:boolean)=>{if(unsafe)unsafeKeys.current.add(key);else unsafeKeys.current.delete(key);setUnsafeDrafts(current=>current[key]===unsafe?current:{...current,[key]:unsafe});},[]);
  useEffect(()=>{if(unsafe||search.trim()===q)return;const timer=setTimeout(()=>{setQ(search.trim());setPage(1);},250);return()=>clearTimeout(timer);},[search,q,unsafe]);
  const read=useCallback(async(signal:AbortSignal)=>{
    const params=new URLSearchParams({view:tab,page:String(page),q});
    const response=await fetch(`/api/sales/returns?${params}`,{signal,cache:'no-store'});
    if(!response.ok)throw Error('Order reviews could not load. Refresh before making a return decision.');
    const data=confirmedPage(await response.json());
    if(data.view!==tab||data.q!==q)throw Error('The returned review list does not match this view. Refresh to continue.');
    return {...data,requestedPage:page};
  },[tab,page,q]);
  const view=usePolledRead(read,15000),{error,load}=view;
  const data=view.data?.view===tab&&view.data.q===q?view.data:null;
  const contextKey=JSON.stringify([tab,q,page]),latest=useRef({key:contextKey,data});latest.current={key:contextKey,data};
  useEffect(()=>{if(view.fresh&&data&&data.requestedPage===page&&data.page!==page)setPage(data.page);},[view.fresh,data,page]);
  useEffect(()=>{if(!busy)return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[busy]);
  async function send(body:Record<string,unknown>,entry?:OrderReviewEntry):Promise<boolean>{
    if(working.current||!view.isFresh()||latest.current.key!==contextKey||!latest.current.data)return false;
    if(entry&&(!latest.current.data.entries.some(row=>row.identity===entry.identity&&row.action==='pending_review'&&!row.unavailable)))return false;
    working.current=true;setBusy(true);setActionError(null);view.invalidate();
    let confirmed=false;
    try {
      const response=await fetch('/api/sales/returns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok||result?.ok!==true)throw Error(result?.error||'The order review change could not be confirmed. Refresh before trying again.');
      if(body.action==='report'){
        if(!Number.isSafeInteger(result.id)||result.id<1)throw Error('The new order review could not be confirmed.');
        setSku(current=>current.trim()===String(body.sku).trim()?'':current);toast.success('Order added to review');
      }else{
        if(!entry||result.id!==entry.id||result.identity!==entry.identity||result.itemId!==entry.itemId||result.sku!==entry.sku||result.returned!==(body.decision==='return_to_review'))
          throw Error('The return decision could not be confirmed. Refresh its history before trying again.');
        toast.success(result.returned?`${result.sku} returned to Review`:'Sale kept recorded');
      }
      confirmed=true;
    }catch(error){setActionError(error instanceof Error?error.message:'The order review change could not be confirmed.');}
    finally{await load();working.current=false;setBusy(false);}
    return confirmed;
  }
  return <section className={styles.workspace}>
    <header className={styles.header}><div className="hub-eyebrow">ORDER FOLLOW-UP</div><h2>Returns & cancellations</h2><p>Review changed order statuses here. Returning an item requires your refund and item-received confirmations; it must then be reviewed and approved again before crosslisting.</p></header>
    <div className={styles.toolbar}><label>Report a sold item<input className="input" placeholder="Inventory number" maxLength={32} value={sku} disabled={busy} onChange={event=>setSku(event.target.value)}/></label><button className="btn" disabled={busy||!view.fresh||!sku.trim()} onClick={()=>void send({action:'report',sku:sku.trim()})}>Add to review</button><button className="btn" disabled={busy} onClick={()=>void load()}><RefreshCw size={15}/> Refresh reviews</button></div>
    <div className={styles.tabs} aria-label="Order review views">{(['pending','history'] as const).map(value=><button key={value} aria-pressed={tab===value} disabled={busy||unsafe} onClick={()=>{if(working.current||unsafeKeys.current.size)return;setTab(value);setPage(1);}}>{value==='pending'?'Pending':'History'}{view.data?` (${value==='pending'?view.data.pending:view.data.resolved})`:''}</button>)}</div>
    <label className={styles.toolbar}>Find by SKU<input className="input" maxLength={32} placeholder="Search inventory number" value={search} disabled={busy||unsafe} onChange={event=>setSearch(event.target.value)}/></label>
    {(error||actionError)&&<p role="alert" className={styles.error}>{error||actionError}</p>}
    {data&&!view.fresh&&<p role="status" className={styles.muted}>Showing the last loaded reviews. Decisions are paused until this view refreshes.</p>}
    {!data&&!error&&<p role="status">Loading order reviews…</p>}
    {unsafe&&<p role="status" className={styles.muted}>Keep this view open until your local return inputs are saved or their conflict is resolved.</p>}
    {data&&<>
      <p className={styles.muted}>{data.total} {q?'matching ':''}{tab==='pending'?'pending reviews':'history entries'}. Page {data.page} of {data.pages}.</p>
      {view.fresh&&!data.total&&<p className={styles.empty}>{q?'No reviews match this SKU.':tab==='pending'?'No returns or cancellations need review.':'No resolved order history yet.'}</p>}
      <div className={styles.list}>{data.entries.map(entry=>tab==='pending'&&!entry.unavailable
        ?<ReturnEntry key={entry.identity} entry={entry} busy={busy||!view.fresh} onSave={send} onSafety={draftSafety}/>
        :<article className={styles.entry} key={entry.identity}><Identity entry={entry}/>{entry.unavailable?<p role="alert" className={styles.error}>{entry.reason}</p>:<><p>{entry.action==='returned'?'Returned to Review':'Sale retained'}</p>{entry.action==='returned'&&<p className={styles.muted}>Unrecovered fees ${entry.feeLoss!.toFixed(2)} · postage ${entry.postageLoss!.toFixed(2)}. Original sale values remain in the order ledger.</p>}</>}</article>)}</div>
      <nav className={styles.pagination} aria-label="Review pages"><button className="btn" disabled={!view.fresh||busy||unsafe||data.page<=1} onClick={()=>{if(!working.current&&!unsafeKeys.current.size)setPage(data.page-1);}}>Previous reviews</button><span>Page {data.page} / {data.pages}</span><button className="btn" disabled={!view.fresh||busy||unsafe||data.page>=data.pages} onClick={()=>{if(!working.current&&!unsafeKeys.current.size)setPage(data.page+1);}}>Next reviews</button></nav>
    </>}
  </section>;
}
function Identity({entry}:{entry:OrderReviewEntry}){
  return <div className={styles.identity}><Undo2 size={20}/>{entry.itemId?<Link href={`/inventory/${entry.itemId}`}><strong>Inventory {entry.sku}</strong></Link>:<strong>Inventory {entry.sku}</strong>}<span className="chip">{entry.marketplace}</span><span className={styles.muted}>Recorded {new Date(entry.createdAt).toLocaleDateString()}</span>{entry.url&&<a href={entry.url} target="_blank" rel="noreferrer">Open listing ↗</a>}</div>;
}
function ReturnEntry({entry,busy,onSave,onSafety}:{entry:OrderReviewEntry;busy:boolean;onSave:(body:Record<string,unknown>,entry:OrderReviewEntry)=>Promise<boolean>;onSafety:(key:string,unsafe:boolean)=>void}){
  const draft=useReturnDraft(entry.identity),{refund,received,fees,postage}=draft.values;
  const [error,setError]=useState<string|null>(null),[submitting,setSubmitting]=useState(false),submission=useRef(false);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{onSafety(entry.identity,submitting||!draft.canLeave);return()=>onSafety(entry.identity,false);},[entry.identity,draft.canLeave,submitting,onSafety]);
  useEffect(()=>{if(!submitting)return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[submitting]);
  const validMoney=(value:string)=>value.trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0;
  async function decide(decision:'return_to_review'|'keep_sold'){
    if(submission.current||busy)return;submission.current=true;onSafety(entry.identity,true);setSubmitting(true);setError(null);
    try {
      const values=await draft.prepare();
      if(!alive.current)return;
      if(decision==='return_to_review'&&(!values.refund||!values.received||!validMoney(values.fees)||!validMoney(values.postage)))throw Error('Confirm the refund and item receipt, then enter valid fees and postage.');
      if(await onSave({id:entry.id,reviewIdentity:entry.identity,decision,fullRefund:values.refund,itemReceived:values.received,feeLoss:Number(values.fees),postageLoss:Number(values.postage)},entry))await draft.clear();
    }catch(error){setError(error instanceof Error?error.message:'Could not save this decision.');}
    finally{submission.current=false;setSubmitting(false);}
  }
  return <article className={styles.entry} aria-label={`Review ${entry.sku}`}><Identity entry={entry}/><p className={styles.reason}>{entry.reason}</p>
    {(error||draft.error)&&<p role="alert" className={styles.error}>{error||draft.error}</p>}
    {!draft.ready&&<p role="status">Recovering local return inputs… {draft.error&&<button className="btn" onClick={draft.retry}>Retry draft recovery</button>}</p>}
    {draft.conflict&&<div className={styles.actions}><button className="btn" onClick={()=>void draft.choose(true)}>Keep this window&apos;s inputs</button><button className="btn" onClick={()=>void draft.choose(false)}>Load other window&apos;s inputs</button></div>}
    <fieldset disabled={busy||submitting||!draft.ready||draft.conflict} className={styles.fields}>
      <label className={styles.confirm}><input type="checkbox" checked={refund} onChange={event=>draft.change({refund:event.target.checked})}/> I confirmed the full refund or fully cancelled sale payment.</label>
      <label className={styles.confirm}><input type="checkbox" checked={received} onChange={event=>draft.change({received:event.target.checked})}/> The item is physically back in my inventory.</label>
      <div className={styles.amounts}><label>Unrecovered sale fees · USD<input className="input" type="number" min="0" step="0.01" placeholder="0 if none" value={fees} onChange={event=>draft.change({fees:event.target.value})}/></label><label>Unrecovered postage · USD<input className="input" type="number" min="0" step="0.01" placeholder="0 if none" value={postage} onChange={event=>draft.change({postage:event.target.value})}/></label></div>
      <p className={styles.muted}>This reverses the completed sale in inventory, records remaining costs, and sends the item to Review. Its original sale and listing identities stay in the ledger.</p>
      <div className={styles.actions}><button className="btn btn-primary" disabled={!refund||!received||!validMoney(fees)||!validMoney(postage)} onClick={()=>void decide('return_to_review')}><PackageCheck size={16}/> Confirm return to Review</button><button className="btn" onClick={()=>void decide('keep_sold')}>Reviewed · keep sale recorded</button></div>
    </fieldset>
    {draft.ready&&<p role="status" className={styles.muted}>{draft.writing?'Keeping your inputs on this device…':draft.error?'Local recovery needs attention; keep this view open.':'Inputs are kept on this device. A return is only applied when you confirm it.'}</p>}
  </article>;
}
