"use client";
import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { validateBrandPreview,validateBrandResult,type BrandCleanupPlan,type BrandCleanupResult } from '@/lib/brandCleanup';

const label=(value:string|null)=>value===null?'Not set':value===''?'Empty':value.trim()===''?'Whitespace only':value;
const identity=(row:{id:number;createdAt:string})=>`${row.id}:${row.createdAt}`;
export function BrandCleanup(){
  const [plan,setPlan]=useState<BrandCleanupPlan|null>(null),[result,setResult]=useState<BrandCleanupResult|null>(null),[error,setError]=useState<string|null>(null);
  const [selected,setSelected]=useState<Set<number>>(new Set());
  const excluded=useRef(new Set<string>());
  const [busy,setBusy]=useState<'preview'|'apply'|null>(null),[fresh,setFresh]=useState(false);
  const working=useRef(false),alive=useRef(true),controller=useRef<AbortController|null>(null),ready=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  useEffect(()=>{if(busy!=='apply')return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[busy]);
  async function preview(page=1,suggestionPage=1){
    if(working.current)return;working.current=true;setBusy('preview');ready.current=false;setFresh(false);setError(null);setResult(null);
    const request=new AbortController();controller.current=request;
    try{
      const response=await fetch(`/api/maintenance/canonicalize-brands?${new URLSearchParams({page:String(page),suggestionPage:String(suggestionPage)})}`,{signal:request.signal,cache:'no-store'});
      const data=await response.json();if(!response.ok)throw Error(data?.error||'Could not check brand spellings.');
      const confirmed=validateBrandPreview(data);if(!alive.current||request.signal.aborted)return;
      setPlan(confirmed);setSelected(new Set(confirmed.changes.filter(row=>!excluded.current.has(identity(row))).map(row=>row.id)));ready.current=true;setFresh(true);
    }catch(error){if(alive.current&&!request.signal.aborted)setError(error instanceof Error?error.message:'Could not check brand spellings.');}
    finally{working.current=false;if(alive.current)setBusy(null);}
  }
  async function apply(){
    if(working.current||!ready.current||!plan?.changes.length)return;
    const changes=plan.changes.filter(row=>!excluded.current.has(identity(row)));if(!changes.length)return;
    working.current=true;ready.current=false;setBusy('apply');setFresh(false);setError(null);setResult(null);
    try{
      const response=await fetch('/api/maintenance/canonicalize-brands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes})});
      const data=await response.json();if(!response.ok)throw Error(data?.error||'The cleanup could not be confirmed.');
      const confirmed=validateBrandResult(data,changes);if(!alive.current)return;
      setResult(confirmed);setPlan(null);
    }catch(error){if(alive.current)setError(error instanceof Error?error.message:'The cleanup could not be confirmed. Check a fresh preview before trying again.');}
    finally{working.current=false;if(alive.current)setBusy(null);}
  }
  return <section aria-label="Brand spelling cleanup" style={{minWidth:0}}>
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      <button className="btn" disabled={!!busy} onClick={()=>void preview()}>{busy==='preview'?'Checking brands…':'Check brand spellings'}</button>
      {!!plan?.changes.length&&<button className="btn btn-primary" disabled={!!busy||!fresh||!selected.size} onClick={()=>void apply()}>{busy==='apply'?'Applying reviewed changes…':`Apply ${selected.size} reviewed ${selected.size===1?'fix':'fixes'}`}</button>}
    </div>
    <p className="muted" style={{fontSize:12,lineHeight:1.65}}>Review the exact brand and sub-line changes below. Each batch contains at most 100 items. Sold and archived items are excluded; near matches remain suggestions for individual review.</p>
    {error&&<p role="alert" style={{color:'var(--warn)'}}>{error} Check a fresh preview before applying again.</p>}
    {plan&&!fresh&&<p role="status">The previous preview is shown for reference. Applying is disabled until a fresh check succeeds.</p>}
    {result&&<div role="status"><p>Confirmed: {result.applied} updated; {result.skipped.length} skipped. Check brand spellings again to review any remaining fixes.</p>{!!result.skipped.length&&<ul>{result.skipped.map(row=><li key={row.id}><strong>{row.sku}</strong>: {row.reason}</li>)}</ul>}</div>}
    {plan&&<div style={{fontSize:13,marginTop:12}}>
      <p>Checked {plan.scanned} eligible items. {plan.totalChanges} exact fixes and {plan.totalSuggestions} suggestions found.</p>
      {plan.totalChanges===0?<p>No exact brand fixes are available in this preview.</p>:<>
        <p>Fix page {plan.page} of {plan.pages}. {selected.size} of these {plan.changes.length} changes selected. Exclude any change you want to review separately.</p>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}><button className="btn" disabled={!!busy||!fresh} onClick={()=>{for(const row of plan.changes)excluded.current.delete(identity(row));setSelected(new Set(plan.changes.map(row=>row.id)));}}>Select shown fixes</button><button className="btn" disabled={!!busy||!fresh} onClick={()=>{for(const row of plan.changes)excluded.current.add(identity(row));setSelected(new Set());}}>Clear shown selection</button></div>
        <div className="card" style={{padding:12,maxHeight:320,overflow:'auto'}} tabIndex={0} role="region" aria-label="Reviewed brand changes">
          <ul style={{listStyle:'none',padding:0,margin:0}}>{plan.changes.map(change=><li key={change.id} style={{padding:'10px 0',borderBottom:'1px solid var(--border)',overflowWrap:'anywhere'}}>
            <div style={{display:'flex',gap:8,alignItems:'center'}}><input type="checkbox" aria-label={`Include ${change.sku}`} checked={selected.has(change.id)} disabled={!!busy||!fresh} onChange={event=>{const include=event.target.checked;if(include)excluded.current.delete(identity(change));else excluded.current.add(identity(change));setSelected(current=>{const next=new Set(current);if(include)next.add(change.id);else next.delete(change.id);return next;});}}/><Link href={`/inventory/${change.id}`}><strong>{change.sku}</strong></Link></div><div style={{whiteSpace:'pre-wrap'}}>{label(change.from)} → <strong>{label(change.to)}</strong></div>
            {change.fromSubBrand!==change.toSubBrand&&<div className="muted">Sub-line: {label(change.fromSubBrand)} → {label(change.toSubBrand)}</div>}
          </li>)}</ul>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:8}}><button className="btn" disabled={!!busy||plan.page<=1} onClick={()=>void preview(plan.page-1,plan.suggestionPage)}>Previous fixes</button><button className="btn" disabled={!!busy||plan.page>=plan.pages} onClick={()=>void preview(plan.page+1,plan.suggestionPage)}>Next fixes</button></div>
      </>}
      {!!plan.totalSuggestions&&<details style={{marginTop:14}}><summary>Suggestions — not applied automatically ({plan.totalSuggestions})</summary>
        <ul>{plan.suggestions.map(row=><li key={row.id}><Link href={`/inventory/${row.id}`}>{row.sku}</Link>: {row.current} — possible match: {row.suggestion}</li>)}</ul>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button className="btn" disabled={!!busy||plan.suggestionPage<=1} onClick={()=>void preview(plan.page,plan.suggestionPage-1)}>Previous suggestions</button><span>Page {plan.suggestionPage} / {plan.suggestionPages}</span><button className="btn" disabled={!!busy||plan.suggestionPage>=plan.suggestionPages} onClick={()=>void preview(plan.page,plan.suggestionPage+1)}>Next suggestions</button></div>
      </details>}
    </div>}
  </section>;
}
