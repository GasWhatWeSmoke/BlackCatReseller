"use client";
import { toast } from "sonner";
import { useMarketplaceDraft } from './useMarketplaceDraft';
import { MarketplaceDraftNotice } from './MarketplaceDraftNotice';
export function EbayPostingSettings({workspace}:{workspace:string}) {
  const recovery=useMarketplaceDraft(workspace,'ebayBrowser');
  const options=recovery.form, busy=recovery.busy||!recovery.ready, error=recovery.error;
  const setOptions=recovery.change, save=recovery.save;
  async function openShop() {
    const native = (window as unknown as { blackcat?: { openEbaySeller?: () => Promise<boolean> } }).blackcat;
    if (native) {
      try { if (!native.openEbaySeller || !await native.openEbaySeller()) throw new Error("Restart the updated Black Cat app and check that Google Chrome is installed."); }
      catch (error) { toast.error(error instanceof Error ? error.message : "Could not open eBay in Chrome"); }
    } else window.open("https://www.ebay.com/sh/ovw", "_blank", "noopener,noreferrer");
  }
  if (!options) return error?<div role="alert">{error} <button className="btn" onClick={recovery.reload}>Retry eBay settings</button></div>:<p role="status">Loading eBay settings…</p>;
  return <div style={{ width: "100%", display: "grid", gap: 10, fontSize: 13 }}>
    <MarketplaceDraftNotice recovery={recovery} />
    {error&&<p role="alert" style={{color:'var(--warn)'}}>{error} Your edits are still shown.</p>}
    <p className="muted" style={{ margin: 0 }}>eBay uses the seller account signed into Google Chrome. Listings use Buy It Now with one item available.</p>
    <button className="btn" onClick={() => void openShop()} style={{ justifySelf: "start" }}>Open eBay Seller Hub in Chrome</button>
    <label><input type="checkbox" checked={options.enabled} disabled={busy} onChange={event => setOptions({ ...options, enabled: event.target.checked })} /> Enable eBay browser posting</label>
    <label><input type="checkbox" checked={options.generalAdRate != null} disabled={busy} onChange={event => setOptions({ ...options, generalAdRate: event.target.checked ? 2 : null })} /> Promote new eBay listings with General</label>
    {options.generalAdRate != null && <label>Fixed ad rate (%)<input className="input" type="number" min={2} max={100} step={0.1} value={options.generalAdRate} disabled={busy} onChange={event => setOptions({ ...options, generalAdRate: event.target.value === "" ? 0 : Number(event.target.value) })} /></label>}
    <span className="muted">General promotion charges this percentage of the total sale, including shipping and tax, on qualifying sales. These settings apply to new uploads.</span>
    <span className="muted">Leave policy names blank to keep the policies selected in eBay, or enter an existing policy name.</span>
    {([['shippingPolicyName','Shipping policy'],['returnPolicyName','Return policy'],['paymentPolicyName','Payment policy']] as const).map(([key,label]) =>
      <label key={key}>{label}<input className="input" value={options[key]} maxLength={200} disabled={busy} onChange={event => setOptions({ ...options, [key]: event.target.value })} /></label>)}
    <label><input type="checkbox" checked={!options.autoPost} disabled={busy} onChange={event => setOptions({ ...options, autoPost: !event.target.checked })} /> Fill check only — close without clicking List it</label>
    <button className="btn" disabled={recovery.saveDisabled} onClick={() => void save()} style={{ justifySelf: "start" }}>{busy ? "Saving…" : "Save eBay settings"}</button>
    <span className="muted">Posts through your connected Chrome account. No marketplace API key is required.</span>
  </div>;
}
