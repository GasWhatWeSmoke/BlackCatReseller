'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { archiveSelection, type ArchiveSelection } from '@/lib/bulkArchive';
import { parseManualSale, manualSalePlatform, saleMoneyCents, type ManualSaleCommand, type ManualSaleSource } from '@/lib/manualSale';
import { BROWSER_MARKETPLACES, MARKETPLACE_NAMES } from '@/lib/publish/platforms';
import { announceShipQueueChanged } from '@/lib/shipQueue';
import styles from './ManualSale.module.css';

const KEY = 'blackcat.manual-sale.v1';
type Item = ArchiveSelection & { brand: string; itemType: string | null; color: string | null; size: string | null;
  marketplaceListings: { id: number; marketplace: string; status: string; updatedAt: string; externalListingId: string | null; externalUrl: string | null }[] };
const fresh = () => ({ sku: '', source: '' as ManualSaleSource | '', fulfillment: 'shipping' as 'shipping' | 'pickup', completed: false,
  soldAt: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16),
  price: '', fees: '', shippingIncome: '', postage: '', reference: '' });
type Draft = ReturnType<typeof fresh>;
type Report = { command: ManualSaleCommand; state: 'pending' | 'saved' | 'blocked'; message: string };
const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function ManualSale({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false), [ready, setReady] = useState(false), [draft, setDraft] = useState<Draft>(fresh);
  const [item, setItem] = useState<Item | null>(null), [report, setReport] = useState<Report | null>(null);
  const [confirm, setConfirm] = useState<ManualSaleCommand | null>(null), [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false), [busy, setBusy] = useState(false), lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null), heading = useId(), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        if (raw.length > 20_000) throw Error();
        const saved = JSON.parse(raw), defaults = fresh();
        if (!saved.draft || Object.keys(defaults).some(key => typeof saved.draft[key] !== typeof defaults[key as keyof Draft]) ||
          JSON.stringify(saved.draft).length > 5000) throw Error();
        setDraft(saved.draft); setOpen(true);
        if (saved.report) {
          if (!['pending', 'saved', 'blocked'].includes(saved.report.state) || typeof saved.report.message !== 'string') throw Error();
          setReport({ ...saved.report, command: parseManualSale(saved.report.command) });
        }
      }
    } catch { setStorageError(true); setError('The saved sale draft could not be read. Check Sales before clearing it.'); setOpen(true); }
    setReady(true); return () => { alive.current = false; };
  }, []);
  useEffect(() => { if (confirm) dialog.current?.showModal(); else dialog.current?.close(); }, [confirm]);
  useEffect(() => {
    if (!busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [busy]);
  function persist(next: Draft, receipt = report) {
    try { localStorage.setItem(KEY, JSON.stringify({ draft: next, report: receipt })); setStorageError(false); return true; }
    catch { setStorageError(true); setError('This sale draft cannot be saved. Allow local storage before confirming.'); return false; }
  }
  function edit(patch: Partial<Draft>) {
    const next = { ...draft, ...patch }; setDraft(next); if (persist(next)) setError('');
    if ('sku' in patch) setItem(null);
  }
  async function read(url: string) {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Error('The saved item could not be loaded. Try again.');
    return response.json();
  }
  async function findItem() {
    if (lock.current || !draft.sku.trim()) return;
    lock.current = true; setBusy(true); setError(''); setItem(null);
    try {
      const sku = draft.sku.trim();
      const page = await read(`/api/items?${new URLSearchParams({ view: 'inventory', sku, pageSize: '1' })}`);
      if (page.total !== 1 || page.items?.length !== 1 || page.items[0].sku !== sku) throw Error('No exact SKU match. Enter the full inventory number, including leading zeroes.');
      const result = await read(`/api/items/${page.items[0].id}`), selected = archiveSelection(result.item);
      if (selected.sku !== sku || selected.id !== page.items[0].id || !Array.isArray(result.item.marketplaceListings)) throw Error('Item identity could not be confirmed.');
      if (['Sold', 'Archived', 'Removed'].includes(selected.status)) throw Error(`This item is ${selected.status}. Review it in Inventory or Sales first.`);
      if (alive.current) setItem(result.item);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Item could not be loaded.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function review() {
    if (!item || lock.current || report?.state === 'pending' || storageError) return;
    try {
      if (!draft.source) throw Error('Choose where this item sold.');
      const source = item.marketplaceListings.find(row => row.marketplace === draft.source && !['ended', 'not_published'].includes(row.status));
      const command = parseManualSale({ operationId: crypto.randomUUID(), selection: archiveSelection(item), source: draft.source,
        fulfillment: draft.fulfillment, completed: draft.completed, soldAt: new Date(draft.soldAt).toISOString(),
        salePriceCents: saleMoneyCents(draft.price, 'Item sale price'), feeCents: saleMoneyCents(draft.fees, 'Fees'),
        shippingChargedCents: draft.fulfillment === 'pickup' ? 0 : saleMoneyCents(draft.shippingIncome, 'Shipping income'),
        shippingCostCents: draft.fulfillment === 'pickup' ? 0 : draft.postage.trim() ? saleMoneyCents(draft.postage, 'Postage') : null,
        reference: draft.reference.trim(), sourceListing: source ? { id: source.id, updatedAt: source.updatedAt, externalListingId: source.externalListingId, externalUrl: source.externalUrl } : null });
      if (persist(draft)) { setError(''); setConfirm(command); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Review the sale details.'); }
  }
  async function save() {
    if (!confirm || lock.current) return;
    const command = confirm, pending: Report = { command, state: 'pending', message: 'Confirmation may have completed. Check the saved sale before doing anything else; nothing is replayed automatically.' };
    if (!persist(draft, pending)) return;
    lock.current = true; setBusy(true); setReport(pending); setError('');
    try {
      const response = await fetch(`/api/items/${command.selection.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualSale: command }), signal: AbortSignal.timeout(30_000) });
      const result = await response.json();
      if ([409, 422, 404].includes(response.status)) {
        const blocked: Report = { command, state: 'blocked', message: result.error || 'The sale was not saved. Reload the item before confirming.' };
        setReport(blocked); persist(draft, blocked); setItem(null); return;
      }
      if (!response.ok || result.saleReceipt?.operationId !== command.operationId || result.saleReceipt?.current !== true ||
          result.manualSale?.operationId !== command.operationId || result.item?.id !== command.selection.id || result.item?.createdAt !== command.selection.createdAt || result.item?.status !== 'Sold') throw Error();
      const saved: Report = { command, state: 'saved', message: 'Sale recorded. Other linked listings are queued for removal or need verification. Check their status in Sales; removal is not yet confirmed.' };
      setReport(saved); persist(draft, saved); setItem(null); onChanged(); announceShipQueueChanged();
    } catch { setError('The sale result is unconfirmed. Use “Check saved sale”; do not enter it again.'); }
    finally { lock.current = false; if (alive.current) { setBusy(false); setConfirm(null); } }
  }
  async function reconcile() {
    if (!report || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const saved = await read(`/api/items/${report.command.selection.id}`);
      if (saved.item?.createdAt !== report.command.selection.createdAt) throw Error('The original inventory item could not be confirmed. Review Sales manually.');
      if (saved.item.status === 'Sold' && saved.manualSale?.operationId === report.command.operationId) {
        const next: Report = { ...report, state: 'saved', message: 'This sale is saved. Check Sales for the current fulfillment and listing-removal status.' };
        setReport(next); persist(draft, next); onChanged(); announceShipQueueChanged();
      } else throw Error('This confirmation is not the current saved sale. Review the item and its history before clearing this report. Nothing was replayed.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not check the sale.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function clear() {
    if (lock.current) return;
    if ((report?.state === 'pending' || storageError) && !window.confirm('Only clear this report after checking the item and Sales. Clearing does not undo any saved sale. Have you checked?')) return;
    try { localStorage.removeItem(KEY); setDraft(fresh()); setReport(null); setItem(null); setError(''); setStorageError(false); }
    catch { setError('The saved report could not be cleared.'); }
  }
  const frozen = busy || storageError || report?.state === 'pending' || report?.state === 'saved';
  return <section className={styles.panel} aria-label="Manual sale entry">
    <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!ready || busy}>Record a sale</button>
    {open && <div className={styles.body}>
      <h2>Record a paid sale</h2><p>For a missed marketplace sale or an in-person / off-platform sale. Confirm one exact SKU. Amounts are USD.</p>
      {error && <p role="alert" className={styles.warning}>{error}</p>}
      {report && <div role="status" className={styles.report}><strong>{report.command.selection.sku} · {report.state === 'saved' ? 'Saved' : report.state === 'blocked' ? 'Not saved' : 'Unconfirmed'}</strong><p>{report.message}</p>
        <Link href={`/inventory/${report.command.selection.id}`}>Open this item</Link>{report.state === 'pending' && <button className="btn" onClick={() => void reconcile()} disabled={busy}>Check saved sale</button>}</div>}
      <fieldset disabled={frozen} className={styles.fields}>
        <div className={styles.lookup}><label>Exact SKU<input className="input" maxLength={32} value={draft.sku} onChange={e => edit({ sku: e.target.value })}/></label><button className="btn" onClick={() => void findItem()}>Find item</button></div>
        {item && <p className={styles.identity}><strong>{item.sku}</strong> · {[item.brand, item.itemType, item.color, item.size].filter(Boolean).join(' · ')} · {item.status}</p>}
        <div className={styles.grid}>
          <label>Sold through<select className="select" aria-label="Sold through" value={draft.source} onChange={e => { const source = e.target.value as Draft['source']; edit({ source, ...(source === 'in_person' ? { fulfillment: 'pickup', completed: false } : {}) }); }}>
            <option value="">Choose sale source</option>{BROWSER_MARKETPLACES.map(key => <option key={key} value={key}>{MARKETPLACE_NAMES[key]}</option>)}<option value="in_person">In person</option><option value="off_platform">Other / off-platform</option></select></label>
          <label>Sale date and time<input className="input" type="datetime-local" value={draft.soldAt} onChange={e => edit({ soldAt: e.target.value })}/></label>
          <label>Item sale price · USD<input className="input" inputMode="decimal" value={draft.price} onChange={e => edit({ price: e.target.value })}/></label>
          <label>Actual fees · USD<input className="input" inputMode="decimal" placeholder="Enter 0 if none" value={draft.fees} onChange={e => edit({ fees: e.target.value })}/></label>
          <label>Fulfillment<select className="select" aria-label="Fulfillment" value={draft.fulfillment} disabled={draft.source === 'in_person'} onChange={e => edit({ fulfillment: e.target.value as Draft['fulfillment'], completed: false })}><option value="shipping">Shipping</option><option value="pickup">Pickup / handover</option></select></label>
          <label>Order reference or sale note<input className="input" maxLength={200} placeholder="Receipt number, cash at market, etc." value={draft.reference} onChange={e => edit({ reference: e.target.value })}/></label>
          {draft.fulfillment === 'shipping' && <><label>Shipping income received · USD<input className="input" inputMode="decimal" placeholder="0 if none or retained by platform" value={draft.shippingIncome} onChange={e => edit({ shippingIncome: e.target.value })}/></label>
            <label>Actual postage · USD<input className="input" inputMode="decimal" placeholder="Blank uses a labeled estimate" value={draft.postage} onChange={e => edit({ postage: e.target.value })}/></label></>}
        </div>
        <label className={styles.check}><input type="checkbox" checked={draft.completed} onChange={e => edit({ completed: e.target.checked })}/>{draft.fulfillment === 'pickup' ? 'Already handed over to the buyer' : 'Already shipped'}</label>
        <p className="muted">{draft.fulfillment === 'pickup' ? 'Pickup records $0 shipping income and $0 postage.' : 'Record shipping income that reaches you. Leave postage blank only when you need a labeled estimate.'} Cost of goods stays as saved on the item.</p>
        <button className="btn btn-primary" onClick={review} disabled={!item || storageError}>Review sale</button>
      </fieldset>
      <button className="btn" onClick={clear} disabled={busy}>{report?.state === 'saved' ? 'Record another sale' : 'Clear draft / report'}</button>
    </div>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!lock.current) setConfirm(null); }}>
      {confirm && <><h2 id={heading}>Confirm sale · {confirm.selection.sku}</h2><p>{manualSalePlatform(confirm.source)} · {dollars(confirm.salePriceCents)} item price</p>
        <dl><dt>Fees</dt><dd>{dollars(confirm.feeCents)}</dd><dt>Shipping income</dt><dd>{dollars(confirm.shippingChargedCents)}</dd><dt>Postage</dt><dd>{confirm.shippingCostCents === null ? 'Estimated until you enter the actual cost' : dollars(confirm.shippingCostCents)}</dd><dt>Fulfillment</dt><dd>{confirm.fulfillment === 'pickup' ? confirm.completed ? 'Handed over' : 'Awaiting pickup' : confirm.completed ? 'Shipped' : 'Needs shipping'}</dd><dt>Reference</dt><dd>{confirm.reference}</dd></dl>
        <p>This confirms payment and marks this item sold. Pending publishing is cancelled. Other known listings enter removal recovery; check Sales until their removal is verified.</p>
        <p className={styles.warning}>Only listings linked to this item can be removed automatically. Check any other platforms where you listed it.</p>
        {error && <p role="alert">{error}</p>}
        <div className={styles.actions}><button className="btn" autoFocus disabled={busy} onClick={() => setConfirm(null)}>Back to details</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Recording…' : 'Confirm paid sale'}</button></div></>}
    </dialog>
  </section>;
}
