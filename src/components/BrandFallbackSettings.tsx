"use client";
import { useMarketplaceDraft } from './useMarketplaceDraft';
import { MarketplaceDraftNotice } from './MarketplaceDraftNotice';
export default function BrandFallbackSettings({marketplace,workspace}:{marketplace:'depop'|'mercari';workspace:string}) {
  const recovery=useMarketplaceDraft(workspace,marketplace==='depop'?'depopBrands':'mercariBrands');
  const text=recovery.form?.brands??null,busy=recovery.busy||!recovery.ready,error=recovery.error;
  if(text===null)return error?<div role="alert">{error} <button className="btn" onClick={recovery.reload}>Retry {marketplace} brand preferences</button></div>:<p>Loading brand preferences...</p>;
  return <details style={{width:'100%',fontSize:12,borderTop:'1px solid var(--border)',paddingTop:12}}>
    <summary style={{cursor:'pointer',fontWeight:700}}>Brands allowed to use “Other”</summary>
    <MarketplaceDraftNotice recovery={recovery} />
    {error&&<p role="alert" style={{color:'var(--warn)'}}>{error} Your edits are still shown.</p>}
    <p className="muted" style={{lineHeight:1.6}}>Confirm the real brand on the item first. If this marketplace does not offer it, its brand selector may use Other while the title and description keep the real brand. Enter one brand per line.</p>
    <textarea className="input" rows={4} aria-label={`${marketplace} brands allowed to use Other`} value={text} disabled={busy} onChange={event=>recovery.change({brands:event.target.value})}/>
    <button className="btn" style={{marginTop:8}} disabled={recovery.saveDisabled} onClick={()=>void recovery.save()}>{busy?'Saving…':'Save brand preferences'}</button>
  </details>;
}
