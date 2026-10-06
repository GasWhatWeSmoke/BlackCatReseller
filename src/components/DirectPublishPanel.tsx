"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, CheckCheck, Loader2, PackageOpen, Play, RefreshCw } from "lucide-react";
import { RUN_ACTIVE, type EligibleItem, type StatusPayload, type ReviewPendingItem, type EligibilityPage } from "@/lib/publish/uiTypes";
import DirectUploadProgress from "./DirectUploadProgress";
import { PackageDetailsNote } from './PackageDetailsNote';
import { eligibilityView, eligibilityQueryString, selectedPlatformWarnings, queueAutoState, type QueueAutoState } from '@/lib/publish/eligibilityView';
import styles from "@/app/ready/upload.module.css";

export default function DirectPublishPanel() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [eligible, setEligible] = useState<EligibleItem[]>([]);
  const [awaitingReview, setAwaitingReview] = useState<ReviewPendingItem[]>([]);
  const [auto, setAuto] = useState<QueueAutoState | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const initializedTargets = useRef(false);
  const activeRead = useRef<AbortController | null>(null), readVersion = useRef(0), mounted = useRef(true);
  const changingAuto = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targets, setTargets] = useState(new Set(["depop", "ebay", "etsy", "poshmark", "mercari"]));
  const [starting, setStarting] = useState(false);
  const submitting = useRef(false);
  const [autoUncertain, setAutoUncertain] = useState(false);
  const [pageNumber, setPageNumber] = useState(1), [pageSize, setPageSize] = useState(100);
  const [search, setSearch] = useState(''), [searchTerm, setSearchTerm] = useState('');
  const [pageDetails, setPageDetails] = useState<Pick<EligibilityPage, 'pagination' | 'counts'> | null>(null);
  const queueItems = useRef<HTMLDivElement>(null);
  const displayedPage = pageDetails ? eligibilityQueryString(pageDetails.pagination) : '';
  useEffect(() => { if (queueItems.current) queueItems.current.scrollTop = 0; }, [displayedPage]);
  const targetsKey = JSON.stringify([...targets].sort()), searchPending = search.trim() !== searchTerm;
  useEffect(() => {
    if (search.trim() === searchTerm) return;
    const timer = setTimeout(() => { setSearchTerm(search.trim()); setPageNumber(1); setSelected(new Set()); }, 250);
    return () => clearTimeout(timer);
  }, [search, searchTerm]);

  const invalidateRead = useCallback(() => { readVersion.current++; activeRead.current?.abort(); activeRead.current = null; }, []);
  const load = useCallback(async (replace = false) => {
    if (!mounted.current) return;
    if (activeRead.current && !replace) return;
    activeRead.current?.abort();
    const controller = new AbortController(), version = ++readVersion.current;
    activeRead.current = controller;
    setLoading(true);
    try {
      const responses = await Promise.all(['/api/publish/status', '/api/publish/auto-run'].map(url => fetch(url, { signal: controller.signal, cache: 'no-store' })));
      if (responses.some(response => !response.ok)) throw new Error("Could not load your crosslisting queue. Refresh to try again.");
      const [nextStatus, rawAuto] = await Promise.all(responses.map(response => response.json().catch(() => null)));
      const nextAuto = queueAutoState(rawAuto);
      if (!Array.isArray(nextStatus?.marketplaces) || nextStatus.marketplaces.some((platform: { id: string; name: string; configured: boolean; implemented: boolean; reason?: unknown }) =>
        !platform || typeof platform.id !== 'string' || typeof platform.name !== 'string' || typeof platform.configured !== 'boolean' || typeof platform.implemented !== 'boolean'
        || platform.reason !== undefined && platform.reason !== null && typeof platform.reason !== 'string')
        || nextStatus.run === undefined || nextStatus.run !== null && (!Number.isSafeInteger(nextStatus.run.id) || typeof nextStatus.run.status !== 'string'))
        throw new Error("The crosslisting queue returned an incomplete response. Refresh to try again.");
      const requestedTargets: string[] = !initializedTargets.current || nextAuto.config.enabled ? nextAuto.config.marketplaces : JSON.parse(targetsKey);
      const requested = { page: pageNumber, pageSize, q: searchTerm, marketplaces: requestedTargets.filter(id =>
        nextStatus.marketplaces.some((platform: { id: string; configured: boolean; implemented: boolean }) => platform.id === id && platform.configured && platform.implemented)).sort() };
      const response = await fetch(`/api/publish/eligible?${eligibilityQueryString(requested)}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw Error('Could not load this queue page. Refresh to try again.');
      const nextEligible = eligibilityView(await response.json());
      const served = nextEligible.pagination;
      if (served.q !== requested.q || served.pageSize !== requested.pageSize || served.marketplaces.join() !== requested.marketplaces.join() ||
        served.page !== Math.min(requested.page, served.pages)) throw Error('The queue page does not match this selection. Refresh before publishing.');
      if (!mounted.current || controller.signal.aborted || version !== readVersion.current) return;
      setStatus(nextStatus); setEligible(nextEligible.items); setAwaitingReview(nextEligible.awaitingReview);
      setPageDetails({ counts: nextEligible.counts, pagination: served }); setPageNumber(served.page);
      setAuto(nextAuto);
      setAutoUncertain(false);
      if (!initializedTargets.current || nextAuto.config.enabled) {
        setTargets(new Set(nextAuto.config.marketplaces)); initializedTargets.current = true;
      }
      const readyIds = new Set(nextEligible.items.filter((item: EligibleItem) => item.ready).map((item: EligibleItem) => item.id));
      setSelected(previous => new Set([...previous].filter(id => readyIds.has(id))));
      setError(null);
    } catch (error) { if (mounted.current && !controller.signal.aborted && version === readVersion.current) setError(error instanceof Error ? error.message : "Could not load the crosslisting queue."); }
    finally { if (activeRead.current === controller) { activeRead.current = null; if (mounted.current) setLoading(false); } }
  }, [pageNumber, pageSize, searchTerm, targetsKey]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { void load(true); };
    const timer = setInterval(() => { if (!changingAuto.current && !submitting.current) void load(); }, 10000);
    window.addEventListener("focus", refresh);
    window.addEventListener("blackcat:intake-updated", refresh);
    return () => { mounted.current = false; invalidateRead(); clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("blackcat:intake-updated", refresh); };
  }, [load, invalidateRead]);

  const marketplaces = (status?.marketplaces ?? []).filter(m => m.implemented);
  const chosenPlatforms = marketplaces.filter(m => m.configured && targets.has(m.id));
  const pageCurrent = !!pageDetails && pageDetails.pagination.page === pageNumber && pageDetails.pagination.pageSize === pageSize &&
    pageDetails.pagination.q === searchTerm && pageDetails.pagination.marketplaces.join() === chosenPlatforms.map(m => m.id).sort().join();
  const pendingItems = eligible.filter(item => chosenPlatforms.some(m => (!item.applicableOn || item.applicableOn.includes(m.id)) && !item.publishedOn.includes(m.id)));
  const readyItems = pendingItems.filter(item => item.ready);
  const selectedItems = readyItems.filter(item => selected.has(item.id));
  const runActive = !!status?.run && RUN_ACTIVE.has(status.run.status);
  const autoEnabled = auto?.config.enabled === true;
  const warnings = new Map(pendingItems.map(item => [item.id, selectedPlatformWarnings(item, chosenPlatforms)]));
  const warningItems = pendingItems.filter(item => warnings.get(item.id)?.length);
  const selectedWarningTargets = selectedItems.reduce((total, item) => total + new Set((warnings.get(item.id) ?? []).map(warning => warning.marketplace)).size, 0);

  async function toggleAuto() {
    if (!auto || changingAuto.current || (!autoEnabled && (!chosenPlatforms.length || !!error || autoUncertain))) return;
    changingAuto.current = true; setAutoSaving(true);
    invalidateRead(); setLoading(false); setAutoUncertain(true);
    const enabled = !autoEnabled, requestedMarketplaces = autoEnabled ? auto.config.marketplaces : chosenPlatforms.map(m => m.id);
    try {
      const response = await fetch("/api/publish/auto-run", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, marketplaces: requestedMarketplaces }) });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true || result.config?.enabled !== enabled || !Array.isArray(result.config.marketplaces)
        || JSON.stringify([...result.config.marketplaces].sort()) !== JSON.stringify([...requestedMarketplaces].sort()) || typeof result.state !== 'string')
        throw new Error(result?.error || "Auto Run's saved setting could not be confirmed. Refresh the queue before trying again.");
      const confirmed = queueAutoState(result);
      setAuto(confirmed); setTargets(new Set(confirmed.config.marketplaces));
      setAutoUncertain(false);
      toast.success(result.config.enabled ? "Auto Run is watching for approved Ready items." : result.config.pausedRunId ? "Auto Run stopped. Its current batch is paused." : "Auto Run is off. New Ready items will stay in the queue.");
      await load(true);
    } catch (error) { setAutoUncertain(true); toast.error(error instanceof Error ? error.message : "Could not change Auto Run."); await load(true); }
    finally { changingAuto.current = false; setAutoSaving(false); }
  }

  async function startRun() {
    if (submitting.current || starting || loading || error || searchPending || !pageCurrent || runActive || autoEnabled || autoSaving || autoUncertain || !selectedItems.length || !chosenPlatforms.length) return;
    submitting.current = true;
    try {
      if (!confirm(`Publish this batch?\n\n${selectedItems.length} item(s) to ${chosenPlatforms.map(m => m.name).join(", ")}.${selectedWarningTargets ? `\n\n${selectedWarningTargets} selected item/platform combination(s) have warnings. Some targets may be skipped or need review. Check the displayed warnings before continuing.` : ''}\n\nBlack Cat rechecks each item before publishing through your signed-in browser. You can pause or cancel from Run activity.`)) return;
      setStarting(true);
      const response = await fetch("/api/publish/runs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: selectedItems.map(item => item.id), marketplaces: chosenPlatforms.map(m => m.id) }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not start this run. Check Run activity before trying again.");
      toast.success(`Crosslisting started · ${result.jobs} listing(s) queued${result.skipped?.length ? ` · ${result.skipped.length} already queued or published` : ""}`);
      router.push("/ready/activity");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not confirm the run. Check Run activity before trying again.");
      await load(true);
    } finally { submitting.current = false; setStarting(false); }
  }

  return <div className={styles.panel}>
    <a className={`btn ${styles.queueJump}`} href="#ready-queue">Ready queue <ArrowRight size={14} /></a>
    <div className={styles.pipeline} aria-label="Processing to crosslisting">
      <div><strong>{pageDetails ? pageDetails.counts.awaitingReview.toLocaleString() : '—'}</strong><span>Processed · needs review</span></div>
      <div><strong>{pageDetails ? pageDetails.counts.approved.toLocaleString() : '—'}</strong><span>Approved inventory · total</span></div>
      <div><strong>{pageDetails ? pageDetails.counts.withListings.toLocaleString() : '—'}</strong><span>Approved pieces with live listings</span></div>
    </div>
    <section className={styles.runMode} data-enabled={autoEnabled} aria-label="Crosslisting Auto Run">
      <div className={styles.sectionHeading} style={{ marginBottom: 8 }}>
        <button type="button" role="switch" aria-label="Auto Run" aria-checked={autoEnabled} className={styles.switch}
          disabled={!auto || autoSaving || (!autoEnabled && (!chosenPlatforms.length || !!error || autoUncertain))} onClick={() => void toggleAuto()}>
          <span className={styles.switchTrack} /> Auto Run <span className="chip">{!auto || autoUncertain ? 'Unconfirmed' : autoEnabled ? "On" : "Off"}</span>
        </button>
        <Link href="/ready/activity" className="btn">Run activity <ArrowRight size={14} /></Link>
      </div>
      <p style={{ margin: "10px 0", fontSize: 14 }}>{!auto || autoUncertain ? 'Refresh the queue to confirm the saved Auto Run setting.' : !autoEnabled ? "Choose platforms below, then turn on Auto Run when you are ready."
        : auto?.state === "running" ? `Run #${auto.runId} is crosslisting your pieces.`
        : auto?.state === "paused" ? "The current run is paused. Open Run activity to review or resume it."
        : auto?.state === "error" ? "Auto Run needs attention."
        : "Watching for newly approved Ready items…"}</p>
      <p className={styles.autoScope}>When on, Auto Run covers the full Ready queue across pages and searches.</p>
      <details className={styles.autoHelp}>
        <summary>How Auto Run works</summary>
        <p>Newly approved Ready items are picked up automatically, one piece at a time. Photos are added and processed on the Dashboard. Turning this off pauses its batch after the current browser action.</p>
      </details>
      <p className="muted" style={{ fontSize: 12 }}>Package estimates are allowed. Review weight and estimated dimensions before approving an item; check the packed parcel before buying its label.</p>
      {!!auto?.needsAttention && <p style={{ color: "var(--warn)", fontSize: 13 }}>{auto.attentionCoverage?.complete === false ? 'At least ' : 'Last check: '}{auto.needsAttention} checked item(s) need details or platform setup checked before automatic crosslisting.</p>}
      {auto?.attentionCoverage && <p className="muted" style={{ fontSize: 12 }}>
        {auto.state === 'checking' ? 'Checking' : 'Last Auto Run check'}: {auto.attentionCoverage.checked.toLocaleString()} of {auto.attentionCoverage.total.toLocaleString()} items.
        {!auto.attentionCoverage.complete && ' Remaining items are checked as Auto Run advances; this is not an all-clear for the full queue.'}
      </p>}
      {auto?.error && <p role="alert">{auto.error}</p>}
    </section>
    {error && <div role="alert" className={`${styles.notice} ${styles.error}`}>{error} Previous queue details are kept until a successful refresh. <button className="btn" onClick={() => void load(true)}>Try again</button></div>}
    {(status?.run || autoEnabled) && <DirectUploadProgress embedded />}
    <section className={styles.section} aria-label="Choose marketplaces">
      <div className={styles.sectionHeading}><div><h2>1. Choose marketplaces</h2><p>Your selected platforms apply to this batch.</p></div><Link href="/ready/accounts" className="btn">Manage accounts</Link></div>
      {loading && !status ? <p role="status"><Loader2 size={16} className="spin" /> Loading marketplaces…</p> : <div className={styles.platforms}>
        {marketplaces.map(m => <label className={styles.platform} key={m.id} data-configured={m.configured}>
          <strong>{m.name}<input type="checkbox" aria-label={m.name} disabled={!m.configured || starting || loading || !!error || runActive || autoEnabled || autoSaving}
            checked={m.configured && targets.has(m.id)} onChange={() => { setPageNumber(1); setSelected(new Set()); setTargets(previous => { const next = new Set(previous); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; }); }} /></strong>
          <small>{m.configured ? "Account configured" : m.reason || "Set up your account"}</small>
        </label>)}
      </div>}
      <p className="muted" style={{ fontSize: 12, margin: "16px 0 0" }}>Etsy requires reviewed vintage details. Only enabled marketplaces can be selected.</p>
    </section>
    <section id="ready-queue" tabIndex={-1} className={styles.section} aria-label="Reviewed batch">
      <div className={styles.sectionHeading}><div><h2>2. Ready queue</h2><p>{pageDetails ? `${readyItems.length} piece(s) pass shared checks on this page · ${warningItems.length} with warnings for selected platforms` : 'Waiting for verified queue details.'}</p></div>
        <div className={styles.actions}>
          <button className="btn" onClick={() => void load(true)} disabled={starting}><RefreshCw size={14} className={loading ? "spin" : undefined} /> Refresh</button>
          <button className="btn" aria-describedby="ready-page-scope" onClick={() => setSelected(new Set(readyItems.map(item => item.id)))} disabled={!readyItems.length || loading || starting || !!error || searchPending || !pageCurrent || runActive || autoEnabled || autoSaving || autoUncertain}><CheckCheck size={14} /> Select all ready</button>
          {selectedItems.length > 0 && <button className="btn" onClick={() => setSelected(new Set())} disabled={starting}>Clear</button>}
        </div>
      </div>
      <div className={styles.queueFilters}>
        <label>Search Ready queue<input className="input" aria-label="Search Ready queue" placeholder="SKU, brand or item type" maxLength={200} value={search} disabled={starting}
          onChange={event => { setSearch(event.target.value); setSelected(new Set()); }} /></label>
        <label>Items per page<select className="select" aria-label="Ready items per page" value={pageSize} disabled={starting}
          onChange={event => { setPageSize(Number(event.target.value)); setPageNumber(1); setSelected(new Set()); }}>
          {[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
        </select></label>
      </div>
      <p id="ready-page-scope" className="muted" style={{ fontSize: 12 }}>
        {pageDetails ? !pageCurrent || searchPending ? error ? 'Refresh to load items matching these filters.' : 'Loading items matching these filters…'
          : `Showing ${pageDetails.pagination.total ? (pageDetails.pagination.page - 1) * pageDetails.pagination.pageSize + 1 : 0}–${Math.min(pageDetails.pagination.page * pageDetails.pagination.pageSize, pageDetails.pagination.total)} of ${pageDetails.pagination.total.toLocaleString()} matching approved items. Checks and selection apply only to this page.` : 'Waiting for complete queue totals.'}
      </p>
      {searchPending && <p role="status">Updating search…</p>}
      <nav className={styles.queuePaging} aria-label="Ready queue pages">
        <button className="btn" disabled={!pageDetails || loading || starting || !!error || searchPending || !pageCurrent || pageNumber <= 1}
          onClick={() => { setPageNumber(value => value - 1); setSelected(new Set()); }}>Previous Ready page</button>
        <span>{pageDetails ? `Page ${pageDetails.pagination.page} of ${pageDetails.pagination.pages}` : 'Page unavailable'}</span>
        <button className="btn" disabled={!pageDetails || loading || starting || !!error || searchPending || !pageCurrent || pageNumber >= pageDetails.pagination.pages}
          onClick={() => { setPageNumber(value => value + 1); setSelected(new Set()); }}>Next Ready page</button>
      </nav>
      {!!warningItems.length && <p className={styles.notice}>Review the platform warnings below before starting. Checks use the current saved details and price policy; each target is checked again during publishing.</p>}
      {!error && (loading || searchPending || !pageCurrent) && !pendingItems.length ? <p role="status">Loading reviewed items…</p> : !error && pageCurrent && !searchPending && pendingItems.length === 0 ? <div className={styles.empty}>
        <PackageOpen size={32} color="var(--muted)" /><h3>{!chosenPlatforms.length?'Choose your marketplaces':searchTerm?'No matching Ready items':pageDetails?.counts.approved?'You are caught up for these marketplaces':'Ready pieces will appear here'}</h3>
        <p>{!chosenPlatforms.length?'Connect and enable a marketplace in Settings, then select it above.':searchTerm?'Try another SKU, brand or item type.':'Reviewed pieces appear here when they still need a listing on an applicable marketplace.'}</p>
        <Link href="/" className="btn">Open Dashboard <ArrowRight size={14} /></Link>
      </div> : <div ref={queueItems} role="group" aria-label="Ready items on this page" className={styles.items}>
        {pendingItems.map(item => <div className={`${styles.item} ${styles.reviewedItem}`} key={item.id}>
          <input type="checkbox" aria-label={`Select ${item.sku}`} checked={item.ready && selected.has(item.id)} disabled={!readyItems.some(ready => ready.id === item.id) || starting || loading || !!error || searchPending || !pageCurrent || runActive || autoEnabled || autoSaving || autoUncertain}
            onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />
          <div className={styles.itemCopy}><strong>{item.brand} {item.itemType ?? ""}</strong><p>{item.sku}{item.size ? ` · ${item.size}` : ""} · {item.photoCount} photos</p>
            <PackageDetailsNote details={item.packageDetails} />
            {!item.ready && <p style={{ color: "var(--warn)" }}>{item.issues.map(issue => issue.message).join("; ")}</p>}
            {!!warnings.get(item.id)?.length && <div role="note" aria-label={`Platform warnings for ${item.sku}`} style={{ color: 'var(--warn)', fontSize: 12, overflowWrap: 'anywhere' }}>
              <ul style={{ margin: '8px 0', paddingLeft: 18 }}>{warnings.get(item.id)!.map((warning, index) => <li key={`${warning.marketplace}-${warning.field}-${index}`}><strong>{warning.name} · {warning.field}:</strong> {warning.message}</li>)}</ul>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><Link href={`/inventory/${item.id}`} className="btn" style={{ whiteSpace: 'normal', maxWidth: '100%' }}>Review item</Link>
                {warnings.get(item.id)!.some(warning => warning.field === 'listing') && <Link href="/ready/recovery" className="btn" style={{ whiteSpace: 'normal', maxWidth: '100%' }}>Check listing outcomes</Link>}</div>
            </div>}</div>
          {!!item.publishedOn.length && <div className={styles.listingChips}>{item.publishedOn.map(m => <span className="chip" key={m}>On {m}</span>)}</div>}
          <strong className={styles.itemPrice}>{item.platformPrices && chosenPlatforms.some(m => item.platformPrices?.[m.id] !== undefined)
            ? chosenPlatforms.map(m => { const price = item.platformPrices?.[m.id] ?? item.price; return `${m.name} ${price != null ? `$${price.toFixed(2)}` : "Price needed"}`; }).join(" · ")
            : item.price != null ? `$${item.price.toFixed(2)}` : "Price needed"}</strong>
        </div>)}
      </div>}
      <div className={styles.startBar}><div><strong>{autoEnabled ? "Auto Run manages the Ready queue" : `${selectedItems.length} selected · ${chosenPlatforms.length} platform(s)`}</strong><small>{autoEnabled ? "New approvals are picked up while Auto Run is on." : "Or start a one-time run with your selected pieces."}</small></div>
        <button className="btn btn-primary" disabled={starting || loading || !!error || searchPending || !pageCurrent || runActive || autoEnabled || autoSaving || autoUncertain || !selectedItems.length || !chosenPlatforms.length} onClick={() => void startRun()}>
          {starting ? <Loader2 size={16} className="spin" /> : <Play size={16} />} {starting ? "Starting run…" : "Start selected"}
        </button>
      </div>
    </section>
    <section className={styles.section} aria-label="Processed pieces awaiting review">
      <div className={styles.sectionHeading}><div><h2>Processed · needs review</h2><p>{pageDetails ? `${pageDetails.counts.awaitingReview.toLocaleString()} waiting · showing the first ${awaitingReview.length}. Open Review for the complete queue.` : 'Waiting for verified review totals.'}</p></div><Link href="/review" className="btn">Open Review</Link></div>
      {!status ? <p role="status">Processed pieces are unavailable until the queue loads.</p> : !awaitingReview.length ? <p className="muted" style={{ fontSize: 13 }}>No processed pieces waiting for review.</p> : <div className={styles.items}>
        {awaitingReview.map(item => <div className={styles.item} key={item.id}><div className={styles.itemCopy}><strong>{item.brand || "Unidentified"} {item.itemType || "piece"}</strong><p>{item.sku} · {item.photoCount} photos</p></div><span className="chip">Needs review</span><Link href={`/inventory/${item.id}`} className="btn">Review piece</Link></div>)}
      </div>}
    </section>
  </div>;
}
