"use client";
import type { MarketplaceRecovery } from './useMarketplaceDraft';
import { marketplaceDraftLabels, type MarketplaceValue } from '@/lib/marketplaceDrafts';
const display=(field:string,value:MarketplaceValue|undefined)=>field==='generalAdRate'&&value==null?'Promotion off':value==null||value===''?'Not set':typeof value==='boolean'?value?'On':'Off'
  :field==='generalAdRate'?`${value}%`:value==='buyer_label'?'Buyer-paid label':value==='ship_on_own'?'Seller pays postage':String(value);
export function MarketplaceDraftNotice({recovery:r}:{recovery:MarketplaceRecovery}) {
  if(!r.dirty&&!r.storageError&&!r.otherWindow&&!r.writing)return null;
  return <section aria-label={`${r.name} draft`} className="card" style={{padding:12,width:'100%',fontSize:12,overflowWrap:'anywhere'}}>
    <p role="status" style={{marginTop:0}}>{r.writing?'Keeping this draft on this device…':r.dirty?`Unsaved ${r.name}. Use this section’s Save button to apply changes.`:'Local draft recovery needs attention.'}</p>
    {r.dirty&&!r.storageError&&!r.writing&&<p className="muted">Draft kept in this workspace. Restoring it does not apply posting, promotion or renewal changes.</p>}
    {r.storageError&&<p role="alert" style={{color:'var(--warn)'}}>{r.storageError}</p>}
    {r.storageError&&r.dirty&&<p>Save these preferences before leaving to keep the edits shown here.</p>}
    {!!r.conflicts.length&&!r.otherWindow&&<>
      <p>Saved preferences changed since this draft started. Review the differences before saving.</p>
      {r.conflicts.map(field=><details key={field}><summary>{marketplaceDraftLabels[field]}</summary>
        <p>Currently saved: <span style={{whiteSpace:'pre-wrap'}}>{display(field,r.saved?.[field])}</span></p>
        <p>Recovered draft: <span style={{whiteSpace:'pre-wrap'}}>{display(field,r.draft?.changes[field])}</span></p>
      </details>)}
    </>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:10}}>
      {r.otherWindow?<>
        <button type="button" className="btn" disabled={r.busy} onClick={()=>{if(confirm('Replace the shared local draft with this window’s edits? Nothing is applied until Save.'))void r.resolve('keepMine');}}>Keep this window’s draft</button>
        <button type="button" className="btn" disabled={r.busy} onClick={()=>{if(confirm('Replace this form’s unsaved edits with the other window’s draft?'))void r.resolve('useOther');}}>Use the other window’s draft</button>
      </>:<>
        {!!r.conflicts.length&&<button type="button" className="btn" disabled={r.busy} onClick={()=>void r.resolve('keepRecovered')}>Keep recovered edits for review</button>}
        {r.dirty&&<button type="button" className="btn" disabled={r.busy} onClick={()=>{if(confirm('Discard these unsaved marketplace preferences? Saved preferences will not change.'))void r.resolve('discard');}}>Discard unsaved preferences</button>}
      </>}
    </div>
  </section>;
}
