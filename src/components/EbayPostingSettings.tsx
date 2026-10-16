"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useMarketplaceDraft } from './useMarketplaceDraft';
import { MarketplaceDraftNotice } from './MarketplaceDraftNotice';
import { EBAY_POLICY_KINDS, savedEbayPolicyCatalog, type EbayPolicyCatalog } from '@/lib/publish/ebayPolicyCatalog';
export function EbayPostingSettings({workspace}:{workspace:string}) {
  const recovery=useMarketplaceDraft(workspace,'ebayBrowser');
  const [reading,setReading]=useState(false),[message,setMessage]=useState('');
  const [catalog,setCatalog]=useState<EbayPolicyCatalog|undefined>();
  const readingRef=useRef(false),generation=useRef(0),pending=useRef(false),refreshRef=useRef<()=>Promise<void>>(async()=>{});
  const options=recovery.form, busy=recovery.busy||!recovery.ready||reading, error=recovery.error;
  const setOptions=recovery.change, save=recovery.save;
  async function refreshPolicies() {
    if(readingRef.current||!options||!recovery.ready)return;
    if(recovery.dirty||recovery.busy||recovery.writing||recovery.otherWindow){pending.current=true;setMessage('Save or discard the eBay settings shown here; policy linking will then continue automatically.');return;}
    pending.current=false;readingRef.current=true;setReading(true);setMessage('Reading existing eBay policies from your connected Chrome account…');
    const current=++generation.current;
    try{
      const expected={shippingPolicyName:options.shippingPolicyName,returnPolicyName:options.returnPolicyName,paymentPolicyName:options.paymentPolicyName};
      const response=await fetch('/api/publish/ebay-policies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace,expected})});
      const result=await response.json();
      if(!response.ok||result.ok!==true||result.workspace!==workspace)throw Error(result.error||'eBay policies could not be confirmed.');
      const value=savedEbayPolicyCatalog(result.catalog);
      if(current!==generation.current)return;
      setCatalog(value);recovery.reload();window.dispatchEvent(new Event('blackcat-ebay-policies-saved'));
      setMessage(value?.policies.length?'Policies loaded and available defaults saved. If a field has several choices without a default, choose one below and save eBay settings.':'No existing policies were found. Set up business policies in eBay, then refresh them here.');
    }catch(error){if(current===generation.current)setMessage(error instanceof Error?error.message:'eBay policies could not be linked.');}
    finally{readingRef.current=false;if(current===generation.current)setReading(false);}
  }
  useEffect(()=>{
    const controller=new AbortController(),current=++generation.current;
    void fetch('/api/publish/ebay-policies',{cache:'no-store',signal:controller.signal}).then(async response=>{
      const result=await response.json();if(!response.ok||result.workspace!==workspace)throw Error('Saved eBay policy choices could not be loaded.');
      if(current===generation.current)setCatalog(savedEbayPolicyCatalog(result.catalog));
    }).catch(error=>{if(!controller.signal.aborted&&current===generation.current)setMessage(error.message);});
    const connected=()=>{pending.current=true;void refreshRef.current();};window.addEventListener('blackcat-chrome-connected',connected);
    return()=>{controller.abort();generation.current++;window.removeEventListener('blackcat-chrome-connected',connected);};
  },[workspace]);
  useEffect(()=>{if(recovery.ready&&pending.current&&!recovery.dirty&&!recovery.busy&&!recovery.writing&&!recovery.otherWindow)void refreshRef.current();},[recovery.ready,recovery.dirty,recovery.busy,recovery.writing,recovery.otherWindow]);
  refreshRef.current=refreshPolicies;
  async function openShop() {
    const native = (window as unknown as { blackcat?: { openEbaySeller?: () => Promise<boolean> } }).blackcat;
    if (native) {
      try { if (!native.openEbaySeller || !await native.openEbaySeller()) throw new Error("Restart the updated Black Cat app and check that Google Chrome is installed."); }
      catch (error) { toast.error(error instanceof Error ? error.message : "Could not open eBay in Chrome"); return; }
    } else window.open("https://www.ebay.com/sh/ovw", "_blank", "noopener,noreferrer");
    await refreshPolicies();
  }
  if (!options) return error?<div role="alert">{error} <button className="btn" onClick={recovery.reload}>Retry eBay settings</button></div>:<p role="status">Loading eBay settings…</p>;
  return <div style={{ width: "100%", display: "grid", gap: 10, fontSize: 13 }}>
    <MarketplaceDraftNotice recovery={recovery} />
    {error&&<p role="alert" style={{color:'var(--warn)'}}>{error} Your edits are still shown.</p>}
    <p className="muted" style={{ margin: 0 }}>eBay uses the seller account signed into Google Chrome. Listings use Buy It Now with one item available.</p>
    <button className="btn" data-diagnostic-action="ebay_connect" disabled={busy} onClick={() => void openShop()} style={{ justifySelf: "start" }}>Connect eBay / open Seller Hub</button>
    <button className="btn" disabled={busy} onClick={()=>void refreshPolicies()} style={{justifySelf:'start'}}>Refresh eBay policies</button>
    {message&&<p role="status">{message}</p>}
    {catalog&&<span className="muted">Policy choices saved on {new Date(catalog.readAt).toLocaleString()}.</span>}
    <label><input type="checkbox" checked={options.enabled} disabled={busy} onChange={event => setOptions({ ...options, enabled: event.target.checked })} /> Enable eBay browser posting</label>
    <label><input type="checkbox" checked={options.generalAdRate != null} disabled={busy} onChange={event => setOptions({ ...options, generalAdRate: event.target.checked ? 2 : null })} /> Promote new eBay listings with General</label>
    {options.generalAdRate != null && <label>Fixed ad rate (%)<input className="input" type="number" min={2} max={100} step={0.1} value={options.generalAdRate} disabled={busy} onChange={event => setOptions({ ...options, generalAdRate: event.target.value === "" ? 0 : Number(event.target.value) })} /></label>}
    <span className="muted">General promotion charges this percentage of the total sale, including shipping and tax, on qualifying sales. These settings apply to new uploads.</span>
    <span className="muted">Connecting loads existing account policies. A blank field keeps eBay&apos;s selected policy automatically. Choose an override only when needed.</span>
    {([['shippingPolicyName','Shipping policy'],['returnPolicyName','Return policy'],['paymentPolicyName','Payment policy']] as const).map(([key,label]) =>
      <label key={key}>{label}<input className="input" aria-label={label} list={catalog?.policies.length?`ebay-${key}`:undefined} placeholder="Automatic — use account policy" value={options[key]} maxLength={200} disabled={busy} onChange={event => setOptions({ ...options, [key]: event.target.value })} />
        <datalist id={`ebay-${key}`}>{catalog?.policies.filter(policy=>policy.kind===EBAY_POLICY_KINDS[key]).map(policy=><option key={policy.name} value={policy.name}/>)}</datalist></label>)}
    <label><input type="checkbox" checked={!options.autoPost} disabled={busy} onChange={event => setOptions({ ...options, autoPost: !event.target.checked })} /> Fill check only — close without clicking List it</label>
    <button className="btn" data-diagnostic-action="ebay_settings_save" disabled={busy||recovery.saveDisabled} onClick={() => void save()} style={{ justifySelf: "start" }}>{busy ? "Saving…" : "Save eBay settings"}</button>
    <span className="muted">Posts through your connected Chrome account. No marketplace API key is required.</span>
  </div>;
}
