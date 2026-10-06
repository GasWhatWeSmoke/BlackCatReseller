"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { EtsyPostingSettings } from "./EtsyPostingSettings";
import { EbayPostingSettings } from "./EbayPostingSettings";
import { MercariPostingSettings } from "./MercariPostingSettings";
import BrandFallbackSettings from './BrandFallbackSettings';
import { usePolledRead } from './usePolledRead';

interface Account {
  marketplace: string; name: string; loggedIn: boolean; loginInProgress: boolean;
  awaitingConfirmation: boolean; error: string | null;
}
function postingPreferences(value: any) {
  if(!value||[value.poshmark,value.depop].some(option=>!option||typeof option.enabled!=='boolean'||typeof option.autoPost!=='boolean')
    ||typeof value.depop.boostListings!=='boolean'||!['preserve_marketplace','reviewed'].includes(value.relistPricing))
    throw new Error('Saved posting preferences could not be confirmed.');
  return value;
}
async function readAccounts(signal:AbortSignal):Promise<Account[]> {
  const response=await fetch('/api/publish/accounts',{signal,cache:'no-store'});
  if(!response.ok)throw new Error('Could not load marketplace connections. Refresh before opening a login.');
  const data=await response.json();
  if(!Array.isArray(data?.accounts)||data.accounts.some((a:Account)=>!a||typeof a.marketplace!=='string'||typeof a.name!=='string'
    ||typeof a.loggedIn!=='boolean'||typeof a.loginInProgress!=='boolean'||typeof a.awaitingConfirmation!=='boolean'))
    throw new Error('Marketplace connection information is incomplete. Refresh before opening a login.');
  return data.accounts;
}

export function MarketplaceAccounts({workspace}:{workspace:string}) {
  const accountView=usePolledRead(readAccounts,3000);
  const accounts=accountView.data ?? [], error=accountView.error;
  const load=accountView.load;
  const [busy, setBusy] = useState(false);
  const commandBusy=useRef(false);
  const [saveError,setSaveError]=useState<string|null>(null);
  const [postingError,setPostingError]=useState<string|null>(null),[postingAttempt,setPostingAttempt]=useState(0);
  const [poshmark, setPoshmark] = useState<{ enabled: boolean; autoPost: boolean } | null>(null);
  const [depop, setDepop] = useState<{ enabled: boolean; autoPost: boolean; boostListings?: boolean } | null>(null);
  const [keepRelistPrices, setKeepRelistPrices] = useState<boolean | null>(null);
  useEffect(() => {
    const controller=new AbortController();setPostingError(null);
    fetch("/api/publish/settings",{signal:controller.signal,cache:'no-store'}).then((response) => {
      if (!response.ok) throw new Error("Could not load direct posting settings.");
      return response.json();
    }).then((result) => {
      const publish=postingPreferences(result.publish);
      if(controller.signal.aborted)return;
      setPoshmark(publish.poshmark);setDepop(publish.depop);
      setKeepRelistPrices(publish.relistPricing === "preserve_marketplace");
    })
      .catch((error) => {if(!controller.signal.aborted)setPostingError(error.message);});
    return()=>controller.abort();
  }, [postingAttempt]);
  const loginOpen = accounts.some((account) => account.loginInProgress);

  async function configureRelistPrices(keep: boolean) {
    if (commandBusy.current) return;
    const previous = keepRelistPrices;
    commandBusy.current=true;setBusy(true);setSaveError(null);setKeepRelistPrices(keep);
    try {
      const response = await fetch("/api/publish/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ relistPricing: keep ? "preserve_marketplace" : "reviewed" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save relisting prices.");
      setKeepRelistPrices(postingPreferences(result.publish).relistPricing === "preserve_marketplace");
      toast.success("Relisting prices saved");
    } catch (error) {
      setKeepRelistPrices(previous);
      const message=error instanceof Error ? error.message : "Could not save relisting prices.";setSaveError(message);toast.error(message);
    } finally { commandBusy.current=false;setBusy(false); }
  }

  async function configure(marketplace: "depop" | "poshmark", patch: Partial<{ enabled: boolean; autoPost: boolean; boostListings: boolean }>) {
    if (commandBusy.current) return;
    const previous = marketplace === "depop" ? depop : poshmark;
    if (!previous) return;
    const setOptions = marketplace === "depop" ? setDepop : setPoshmark;
    setOptions({ ...previous, ...patch });
    commandBusy.current=true;setBusy(true);setSaveError(null);
    try {
      const response = await fetch("/api/publish/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [marketplace]: patch }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save marketplace settings.");
      const confirmed=postingPreferences(result.publish);
      if (marketplace === "depop") setDepop(confirmed.depop);
      else setPoshmark(confirmed.poshmark);
    } catch (error) {
      setOptions(previous);
      const message=error instanceof Error ? error.message : "Could not save marketplace settings.";setSaveError(message);toast.error(message);
    }
    finally { commandBusy.current=false;setBusy(false); }
  }

  async function connect(account: Account, reopen = false) {
    if (commandBusy.current || !accountView.isFresh()) return;
    commandBusy.current=true;setBusy(true);accountView.invalidate();
    try {
      const confirming = account.awaitingConfirmation && !reopen;
      const response = await fetch(`/api/publish/accounts/${account.marketplace}/login`, {
        method: confirming ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        ...(confirming ? { body: JSON.stringify({ confirmed: true }) } : {}),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not connect the account.");
      toast.success(confirming ? `${account.name} linked.` : `${account.name} opened in Chrome. Sign in, then close that window.`);
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not connect the account."); }
    finally { commandBusy.current=false;setBusy(false); }
  }

  return <section id="marketplace-accounts" className="card" style={{ padding: 16, marginBottom: 16 }}>
    <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Marketplace accounts</h2>
    <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
      Connect each marketplace below for browser publishing and sales checks. Saved sign-ins can expire; Black Cat checks access when a task starts.
    </p>
    {error && <p role="alert">{error} <button className="btn" onClick={()=>void load()}>Refresh connections</button></p>}
    {!accountView.data&&!error&&<p role="status">Loading marketplace connections…</p>}
    {accountView.fresh&&!accounts.length&&<p>Marketplace connection information is empty. <button className="btn" onClick={()=>void load()}>Refresh connections</button></p>}
    {postingError&&<p role="alert">{postingError} <button className="btn" onClick={()=>setPostingAttempt(value=>value+1)}>Retry posting preferences</button></p>}
    {saveError&&<p role="alert">{saveError} Saving has not been confirmed. The last confirmed preference is shown.</p>}
    {keepRelistPrices !== null && <div style={{ marginBottom: 14, fontSize: 13 }}>
      <label><input type="checkbox" checked={keepRelistPrices} disabled={busy} onChange={event => void configureRelistPrices(event.target.checked)} /> Keep saved marketplace prices when relisting</label>
      <p className="muted" style={{ margin: "5px 0 0" }}>Uses each platform's previous recorded price for replacement listings. New items use their reviewed price.</p>
    </div>}
    {accounts.map((account) => <details key={account.marketplace} className="market-account">
      <summary>
      <strong style={{ width: 80 }}>{account.name}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{["etsy", "ebay", "mercari"].includes(account.marketplace) ? "Uses your selling Chrome account" : account.loginInProgress ? "Finish signing in in Chrome" : account.awaitingConfirmation ? "Waiting for your confirmation" : account.loggedIn ? "Linked" : "Not linked"}</span>
      </summary><div className="market-account-body">
      {!["etsy", "ebay", "mercari"].includes(account.marketplace) && <button className="btn" style={{ marginLeft: "auto" }} disabled={busy || loginOpen || !accountView.fresh}
        onClick={() => void connect(account)}>
        {account.loginInProgress ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
        {account.loginInProgress ? "Login open" : account.awaitingConfirmation ? `I'm logged in to ${account.name}` : account.loggedIn ? `Re-link ${account.name}` : `Link ${account.name}`}
      </button>}
      {!["etsy", "ebay", "mercari"].includes(account.marketplace) && account.awaitingConfirmation && <button className="btn" disabled={busy || loginOpen || !accountView.fresh} onClick={() => void connect(account, true)}>Reopen login</button>}
      {account.marketplace === "etsy" && <EtsyPostingSettings workspace={workspace} />}
      {account.marketplace === "ebay" && <EbayPostingSettings workspace={workspace} />}
      {account.marketplace === "mercari" && <MercariPostingSettings workspace={workspace} />}
      {(account.marketplace==='depop'||account.marketplace==='mercari')&&<BrandFallbackSettings marketplace={account.marketplace} workspace={workspace}/>}
      {account.marketplace === "depop" && depop && <div style={{ width: "100%", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
        <label><input type="checkbox" checked={depop.enabled} disabled={busy || loginOpen} onChange={(event) => void configure("depop", { enabled: event.target.checked })} /> Enable Depop direct posting</label>
        <label><input type="checkbox" checked={!depop.autoPost} disabled={busy || loginOpen} onChange={(event) => void configure("depop", { autoPost: !event.target.checked })} /> Fill check only</label>
        <label><input type="checkbox" checked={depop.boostListings ?? false} disabled={busy || loginOpen} onChange={(event) => void configure("depop", { boostListings: event.target.checked })} /> Boost new Depop listings — 12% fee on qualifying sales</label>
        <span className="muted">Unisex items use Men. With fill check off, Black Cat publishes while you watch.</span>
      </div>}
      {account.marketplace === "poshmark" && poshmark && <div style={{ width: "100%", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
        <label><input type="checkbox" checked={poshmark.enabled} disabled={busy || loginOpen} onChange={(event) => void configure("poshmark", { enabled: event.target.checked })} /> Enable Poshmark direct posting</label>
        <label title="When checked, fills the final review screen and closes without publishing."><input type="checkbox" checked={!poshmark.autoPost} disabled={busy || loginOpen} onChange={(event) => void configure("poshmark", { autoPost: !event.target.checked })} /> Fill check only</label>
        <span className="muted">Unisex items use Women. Prices round to the nearest dollar; 50 cents rounds up.</span>

      </div>}
      {!["etsy", "ebay", "mercari"].includes(account.marketplace) && account.error && <span role="alert" style={{ width: "100%", color: "var(--danger)" }}>{account.error}</span>}
    </div></details>)}
  </section>;
}
