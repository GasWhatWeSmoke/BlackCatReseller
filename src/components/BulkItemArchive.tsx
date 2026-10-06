"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { archiveSelection, archiveSelectedItems, parseArchiveReceipt,
  type ArchiveAction, type ArchiveOutcome, type ArchiveReceipt, type ArchiveSelection } from '@/lib/bulkArchive';
import styles from './BulkItemEditor.module.css';

const RECEIPT_KEY = 'blackcat.inventory.bulk-archive.v1';
export type ArchiveRequest = { action: ArchiveAction; items: (ArchiveSelection & { title?: string; displayStatus?: string })[] };
export function BulkItemArchive({ request, change, onClose, onChanged }: {
  request: ArchiveRequest | null; change: (item: ArchiveSelection, action: ArchiveAction) => Promise<ArchiveOutcome>;
  onClose: () => void; onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId(), report = useRef<HTMLElement>(null);
  const [restore, setRestore] = useState<ArchiveRequest | null>(null), active = request ?? restore;
  const [receipt, setReceipt] = useState<ArchiveReceipt | null>(null), [error, setError] = useState('');
  const [unreadable, setUnreadable] = useState(false), [running, setRunning] = useState(false);
  const runningRef = useRef(false), stopped = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECEIPT_KEY);
      if (raw) { if (raw.length > 500_000) throw Error(); setReceipt(parseArchiveReceipt(JSON.parse(raw))); }
    } catch { setUnreadable(true); setError('The previous archive report could not be read. Check Inventory before clearing this report.'); }
  }, []);
  useEffect(() => { if (active) dialog.current?.showModal(); else dialog.current?.close(); }, [active]);
  useEffect(() => {
    if (!running) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [running]);
  function close() { setRestore(null); onClose(); }
  function clearReport() {
    try { localStorage.removeItem(RECEIPT_KEY); setReceipt(null); setUnreadable(false); setError(''); }
    catch { setError('Archive reports cannot be saved here. Allow browser storage before starting this batch.'); }
  }
  function record(value: ArchiveReceipt) {
    const checked = parseArchiveReceipt(value);
    localStorage.setItem(RECEIPT_KEY, JSON.stringify(checked)); setReceipt(checked);
  }
  async function apply() {
    if (!active || unreadable || runningRef.current) return;
    runningRef.current = true; stopped.current = false; setRunning(true); setError('');
    try {
      const current: ArchiveReceipt = { at: new Date().toISOString(), action: active.action,
        selection: active.items.map(archiveSelection), results: [], complete: false };
      record(current);
      const results = await archiveSelectedItems(current.selection, current.action, change, {
        stopped: () => stopped.current, progress: rows => { current.results = rows; record({ ...current }); },
      });
      record({ ...current, results, complete: true });
      if (stopped.current) setError('Stopped after the current item. Remaining items were not attempted.');
    } catch { setError('The batch stopped because its results could not be saved. Check Inventory before another attempt; no unfinished action will be replayed.'); }
    finally {
      runningRef.current = false; setRunning(false); close(); onChanged();
      setTimeout(() => report.current?.focus(), 0);
    }
  }
  const saved = receipt?.results.filter(row => row.kind === 'saved') ?? [];
  const remaining = receipt ? receipt.selection.length - receipt.results.length : 0;
  return <>
    {(receipt || error) && <section ref={report} tabIndex={-1} className={styles.report} aria-label="Archive results">
      <h2>Archive results</h2>
      {error && <p role="alert">{error}</p>}
      {receipt && <>
        <p>{new Date(receipt.at).toLocaleString()} · {saved.length} {receipt.action === 'archive' ? 'archived' : 'restored to Review'}</p>
        {!receipt.complete && !running && <p role="alert">This batch was interrupted. Check unrecorded outcomes in Inventory; nothing was replayed.</p>}
        {remaining > 0 && <p>{remaining} item(s) {receipt.complete ? 'not attempted' : 'without a recorded result'}.</p>}
        <ul>{receipt.results.map(row => <li key={row.id}><strong>{row.sku}</strong> · {row.kind} · {row.message}</li>)}</ul>
      </>}
      {!running && <div className={styles.actions}>
        <a className="btn" href="/inventory?state=Archived">View archived inventory</a>
        {receipt?.action === 'archive' && saved.length > 0 && <button className="btn" onClick={() => {
          setError(''); setRestore({ action: 'restore', items: saved.map(row => row.item!) });
        }}>Restore confirmed archives to Review</button>}
        <button className="btn" onClick={clearReport}>{unreadable ? 'Clear unreadable report' : 'Dismiss report'}</button>
      </div>}
    </section>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!runningRef.current) close(); }}>
      {active && <>
        <h2 id={heading}>{active.action === 'archive' ? 'Archive' : 'Restore to Review:'} {active.items.length} selected item(s)</h2>
        <p>{active.action === 'archive' ? 'Photos and history are kept. Archived items stay out of publishing and remain available in the Archived filter.'
          : 'These items return to Review and need approval again. Their photos and saved details are kept.'}</p>
        <p className="muted">Sold items, active or uncertain listings, and ongoing publishing work are protected. Marketplace listings are not removed by this action.</p>
        <ul className={styles.items}>{active.items.map(item => <li key={item.id}><strong>{item.sku}</strong>{item.title ? ` · ${item.title}` : ''} · {item.displayStatus ?? item.status}</li>)}</ul>
        {unreadable && <><p role="alert">Check Inventory and clear the unreadable report before starting another batch.</p><button className="btn" onClick={clearReport}>Clear unreadable report</button></>}
        {running && <p role="status">Recorded {receipt?.results.length ?? 0} of {active.items.length} results.</p>}
        {running && error && <p role="status">{error}</p>}
        <div className={styles.actions}>
          <button className="btn" autoFocus disabled={running} onClick={close}>Cancel</button>
          {running ? <button className="btn" onClick={() => { stopped.current = true; setError('Stopping after the current item.'); }}>Stop after current item</button>
            : <button className="btn btn-primary" disabled={unreadable} onClick={() => void apply()}>{active.action === 'archive' ? 'Confirm archive' : 'Confirm restore to Review'}</button>}
        </div>
      </>}
    </dialog>
  </>;
}
