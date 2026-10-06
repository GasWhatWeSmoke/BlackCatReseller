"use client";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PromptDialog, type PromptSpec } from "./PromptDialog";
import { BulkItemEditor } from './BulkItemEditor';
import { BulkItemArchive, type ArchiveRequest } from './BulkItemArchive';
import { PhotoImage } from './PhotoImage';
import { browserInventoryOperations, type InventoryOperations, type InventoryDeleteResult } from "@/lib/inventoryClient";
import { DEFAULT_INVENTORY_QUERY, INVENTORY_MARKETPLACES, INVENTORY_STATES, inventoryBackHref, inventoryItemHref,
  inventoryQueryString, parseInventoryQuery, type InventoryPage, type InventoryQuery, type InventorySummary } from "@/lib/inventoryQuery";
import { MARKETPLACE_NAMES } from "@/lib/publish/platforms";
import { itemDeleteExpectation, type ItemDeleteExpectation } from '@/lib/itemDeleteSelection';
import styles from "./InventoryBrowser.module.css";

type Advanced = Omit<InventoryQuery, "q" | "state" | "flagged" | "page" | "pageSize">;
const advancedFrom = ({ q: _q, state: _state, flagged: _flagged, page: _page, pageSize: _size, ...advanced }: InventoryQuery): Advanced => advanced;
const money = (value: number | null) => value != null && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
const platformName = (name: string) => MARKETPLACE_NAMES[name as keyof typeof MARKETPLACE_NAMES] ?? name;
const listingStatus = (status: string) => ({ published: "listed", sold: "sold", ended: "ended", not_published: "not listed",
  unknown: "check listing", delist_pending: "removal queued", delisting: "removing", delist_unknown: "verify removal", delist_failed: "removal failed" }[status] ?? status.replaceAll("_", " "));

const InventoryCard = memo(function InventoryCard({ item, href, selected, toggle, imageRevision }: {
  item: InventorySummary; href: string; selected: boolean; toggle: (id: number) => void; imageRevision: number;
}) {
  const review = ["Photographed", "Needs Info"].includes(item.status), cover = item.cover;
  return <article className={`${styles.card} ${selected ? styles.selected : ""}`}>
    <label className={styles.select}><input type="checkbox" aria-label={`Select ${item.sku}`} checked={selected} onChange={() => toggle(item.id)} /></label>
    <Link href={href} prefetch={false} className={styles.link} aria-label={`Open ${item.sku}: ${item.title}`}>
      <div className={styles.photo}>
        {cover ? <PhotoImage alt={item.sku} loading="lazy" retryable={false} rotation={cover.rotation}
          src={`/api/thumb?path=${encodeURIComponent(cover.thumbPath ?? cover.storedPath)}&full=${encodeURIComponent(cover.storedPath)}&v=${encodeURIComponent(item.updatedAt)}&refresh=${imageRevision}`}
          /> : <span className={styles.missing}>No garment photo</span>}
        <span className={styles.photoCount}>{item.selectedPhotoCount} selected / {item.photoCount} photos</span>
      </div>
      <div className={styles.body}>
        <div className={styles.identity}><span className={styles.sku}>{item.sku}{item.flagged ? " · Flagged" : ""}</span>
          <span className={styles.price}>{item.status === "Sold" ? `Sold ${money(item.salePrice)}` : `Ask ${money(item.listedPrice)}`}</span></div>
        <h2 className={styles.title}>{item.title || "Item details not entered"}</h2>
        <div className={styles.facts}>{item.brand === "Unknown" ? "Brand not confirmed" : item.brand} · Size {item.size || "—"}<br />{item.category || "Category not set"}{item.itemType ? ` · ${item.itemType}` : ""}</div>
        <div className={styles.badges}><span data-status={item.displayStatus}>{item.displayStatus}</span>
          {review && item.needsAiReview && <span className={styles.warning}>AI details to review</span>}
          {review && (item.isShell || ["low", "medium"].includes(item.groupingConfidence ?? "")) && <span className={styles.warning}>Check grouping</span>}
          {item.selectedPhotoCount === 0 && item.status !== "Sold" && <span className={styles.warning}>No listing photos selected</span>}
        </div>
        <div className={styles.badges}>
          {item.status === "Sold" && item.platformSold && !item.marketplaceListings.some(row => row.status === "sold") && <span>Sale: {platformName(item.platformSold.toLowerCase())}</span>}
          {item.marketplaceListings.length ? item.marketplaceListings.map(row => <span key={row.marketplace}
          title={`${platformName(row.marketplace)}: ${listingStatus(row.status)} · recorded price ${money(row.price)}${row.title ? ` · recorded title: ${row.title}` : ""}${row.lastError ? ` · ${row.lastError}` : ""}`}
          className={row.lastError || row.status.includes("unknown") || row.status.includes("failed") ? styles.warning : undefined}>
          {platformName(row.marketplace)} · {listingStatus(row.status)}</span>) : <span>Listing links not recorded</span>}</div>
        <div className={styles.updated}>Updated {new Date(item.updatedAt).toLocaleDateString()}{item.batchId != null ? ` · Batch ${item.batchId}` : ""}</div>
      </div>
    </Link>
  </article>;
});

export function InventoryBrowser({ operations = browserInventoryOperations }: { operations?: InventoryOperations }) {
  const [query, setQuery] = useState<InventoryQuery>({ ...DEFAULT_INVENTORY_QUERY });
  const queryRef = useRef(query); queryRef.current = query;
  const [search, setSearch] = useState("");
  const [advanced, setAdvanced] = useState<Advanced>(advancedFrom(DEFAULT_INVENTORY_QUERY));
  const [initialized, setInitialized] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; refresh: number; page: InventoryPage } | null>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [selected, setSelected] = useState(new Set<number>());
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [confirmation, setConfirmation] = useState<InventorySummary[] | null>(null);
  const [editSelection, setEditSelection] = useState<InventorySummary[] | null>(null);
  const [archiveRequest, setArchiveRequest] = useState<ArchiveRequest | null>(null);
  const [deleteOutcome, setDeleteOutcome] = useState<{ selection: ItemDeleteExpectation[]; result: InventoryDeleteResult } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletionResults = useRef<HTMLElement>(null);
  const [dialog, setDialog] = useState<PromptSpec | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteTitle = useId();
  const requestVersion = useRef(0);
  const key = inventoryQueryString(query), searchPending = search.trim() !== query.q;
  const ready = initialized && !urlError && !loading && !loadError && !searchPending && snapshot?.key === key && snapshot.refresh === refresh;
  const readyRef = useRef(ready); readyRef.current = ready;

  const changeQuery = useCallback((candidate: InventoryQuery) => {
    try {
      const normalized = parseInventoryQuery(new URLSearchParams(inventoryQueryString(candidate)));
      setQuery(normalized); setUrlError(null); setFilterError(null); setSelected(new Set()); setConfirmation(null);
    } catch (error) { setFilterError(error instanceof Error ? error.message : "Check the filter values."); }
  }, []);

  useEffect(() => {
    const restore = () => {
      try { const value = parseInventoryQuery(new URLSearchParams(window.location.search));
        setQuery(value); setSearch(value.q); setAdvanced(advancedFrom(value)); setUrlError(null); setSelected(new Set()); setConfirmation(null);
      } catch (error) { setUrlError(error instanceof Error ? error.message : "The inventory filters in this address are invalid."); }
      setInitialized(true);
    };
    restore(); const back = () => { restore(); setRefresh(value => value + 1); };
    window.addEventListener("popstate", back); return () => window.removeEventListener("popstate", back);
  }, []);

  useEffect(() => {
    if (!initialized || search.trim() === queryRef.current.q) return;
    const timer = setTimeout(() => { if (search.trim() !== queryRef.current.q) changeQuery({ ...queryRef.current, q: search.trim(), page: 1 }); }, 250);
    return () => clearTimeout(timer);
  }, [search, initialized, changeQuery]);

  useEffect(() => {
    if (!initialized || urlError) return;
    if (snapshotRef.current?.key === key && snapshotRef.current.refresh === refresh) return;
    const version = ++requestVersion.current, controller = new AbortController();
    setLoading(true); setLoadError(null); setSelected(new Set());
    void operations.read(queryRef.current, controller.signal).then(page => {
      if (controller.signal.aborted || version !== requestVersion.current || inventoryQueryString(queryRef.current) !== key) return;
      const confirmed = { ...queryRef.current, page: page.page, pageSize: page.pageSize };
      const next = { key: inventoryQueryString(confirmed), refresh, page };
      snapshotRef.current = next; setSnapshot(next); setLoading(false);
      if (confirmed.page !== queryRef.current.page || confirmed.pageSize !== queryRef.current.pageSize) setQuery(confirmed);
    }).catch(error => { if (!controller.signal.aborted && version === requestVersion.current && inventoryQueryString(queryRef.current) === key) {
      setLoadError(error instanceof Error ? error.message : "Inventory could not be loaded."); setLoading(false);
    } });
    return () => controller.abort();
  }, [key, refresh, initialized, urlError, operations]);

  useEffect(() => { if (initialized && !urlError) window.history.replaceState(window.history.state, "", inventoryBackHref(query)); }, [key, initialized, urlError, query]);
  useEffect(() => { if (confirmation) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [confirmation]);
  useEffect(() => { if (!deleting && (deleteOutcome || deleteError)) deletionResults.current?.focus(); }, [deleting, deleteOutcome, deleteError]);
  useEffect(() => {
    if (!deleting) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [deleting]);

  const toggle = useCallback((id: number) => {
    if (!readyRef.current || deletingRef.current) return;
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);
  const page = snapshot?.page, items = ready ? page?.items ?? [] : [];
  const allSelected = !!items.length && selected.size === items.length;
  const advancedCount = [query.sku, query.brand, query.category, query.size, query.itemType, query.marketplace, query.batch].filter(Boolean).length
    + (query.priceMin || query.priceMax ? 1 : 0) + (query.dateFrom || query.dateTo ? 1 : 0);
  const topFilter = (patch: Partial<InventoryQuery>) => changeQuery({ ...query, q: search.trim(), ...patch, page: 1 });
  const reset = () => { setSearch(""); setAdvanced(advancedFrom(DEFAULT_INVENTORY_QUERY)); changeQuery({ ...DEFAULT_INVENTORY_QUERY }); setRefresh(value => value + 1); };
  const updateAdvanced = (name: keyof Advanced, value: string) => { setAdvanced(current => ({ ...current, [name]: value })); setSelected(new Set()); setFilterError(null); };

  async function removeConfirmed() {
    if (!confirmation || deletingRef.current) return;
    const ids = confirmation.map(item => item.id);
    deletingRef.current = true; setDeleting(true);
    setDeleteOutcome(null); setDeleteError(null);
    const notice = toast.loading(`Deleting ${ids.length} selected item(s)…`);
    try {
      const selection = confirmation.map(itemDeleteExpectation);
      const result = await operations.remove(ids, selection);
      setDeleteOutcome({ selection, result });
      const summary = `Deleted ${result.deleted} item(s)` + (result.soldKept ? `; kept ${result.soldKept} sold item(s)` : "")
        + (result.failed?.length ? `; ${result.failed.length} item(s) could not be deleted` : "");
      if (result.soldKept || result.failed?.length || result.cleanupWarnings?.length) toast.warning(summary, { id: notice, duration: 12000,
        description: result.failed?.[0]?.error || result.cleanupWarnings?.[0]?.warnings?.[0] || "Sold items remain in earnings history." });
      else toast.success(summary, { id: notice });
    } catch (error) { const message = error instanceof Error ? error.message : "Deletion could not be confirmed. Refresh inventory before retrying.";
      setDeleteError(message); toast.error(message, { id: notice, duration: 12000 }); }
    finally { deletingRef.current = false; setDeleting(false); setConfirmation(null); setSelected(new Set()); setRefresh(value => value + 1); }
  }

  function newItem() {
    setDialog({ title: "Create a new empty item", message: "Enter its SKU. You can move photos into it afterwards.", placeholder: "e.g. 000048", actionLabel: "Create",
      onSubmit: async sku => { try { const id = await operations.create(sku); window.location.href = `/inventory/${id}`; return null; }
        catch (error) { return error instanceof Error ? error.message : "The new item could not be confirmed."; } } });
  }

  const paging = (position: "top" | "bottom") => <nav className={styles.paging} aria-label={`Inventory pages ${position}`}>
    <span>{ready && page ? `${page.total ? (page.page - 1) * page.pageSize + 1 : 0}–${Math.min(page.page * page.pageSize, page.total)} of ${page.total.toLocaleString()} matching pieces` : "Inventory results are not ready"}</span>
    <div className={`${styles.actions} ${styles.pageButtons}`}><button className="btn" aria-label="Previous page" title="Previous page" disabled={!ready || deleting || !page || page.page <= 1} onClick={() => changeQuery({ ...query, page: page!.page - 1 })}><span className={styles.pageArrow} aria-hidden="true">←</span><span className={styles.pageButtonText}>Previous page</span></button>
      <span>{ready && page ? `Page ${page.page} of ${page.pages}` : "…"}</span>
      <button className="btn" aria-label="Next page" title="Next page" disabled={!ready || deleting || !page || page.page >= page.pages} onClick={() => changeQuery({ ...query, page: page!.page + 1 })}><span className={styles.pageArrow} aria-hidden="true">→</span><span className={styles.pageButtonText}>Next page</span></button></div>
    {position === "top" && <label>Per page<select className="select" aria-label="Items per page" value={query.pageSize} disabled={deleting}
      onChange={event => topFilter({ pageSize: Number(event.target.value) })}>{[...new Set([25, 50, 100, query.pageSize])].sort((a, b) => a - b).map(size => <option key={size}>{size}</option>)}</select></label>}
  </nav>;

  return <div>
    <header className={styles.header}><div><div className={styles.eyebrow}>Your collection</div><h1>Inventory</h1><p>Find every piece, its saved details, and its marketplace records.</p></div>
      <div className={styles.actions}><button className="btn" disabled={deleting} onClick={newItem}>+ New item</button>
        <button className="btn" disabled={deleting || loading} onClick={() => setRefresh(value => value + 1)}>Refresh inventory</button>
        <button className="btn" disabled={!ready || deleting || !items.length} onClick={() => setSelected(allSelected ? new Set() : new Set(items.map(item => item.id)))}>{allSelected ? "Clear selection" : `Select this page (${items.length})`}</button></div>
    </header>
    <div className={styles.toolbar}><input className="input" aria-label="Search inventory" placeholder="SKU, title, brand, type or size…" maxLength={200} value={search} disabled={deleting}
      onChange={event => { setSearch(event.target.value); setSelected(new Set()); setConfirmation(null); }} />
      <select className="select" aria-label="Inventory state" value={query.state} disabled={deleting} onChange={event => topFilter({ state: event.target.value })}>
        {INVENTORY_STATES.map(state => <option key={state} value={state}>{state || "All states"}</option>)}</select>
      <button className="btn" aria-pressed={query.flagged} disabled={deleting} onClick={() => topFilter({ flagged: !query.flagged })}>Flagged only</button>
      <button className="btn" disabled={deleting} onClick={reset}>Reset filters</button></div>
    <details className={styles.filters}><summary>More filters{advancedCount ? ` · ${advancedCount} active` : ""}</summary><div className={styles.filterGrid}>
      {([['sku','Exact SKU'],['brand','Brand contains'],['itemType','Item type contains'],['size','Exact size'],['category','Saved category'],['batch','Batch number']] as const).map(([name,label]) =>
        <label className={styles.field} key={name}>{label}<input className="input" aria-label={label} value={advanced[name]} disabled={deleting} maxLength={name === "sku" ? 32 : 100} onChange={event => updateAdvanced(name,event.target.value)} /></label>)}
      <label className={styles.field}>Marketplace<select className="select" aria-label="Marketplace" value={advanced.marketplace} disabled={deleting} onChange={event => updateAdvanced("marketplace",event.target.value)}>{INVENTORY_MARKETPLACES.map(value => <option key={value} value={value}>{value ? platformName(value) : "Any marketplace"}</option>)}</select></label>
      <label className={styles.field}>Price type<select className="select" aria-label="Price type" value={advanced.priceField} disabled={deleting} onChange={event => updateAdvanced("priceField",event.target.value)}><option value="listed">Shared asking price</option><option value="sold">Sale amount</option></select></label>
      {([['priceMin','Minimum price'],['priceMax','Maximum price']] as const).map(([name,label]) => <label className={styles.field} key={name}>{label}<input className="input" inputMode="decimal" aria-label={label} value={advanced[name]} disabled={deleting} maxLength={30} onChange={event => updateAdvanced(name,event.target.value)} /></label>)}
      <label className={styles.field}>Date type<select className="select" aria-label="Date type" value={advanced.dateField} disabled={deleting} onChange={event => updateAdvanced("dateField",event.target.value)}><option value="added">Date added</option><option value="listed">Recorded listing date</option><option value="sold">Sold date</option></select></label>
      {([['dateFrom','From date'],['dateTo','Through date']] as const).map(([name,label]) => <label className={styles.field} key={name}>{label}<input className="input" type="date" aria-label={label} value={advanced[name]} disabled={deleting} onChange={event => updateAdvanced(name,event.target.value)} /></label>)}
    </div><p className={styles.hint}>Dates include the full day in this computer's time zone. Listing dates match the saved item date or a recorded marketplace publication. Marketplace filtering uses stored records; Sold matches the sale channel, and Listed matches an active listing on that channel.</p>
      <button className="btn" disabled={deleting} onClick={() => changeQuery({ ...query, ...advanced, q: search.trim(), page: 1 })}>Apply filters</button>
      {filterError && <p role="alert" className={styles.warning}>{filterError}</p>}
    </details>
    {(deleteOutcome || deleteError) && <section ref={deletionResults} tabIndex={-1} className="card" aria-label="Deletion results" style={{ padding: 16, marginBlock: 16 }}>
      {deleteError ? <p role="alert">{deleteError}</p> : deleteOutcome && <>
        <p role="status">Deleted {deleteOutcome.result.deleted} item(s). Kept {deleteOutcome.result.soldKept ?? 0} sold item(s). {deleteOutcome.result.failed?.length ?? 0} item(s) need attention.</p>
        {!!deleteOutcome.result.failed?.length && <details open><summary>Items needing attention</summary><ul>{deleteOutcome.result.failed.map(row => <li key={row.id}>
          <strong>{deleteOutcome.selection.find(item => item.id === row.id)?.sku ?? `Item ${row.id}`}</strong>: {row.error || 'Deletion was not confirmed.'}</li>)}</ul></details>}
        {!!deleteOutcome.result.cleanupWarnings?.length && <details open><summary>Photo cleanup warnings</summary><ul>{deleteOutcome.result.cleanupWarnings.map((row, index) => <li key={index}>
          <strong>{deleteOutcome.selection.find(item => item.id === row.id)?.sku ?? 'Deleted item'}</strong>: {row.warnings?.join(' ')}</li>)}</ul></details>}
      </>}
      <button className="btn" onClick={() => { setDeleteOutcome(null); setDeleteError(null); }}>Dismiss deletion results</button>
    </section>}
    {urlError ? <div className={styles.error} role="alert">{urlError} <button className="btn" onClick={reset}>Clear invalid filters</button></div>
      : loadError ? <div className={styles.error} role="alert">{loadError} <button className="btn" onClick={() => setRefresh(value => value + 1)}>Retry inventory</button></div>
      : !ready ? <p role="status">Loading inventory…</p> : <>
        {paging("top")}
        {items.length ? <div className={styles.grid} aria-label="Inventory results">{items.map(item => <InventoryCard key={item.id} item={item} selected={selected.has(item.id)} toggle={toggle} href={inventoryItemHref(item.id, query)} imageRevision={refresh} />)}</div>
          : <div className={styles.empty}><h2>No matching items</h2><p>Reset the filters to see all inventory, or add photos from the Dashboard.</p></div>}
        {paging("bottom")}
      </>}
    {ready && selected.size > 0 && <div className={styles.selection} aria-label="Selection actions"><strong>{selected.size} selected on this page</strong>
      {operations.edit && <button className="btn btn-primary" disabled={deleting} onClick={() => setEditSelection(items.filter(item => selected.has(item.id)))}>Edit selected</button>}
      {operations.archive && <>
        <button className="btn" disabled={deleting} onClick={() => setArchiveRequest({ action: 'archive', items: items.filter(item => selected.has(item.id)) })}>Archive selected</button>
        {items.some(item => selected.has(item.id) && item.status === 'Archived') && <button className="btn" disabled={deleting}
          onClick={() => setArchiveRequest({ action: 'restore', items: items.filter(item => selected.has(item.id)) })}>Restore selected to Review</button>}
      </>}
      <button className="btn btn-danger" disabled={deleting} onClick={() => setConfirmation(items.filter(item => selected.has(item.id)))}>Delete selected</button>
      <button className="btn" disabled={deleting} onClick={() => setSelected(new Set())}>Clear selection</button></div>}
    <dialog ref={deleteDialog} aria-labelledby={deleteTitle} onCancel={event => { event.preventDefault(); if (!deleting) setConfirmation(null); }}
      style={{ width: "min(720px, 92vw)", maxWidth: "calc(100vw - 32px)", maxHeight: "85vh", overflow: "auto", boxSizing: "border-box", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
      {confirmation && <><h2 id={deleteTitle}>Delete {confirmation.length} selected item(s)?</h2><p>Their working photos are removed; archive originals stay safe. Sold history, active listings and unresolved publishing activity are protected.</p>
        <ul>{confirmation.map(item => <li key={item.id}><strong>{item.sku}</strong> · {item.title} · {item.displayStatus}</li>)}</ul>
        <div className={styles.actions}><button className="btn" autoFocus disabled={deleting} onClick={() => setConfirmation(null)}>Keep items</button>
          <button className="btn btn-danger" disabled={deleting} onClick={() => void removeConfirmed()}>{deleting ? "Deleting…" : "Delete these selected items"}</button></div></>}
    </dialog>
    {operations.edit && <BulkItemEditor selection={editSelection} edit={operations.edit} onClose={() => setEditSelection(null)}
      onChanged={() => { setSelected(new Set()); setRefresh(value => value + 1); }} />}
    {operations.archive && <BulkItemArchive request={archiveRequest} change={operations.archive} onClose={() => setArchiveRequest(null)}
      onChanged={() => { setSelected(new Set()); setRefresh(value => value + 1); }} />}
    <PromptDialog spec={dialog} onClose={() => setDialog(null)} />
  </div>;
}
