"use client";
import { useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertCircle, CheckCircle2, Copy, ExternalLink, RefreshCw, RotateCcw, Package } from 'lucide-react';
import { MARKETPLACE_NAMES } from '@/lib/publish/platforms';
import ListingVerification from './ListingVerification';
import styles from './Recovery.module.css';
import { usePolledRead } from './usePolledRead';

interface RecoveryItem {
  jobId:number;runId:number;itemId:number;sku:string;title:string;marketplace:string;attemptCount:number;
  error:string|null;needsVerification:boolean;canRetry:boolean;verificationRevision:string|null;
  validation:{field:string;message:string}[]|null;
  photo:{storedPath:string;thumbPath:string|null;rotation:number}|null;
  guidance:{kind:string;title:string;next:string};
}
const sellers:Record<string,string>={ebay:'https://www.ebay.com/sh/lst/active',depop:'https://www.depop.com/sellinghub/selling/active/',etsy:'https://www.etsy.com/your/shops/me/tools/listings',poshmark:'https://poshmark.com/closet',mercari:'https://www.mercari.com/mypage/listings/active/'};
const marketName=(value:string)=>MARKETPLACE_NAMES[value as keyof typeof MARKETPLACE_NAMES] ?? value;
async function readRecovery(signal: AbortSignal): Promise<{ items: RecoveryItem[]; truncated: boolean }> {
  const response=await fetch('/api/publish/recovery',{cache:'no-store',signal});
  if(!response.ok)throw new Error('Could not refresh upload issues. Retry controls will return after refreshing.');
  const data=await response.json();
  if(!Array.isArray(data?.items)||data.items.some((item:RecoveryItem)=>!item||!Number.isSafeInteger(item.jobId)
    ||!Number.isSafeInteger(item.runId)||typeof item.sku!=='string'||typeof item.canRetry!=='boolean'
    ||typeof item.needsVerification!=='boolean'||typeof item.guidance?.kind!=='string'||typeof item.guidance?.title!=='string'
    ||item.needsVerification&&(typeof item.verificationRevision!=='string'||!item.verificationRevision)))
    throw new Error('Upload issues returned incomplete information. Refresh before retrying or verifying listings.');
  return {items:data.items,truncated:data.truncated===true};
}

export default function RecoveryCenter({runId,compact=false}:{runId?:number;compact?:boolean}) {
  const view=usePolledRead(readRecovery,10000);
  const {error,load}=view;
  const items=view.data?.items ?? [], loaded=view.data!==null, truncated=view.data?.truncated;
  const [filter,setFilter]=useState('all');
  const [busy,setBusy]=useState(false);
  const retrying=useRef(false);
  const scoped=runId ? items.filter(item=>item.runId===runId) : items;
  const retryReady=scoped.filter(item=>item.canRetry && item.guidance.kind==='retry');
  const visible=scoped.filter(item=>filter==='all'||item.guidance.kind===filter||filter==='details'&&item.guidance.kind==='brand');
  async function retry(selected:RecoveryItem[]) {
    if(retrying.current||!view.isFresh()||!selected.length)return;retrying.current=true;setBusy(true);view.invalidate();
    let retried=0;
    try {
      const groups=new Map<number,number[]>();
      for(const item of selected)groups.set(item.runId,[...(groups.get(item.runId) ?? []),item.jobId]);
      for(const [id,jobIds] of groups) {
        const response=await fetch(`/api/publish/runs/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'retry',jobIds})});
        const result=await response.json();
        if(!response.ok||!result.ok)throw new Error(result.error || 'These listings could not be retried');
        retried+=result.retried ?? 0;
      }
      toast.success(`${retried} ${retried===1?'listing':'listings'} queued for retry. Follow progress in Run activity.`);
    }catch(error){toast.error(`${retried?`${retried} retries queued. `:''}${error instanceof Error?error.message:'Could not retry'}`);}finally{await load();retrying.current=false;setBusy(false);}
  }
  if(compact&&view.fresh&&!scoped.length)return null;
  return <section className={styles.workspace} aria-label="Upload recovery">
    <div className={styles.header}><div><div className="hub-eyebrow" style={{color:'var(--warn)'}}>KEEP YOUR BATCH MOVING</div><h2>Needs attention</h2><p>See what happened and take the next step, one listing at a time.</p></div>
      <div className={styles.actions}><button className="btn" onClick={()=>void load()} disabled={busy}><RefreshCw size={14}/> Refresh</button><Link className="btn" href="/ready/activity">Run activity</Link></div>
    </div>
    {error&&<div role="alert" className={styles.warning}>{error}</div>}
    {loaded&&!view.fresh&&<p role="status" className="muted">Showing the last loaded issues. Retry and verification actions return after a successful refresh.</p>}
    {truncated&&<p className={styles.warning}>Some older attempts are beyond the display limit. The listings shown here can still be reviewed and retried.</p>}
    {!loaded ? <p className="muted">{error?'Upload issues are unavailable.':'Loading upload issues…'}</p> : !scoped.length ? view.fresh && <div className={styles.clear}><CheckCircle2 size={30}/><h3>No unresolved upload failures</h3><p>Queued and running uploads appear in Run activity. Successfully published listings stay in your history.</p><Link href="/ready/history" className="btn">View listing history</Link></div> : <>
      <div className={styles.summary}><div><strong>{scoped.length}</strong><span>listings need attention</span></div><div><strong>{retryReady.length}</strong><span>ready for a safe retry</span></div><div><strong>{scoped.filter(item=>item.needsVerification).length}</strong><span>need an outcome check</span></div></div>
      <div className={styles.toolbar}><div className={styles.filters}>{[{id:'all',name:'All issues'},{id:'retry',name:'Retry ready'},{id:'details',name:'Review details'},{id:'account',name:'Account access'},{id:'verify',name:'Check outcome'}].map(tab=><button key={tab.id} aria-pressed={filter===tab.id} onClick={()=>setFilter(tab.id)}>{tab.name}</button>)}</div>
        <button className="btn btn-primary" disabled={busy||!view.fresh||!retryReady.length} onClick={()=>void retry(retryReady)}><RotateCcw size={14}/>{busy?'Queuing…':`Retry ready (${retryReady.length})`}</button>
      </div>
      <div className={styles.list}>{visible.map(item=><article className={styles.item} key={item.jobId} data-kind={item.guidance.kind}>
        <div className={styles.itemHeader}><Link className={styles.photo} href={`/inventory/${item.itemId}`} aria-label={`Review ${item.sku}`}>{item.photo?<img alt="" src={`/api/thumb?path=${encodeURIComponent(item.photo.thumbPath??item.photo.storedPath)}&full=${encodeURIComponent(item.photo.storedPath)}`} style={{transform:`rotate(${item.photo.rotation}deg)`}}/>:<Package size={24}/>}</Link>
          <div className={styles.identity}><div><strong>#{item.sku}</strong><span>{marketName(item.marketplace)}</span><small>Run {item.runId} · {item.attemptCount} {item.attemptCount===1?'attempt':'attempts'}</small></div><Link href={`/inventory/${item.itemId}`}>{item.title || 'Review item details'}</Link></div>
          <button className="btn" title="Copy SKU" aria-label={`Copy SKU ${item.sku}`} onClick={()=>void navigator.clipboard.writeText(item.sku).then(()=>toast.success('SKU copied')).catch(()=>toast.error('Could not copy SKU'))}><Copy size={14}/></button>
        </div>
        <div className={styles.guidance}><AlertCircle size={18}/><div><h3>{item.guidance.title}</h3><p>{item.guidance.next}</p></div></div>
        {!!item.validation?.length&&<ul className={styles.validation}>{item.validation.map((issue,index)=><li key={index}><strong>{issue.field}:</strong> {issue.message}</li>)}</ul>}
        {item.error&&<details className={styles.technical}><summary>Original error</summary><p>{item.error}</p></details>}
        <div className={styles.actions}>
          <Link className={`btn ${item.guidance.kind==='details'?'btn-primary':''}`} href={`/inventory/${item.itemId}`}>Review item</Link>
          {['account','brand'].includes(item.guidance.kind)&&<Link className="btn btn-primary" href="/settings#marketplaces">Open account settings</Link>}
          {sellers[item.marketplace]&&<a className="btn" href={sellers[item.marketplace]} target="_blank" rel="noreferrer">Open {marketName(item.marketplace)} <ExternalLink size={13}/></a>}
          {item.canRetry&&<button className={`btn ${item.guidance.kind==='retry'?'btn-primary':''}`} disabled={busy||!view.fresh} onClick={()=>void retry([item])}><RotateCcw size={14}/>Retry this listing</button>}
        </div>
        {item.needsVerification&&item.verificationRevision&&<div className={styles.verification}><ListingVerification key={item.verificationRevision} revision={item.verificationRevision} jobId={item.jobId} sku={item.sku} marketplace={marketName(item.marketplace)} disabled={busy||!view.fresh} onResolved={async()=>{await load();}}/></div>}
      </article>)}</div>
      {!visible.length&&<p className="muted">No issues in this category.</p>}
    </>}
  </section>;
}
