"use client";
import { useCallback,useEffect,useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight,CheckCircle2,Radio,AlertCircle } from 'lucide-react';
import type { StatusPayload } from '@/lib/publish/uiTypes';
import type { SaleMonitorStatus } from '@/lib/publish/saleMonitor';
import { progressSummary,uploadStageLabel } from '@/lib/publish/progressSummary';
import { MARKETPLACE_NAMES } from '@/lib/publish/platforms';
import styles from './HubActivity.module.css';
import { monitorPresentation } from '@/lib/monitorPresentation';

export default function HubActivity() {
  const [data,setData]=useState<{publish:StatusPayload;monitor:SaleMonitorStatus&{enabled:boolean;windowOpen:boolean};issues:{jobId:number;sku:string;marketplace:string;guidance:{title:string}}[]}|null>(null);
  const [error,setError]=useState(false);
  const load=useCallback(async()=>{
    try {
      const result=await Promise.all(['/api/publish/status','/api/publish/monitor','/api/publish/recovery'].map(async url=>{const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error('Unavailable');return response.json();}));
      setData({publish:result[0],monitor:result[1],issues:result[2].items ?? []});setError(false);
    }catch{setError(true);}
  },[]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer);},[load]);
  const name=(value:string)=>MARKETPLACE_NAMES[value as keyof typeof MARKETPLACE_NAMES] ?? value;
  const p=data ? progressSummary(data.publish):null;
  const monitoring=data ? monitorPresentation(data.monitor):null;
  return <section className={styles.grid} aria-label="Workspace activity" data-stale={error}>
    <div className={styles.card}>
      <div className={styles.heading}><span><Radio size={15}/> WORKSPACE ACTIVITY</span><Link href="/ready/activity">View runs <ArrowUpRight size={13}/></Link></div>
      {error&&<p className={styles.warning}>Activity could not refresh. <button onClick={()=>void load()}>Try again</button></p>}
      {!data ? <p className="muted">Loading activity…</p> : <>
        <h3>{data.publish.current ? `Crosslisting ${data.publish.current.sku}` : data.publish.run?.status==='paused' ? 'Your batch is paused' : 'Ready for your next batch'}</h3>
        <p>{data.publish.current ? `${name(data.publish.current.marketplace)} · ${uploadStageLabel(data.publish.current.phase?.stage,data.publish.current.phase?.photoCount)}` : 'Add photos, review the details, and choose where your pieces go.'}</p>
        {p&&data.publish.run&&<div className={styles.progress}><span>{p.published} / {p.total} listings confirmed in the latest run</span><progress max={p.total||1} value={p.published}/></div>}
        <div className={styles.monitor}><span className={monitoring?.tone==='ready'||monitoring?.tone==='active'?styles.online:styles.offline}/><strong>{monitoring?.label}</strong><span>{monitoring?.detail}</span></div>
        {data.monitor.lastError&&<p className={styles.warning}>{data.monitor.lastError}</p>}
      </>}
    </div>
    <div className={styles.card}>
      <div className={styles.heading}><span><AlertCircle size={15}/> UPLOAD ATTENTION</span><Link href="/ready/recovery">Open recovery <ArrowUpRight size={13}/></Link></div>
      {!data ? <p className="muted">Loading upload issues…</p> : data.issues.length ? <>
        <h3>{data.issues.length} {data.issues.length===1?'listing needs':'listings need'} a next step</h3>
        <div className={styles.issues}>{data.issues.slice(0,3).map(issue=><Link href="/ready/recovery" key={issue.jobId}><strong>#{issue.sku}<small>{name(issue.marketplace)}</small></strong><span>{issue.guidance.title}</span><ArrowUpRight size={14}/></Link>)}</div>
      </> : <div className={styles.clear}><CheckCircle2 size={27}/><h3>No unresolved upload failures</h3><p>Any item needing a correction, account check, or safe retry will appear here.</p></div>}
    </div>
  </section>;
}
