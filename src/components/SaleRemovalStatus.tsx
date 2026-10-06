"use client";

import { useRef, useState } from "react";
import { usePolledRead } from './usePolledRead';
import { validRemovalReview, type RemovalReview, type RemovalReviewAction } from '@/lib/publish/removalRecovery';

interface RemovalStatus {
  active: boolean;
  lastError: string | null;
  lastFinishedAt: string | null;
  waitingForBrowser: boolean;
  backlog: { id: number; itemId: number; marketplace: string; status: string; externalUrl: string | null;
    externalListingId: string | null; attemptCount: number; updatedAt: string;
    lastError: string | null; supported: boolean; item: { sku: string; updatedAt: string } }[];
}

function reviewSnapshot(row: RemovalStatus['backlog'][number]): RemovalReview | null {
  const value = { id: row.id, itemId: row.itemId, sku: row.item.sku, marketplace: row.marketplace,
    status: row.status, externalListingId: row.externalListingId, externalUrl: row.externalUrl,
    attemptCount: row.attemptCount, updatedAt: row.updatedAt, itemUpdatedAt: row.item.updatedAt };
  return validRemovalReview(value) ? value : null;
}

const statusLabel: Record<string, string> = {
  delist_pending: "Waiting for removal", delisting: "Checking and removing",
  delist_unknown: "Availability needs verification", delist_failed: "Needs review",
};
async function readRemovals(signal: AbortSignal): Promise<RemovalStatus> {
  const response=await fetch('/api/publish/removals',{cache:'no-store',signal});
  if(!response.ok)throw new Error('Could not load pending removals. Refresh to confirm their status.');
  const data=await response.json();
  const text = (value: unknown) => value === null || typeof value === 'string';
  if(typeof data?.active!=='boolean'||typeof data.waitingForBrowser!=='boolean'||!text(data.lastError)||!text(data.lastFinishedAt)||
    !Array.isArray(data.backlog)||data.backlog.some((row:RemovalStatus['backlog'][number])=>
    !row||!Number.isSafeInteger(row.id)||row.id<1||!Number.isSafeInteger(row.itemId)||row.itemId<1||
    typeof row.item?.sku!=='string'||typeof row.supported!=='boolean'||typeof row.marketplace!=='string'||typeof row.status!=='string'||
    !text(row.externalListingId)||!text(row.externalUrl)||!text(row.lastError)||!Number.isSafeInteger(row.attemptCount)||row.attemptCount<0||
    typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.updatedAt))||typeof row.item.updatedAt!=='string'||!Number.isFinite(Date.parse(row.item.updatedAt)))||
    new Set(data.backlog.map((row:RemovalStatus['backlog'][number])=>row.id)).size!==data.backlog.length)
    throw new Error('Pending removals returned incomplete information. Refresh before processing.');
  return data;
}

export function SaleRemovalStatus() {
  const view=usePolledRead(readRemovals,data=>data?.active?2500:15000);
  const {data:status,error,load}=view;
  const [actionError,setActionError]=useState<string|null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startingRef=useRef(false);

  async function review(row: RemovalStatus['backlog'][number], action: RemovalReviewAction) {
    const listing = reviewSnapshot(row);
    if (!listing || startingRef.current || !view.isFresh() || status?.active ||
      action === 'retry_removal' && (!row.supported || row.status !== 'delist_failed')) return;
    startingRef.current = true; setStarting(true); setActionError(null); setNotice(null);
    try {
      const prompt = action === 'retry_removal'
        ? 'Retry removal after fixing the reported cause? Black Cat will inspect this exact listing before acting. This does not republish the item.'
        : 'Confirm you removed this exact listing or made it unavailable on the marketplace. This records your confirmation; it does not remove a live listing or perform an automatic check.';
      if (!confirm(`${prompt}\n\nSKU ${listing.sku} · ${listing.marketplace}\n${listing.externalUrl}`)) return;
      view.invalidate();
      const response = await fetch('/api/publish/removals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirmed: true, listing }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw Error(result?.error || 'The removal review could not be saved. Refresh before trying again.');
      if (result?.ok !== true || result.listingId !== row.id || result.action !== action ||
        result.status !== (action === 'retry_removal' ? 'delist_pending' : 'ended'))
        throw Error('The removal review outcome is unconfirmed. Refresh and inspect the listing before another action.');
      setNotice(action === 'retry_removal' ? `Removal retry queued for ${row.item.sku} on ${row.marketplace}; availability still needs verification.`
        : `Manual removal recorded for ${row.item.sku} on ${row.marketplace}. Your confirmation is saved in its audit record.`);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Removal review failed. Refresh before trying again.'); }
    finally { await load(); startingRef.current = false; setStarting(false); }
  }

  async function processPending() {
    if(startingRef.current||!view.isFresh()||status?.active||!canProcess)return;
    startingRef.current=true;setStarting(true);setActionError(null);view.invalidate();
    try {
      const response = await fetch("/api/publish/removals", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process" }) });
      const result=await response.json().catch(()=>null);
      if (!response.ok||result?.ok!==true||typeof result.started!=='boolean') throw new Error("Could not confirm whether removals started. Refresh before trying again.");
    } catch (error) { setActionError(error instanceof Error ? error.message : "Could not start removals."); }
    finally { await load();startingRef.current=false;setStarting(false); }
  }

  const canProcess = status?.backlog.some((row) => row.supported && ["delist_pending", "delist_unknown", "delisting"].includes(row.status));
  return <section className="card hub-monitor" style={{ padding: 22 }} aria-label="Sale removals">
    <h3 style={{ marginTop: 0 }}>Sale removals</h3>
    <p>After a confirmed sale, the other listings linked to Black Cat appear here until their removal is verified.
      Any listing that needs your attention stays visible with its reason.</p>
    {(error || actionError || status?.lastError) && <p role="alert">{error || actionError || status?.lastError}</p>}
    {notice && <p role="status">{notice}</p>}
    {status&&!view.fresh&&<p role="status">Showing the last loaded removal status until it can be refreshed.</p>}
    {status?.waitingForBrowser && <p>The browser was busy. Wait for the current upload or login to finish, then try again.</p>}
    {!status ? <p>{error?'Pending removals are unavailable.':'Loading removals…'}</p> : status.backlog.length === 0 ? view.fresh && <p>No pending removals recorded.</p> : <ul>
      {status.backlog.map((row) => <li key={row.id} style={{ marginBottom: 16, overflowWrap: 'anywhere' }}>
        <strong>{row.item.sku}</strong> · {row.marketplace} · {statusLabel[row.status] ?? "Listing needs verification"}
        {!row.supported && " · Remove manually until this platform is supported"}
        {row.lastError && <div>{row.lastError}</div>}
        {row.externalUrl && <p className="muted" style={{ fontSize: 12 }}>{row.externalUrl}</p>}
        {reviewSnapshot(row) ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {row.supported && row.status === 'delist_failed' && <button type="button" className="btn" disabled={!view.fresh || starting || status.active}
            onClick={() => void review(row, 'retry_removal')} aria-label={`Retry ${row.marketplace} removal for ${row.item.sku}`}>Retry removal</button>}
          <button type="button" className="btn" disabled={!view.fresh || starting || status.active}
            onClick={() => void review(row, 'confirm_manual_removal')} aria-label={`Confirm manual ${row.marketplace} removal for ${row.item.sku}`}>I removed this listing</button>
        </div> : row.status !== 'delisting' && <p className="muted">Verify this listing&apos;s saved identity before recording removal.</p>}
      </li>)}
    </ul>}
    <button type="button" className="btn" disabled={starting} onClick={()=>void load()}>Refresh removals</button>
    {!!status?.backlog.length&&<button type="button" className="btn" disabled={!view.fresh || !canProcess || starting || status?.active}
      onClick={() => void processPending()}>
      {status?.active ? "Processing removals…" : "Process queued removals"}
    </button>}
  </section>;
}
