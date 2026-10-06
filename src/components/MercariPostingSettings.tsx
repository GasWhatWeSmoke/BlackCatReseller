"use client";
import { toast } from "sonner";
import { useMarketplaceDraft } from './useMarketplaceDraft';
import { MarketplaceDraftNotice } from './MarketplaceDraftNotice';
import type { MarketplaceForms } from '@/lib/marketplaceDrafts';
type Options = MarketplaceForms['mercari'];
export function MercariPostingSettings({workspace}:{workspace:string}) {
  const recovery=useMarketplaceDraft(workspace,'mercari');
  const options=recovery.form, busy=recovery.busy||!recovery.ready, error=recovery.error;
  const setOptions=recovery.change, save=recovery.save;
  async function openSeller() {
    const native = (window as unknown as { blackcat?: { openMercariSeller?: () => Promise<boolean> } }).blackcat;
    if (native) {
      try { if (!native.openMercariSeller || !await native.openMercariSeller()) throw new Error("Restart the updated Black Cat app and check that Chrome is installed."); }
      catch (error) { toast.error(error instanceof Error ? error.message : "Could not open Mercari"); }
    } else window.open("https://www.mercari.com/mypage/listings/active/", "_blank", "noopener,noreferrer");
  }
  if (!options) return error?<div role="alert">{error} <button className="btn" onClick={recovery.reload}>Retry Mercari settings</button></div>:<p role="status">Loading Mercari settings…</p>;
  return <div style={{ width: "100%", display: "grid", gap: 10, fontSize: 13 }}>
    <MarketplaceDraftNotice recovery={recovery} />
    {error&&<p role="alert" style={{color:'var(--warn)'}}>{error} Your edits are still shown.</p>}
    <p className="muted" style={{ margin: 0 }}>Mercari uses the seller account signed into Google Chrome. Reviewed prices are preserved and Smart Pricing stays off.</p>
    <button className="btn" onClick={() => void openSeller()} style={{ justifySelf: "start" }}>Open Mercari listings in Chrome</button>
    <label><input type="checkbox" checked={options.enabled} disabled={busy} onChange={event => setOptions({ ...options, enabled: event.target.checked })} /> Enable Mercari direct posting</label>
    <label htmlFor="mercari-unisex">Mercari unisex department</label><select id="mercari-unisex" className="select" value={options.unisexDepartment} disabled={busy} onChange={event => setOptions({ ...options, unisexDepartment: event.target.value as Options["unisexDepartment"] })}><option>Men</option><option>Women</option></select>
    <label htmlFor="mercari-shipping">Mercari shipping</label><select id="mercari-shipping" className="select" value={options.shippingMode} disabled={busy} onChange={event => setOptions({ ...options, shippingMode: event.target.value as Options["shippingMode"] })}>
      <option value="buyer_label">Buyer-paid Mercari label</option><option value="ship_on_own">Ship on my own · seller pays postage</option>
    </select>
    <span className="muted">Uses your saved Mercari ship-from ZIP in Settings → Shipping. Labels are selected from eligible parcel quotes shown for the package.</span>
    <label><input type="checkbox" checked={!options.autoPost} disabled={busy} onChange={event => setOptions({ ...options, autoPost: !event.target.checked })} /> Mercari fill check only</label>
    <button className="btn" disabled={recovery.saveDisabled} onClick={() => void save()} style={{ justifySelf: "start" }}>{busy ? "Saving…" : "Save Mercari settings"}</button>
    <span className="muted">Posts through your connected browser account. No marketplace API key is required.</span>
  </div>;
}
