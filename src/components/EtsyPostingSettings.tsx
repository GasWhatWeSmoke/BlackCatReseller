"use client";
import { toast } from "sonner";
import { useMarketplaceDraft } from './useMarketplaceDraft';
import { MarketplaceDraftNotice } from './MarketplaceDraftNotice';
export function EtsyPostingSettings({workspace}:{workspace:string}) {
  const recovery=useMarketplaceDraft(workspace,'etsy');
  const options=recovery.form, busy=recovery.busy||!recovery.ready, error=recovery.error;
  const setOptions=recovery.change, save=recovery.save;
  async function openShop() {
    const url = "https://www.etsy.com/your/shops/me/dashboard";
    const native = (window as unknown as { blackcat?: { openEtsySeller?: () => Promise<boolean> } }).blackcat;
    if (native) {
      try {
        if (!native.openEtsySeller || !await native.openEtsySeller()) throw new Error("Restart the updated Black Cat app and check that Google Chrome is installed.");
      } catch (error) { toast.error(error instanceof Error ? error.message : "Could not open Etsy in Chrome"); }
    } else window.open(url, "_blank", "noopener,noreferrer");
  }
  if (!options) return error?<div role="alert">{error} <button className="btn" onClick={recovery.reload}>Retry Etsy settings</button></div>:<p role="status">Loading Etsy settings…</p>;
  return <div style={{ width: "100%", display: "grid", gap: 10, fontSize: 13 }}>
    <MarketplaceDraftNotice recovery={recovery} />
    {error&&<p role="alert" style={{color:'var(--warn)'}}>{error} Your edits are still shown.</p>}
    <p className="muted" style={{ margin: 0 }}>Etsy uses the seller account signed into Google Chrome. Keep Chrome open while Black Cat posts.</p>
    <button className="btn" type="button" onClick={() => void openShop()} style={{ justifySelf: "start" }}>Open Etsy Shop Manager in Chrome</button>
    <label><input type="checkbox" checked={options.enabled} disabled={busy} onChange={event => setOptions({ ...options, enabled: event.target.checked })} /> Enable Etsy direct posting</label>
    <label>Existing shipping profile <input className="input" value={options.shippingProfileName} disabled={busy} maxLength={200}
      onChange={event => setOptions({ ...options, shippingProfileName: event.target.value })} placeholder="Profile name from Etsy" /></label>
    <span className="muted">Uses your shop’s selected processing and return policies. Resale items need reviewed True Vintage details.</span>
    <label><input type="checkbox" checked={options.autoRenew} disabled={busy} onChange={event => setOptions({ ...options, autoRenew: event.target.checked })} /> Automatically renew expired listings every four months</label>
    <span className="muted">Etsy charges $0.20 per new listing and per automatic renewal. With renewal off, you renew expired listings manually.</span>
    <label><input type="checkbox" checked={!options.autoPost} disabled={busy} onChange={event => setOptions({ ...options, autoPost: !event.target.checked })} /> Fill check only — close without clicking Publish</label>
    <button className="btn" type="button" disabled={recovery.saveDisabled} onClick={() => void save()} style={{ justifySelf: "start" }}>{busy ? "Saving…" : "Save Etsy settings"}</button>
    <span className="muted">Posting uses your reviewed details and saved marketplace preferences.</span>
  </div>;
}
