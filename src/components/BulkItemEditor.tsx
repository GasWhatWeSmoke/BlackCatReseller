"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { BULK_EDIT_FIELDS, bulkEditSelection, editSelectedItems, parseBulkEditChanges,
  type BulkEditChanges, type BulkEditField, type BulkEditOutcome, type BulkEditResult, type BulkEditSelection } from '@/lib/bulkItemEdit';
import styles from './BulkItemEditor.module.css';

const RECEIPT_KEY = 'blackcat.inventory.bulk-edit.v1';
const DRAFT_KEY = 'blackcat.inventory.bulk-edit-fields.v1';
type Selection = BulkEditSelection & { title: string; displayStatus: string };
type Receipt = { at: string; selection: BulkEditSelection[]; changes: BulkEditChanges; results: BulkEditResult[]; complete: boolean };
type Props = { selection: Selection[] | null;
  edit: (item: BulkEditSelection, changes: BulkEditChanges) => Promise<BulkEditOutcome>;
  onClose: () => void; onChanged: () => void };

export function BulkItemEditor({ selection, edit, onClose, onChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [values, setValues] = useState<BulkEditChanges>({});
  const [confirmation, setConfirmation] = useState<BulkEditChanges | null>(null);
  const [running, setRunning] = useState(false), runningRef = useRef(false), stop = useRef(false);
  const [error, setError] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null);
  const results = useRef<HTMLElement>(null);
  useEffect(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft) {
        const saved = JSON.parse(draft);
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.entries(saved).some(([key, value]) =>
          !Object.hasOwn(BULK_EDIT_FIELDS, key) || !(value === null || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 2000))) throw Error();
        setValues(saved);
      }
    }
    catch { setError('The bulk-edit draft could not be restored. Enter its fields again.'); }
    try {
      const raw = localStorage.getItem(RECEIPT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Receipt;
      if (!Array.isArray(saved.selection) || saved.selection.length > 100 || !Array.isArray(saved.results) || saved.results.length > saved.selection.length)
        throw Error();
      saved.selection.forEach(bulkEditSelection); parseBulkEditChanges(saved.changes);
      if (saved.results.some(row => !saved.selection.some(item => item.id === row.id && item.sku === row.sku) ||
        !['saved', 'blocked', 'unknown'].includes(row.kind) || typeof row.message !== 'string')) throw Error();
      setReceipt(saved);
    } catch { setError('The previous bulk-edit report could not be read. Check saved inventory before another edit.'); }
  }, []);
  useEffect(() => {
    if (selection) { setConfirmation(null); setError(''); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [selection]);
  useEffect(() => {
    if (!running && (!selection || !Object.keys(values).length)) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [running, selection, values]);
  function updateValues(next: BulkEditChanges) {
    setValues(next);
    try { if (Object.keys(next).length) localStorage.setItem(DRAFT_KEY, JSON.stringify(next)); else localStorage.removeItem(DRAFT_KEY); }
    catch { setError('Draft fields could not be saved on this device. Keep this page open until you finish.'); }
  }
  function cancel() { updateValues({}); onClose(); }
  function record(value: Receipt) {
    // Save before the first mutation and after each receipt. Refresh never replays edits.
    localStorage.setItem(RECEIPT_KEY, JSON.stringify(value)); setReceipt(value);
  }
  async function apply() {
    if (!selection || !confirmation || runningRef.current) return;
    const current: Receipt = { at: new Date().toISOString(), selection: selection.map(bulkEditSelection), changes: confirmation, results: [], complete: false };
    runningRef.current = true; stop.current = false; setRunning(true); setError('');
    try {
      record(current);
      const finished = await editSelectedItems(current.selection, current.changes, edit, {
        stopped: () => stop.current,
        progress: rows => { current.results = rows; record({ ...current }); },
      });
      record({ ...current, results: finished, complete: true });
      updateValues({}); onClose(); setTimeout(() => results.current?.focus(), 0);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Bulk editing stopped. Check saved inventory before another edit.'); }
    finally { runningRef.current = false; setRunning(false); setConfirmation(null); onChanged(); }
  }
  const remaining = receipt ? receipt.selection.length - receipt.results.length : 0;
  return <>
    {receipt && <section ref={results} tabIndex={-1} className={styles.report} aria-label="Bulk edit results">
      <h2>Bulk edit results</h2><p>{new Date(receipt.at).toLocaleString()} · {receipt.results.filter(row => row.kind === 'saved').length} saved and returned to Review</p>
      {!receipt.complete && !running && <p role="alert">This edit was interrupted. Unrecorded outcomes need checking in Inventory; nothing was replayed.</p>}
      {remaining > 0 && <p>{remaining} item(s) {receipt.complete ? 'not attempted' : 'without a recorded result'}.</p>}
      <ul>{receipt.results.map(row => <li key={row.id}><strong>{row.sku}</strong> · {row.kind} · {row.message}</li>)}</ul>
      {!running && <button className="btn" onClick={() => { try { localStorage.removeItem(RECEIPT_KEY); setReceipt(null); } catch { setError('Could not clear this report.'); } }}>Dismiss report</button>}
    </section>}
    {error && !selection && <p role="alert">{error}</p>}
    {!selection && Object.keys(values).length > 0 && <p role="status">Bulk-edit fields restored. Select the current items and choose Edit selected to review them again.</p>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); if (!runningRef.current) cancel(); }}>
      {selection && <>
        <h2 id={title}>Edit {selection.length} selected item(s)</h2>
        <p>Only checked fields will change. A checked blank field clears its saved value. Each saved item returns to Review and needs approval again.</p>
        <p className="muted">Sold items, active or uncertain listings, and pending publishing work are protected. Their result will explain what needs attention.</p>
        {!confirmation ? <div className={styles.fields}>{Object.entries(BULK_EDIT_FIELDS).map(([name, label]) => {
          const key = name as BulkEditField, checked = Object.hasOwn(values, key), numeric = ['listedPrice', 'itemCost', 'weightOz'].includes(key);
          return <div className={styles.field} key={key}>
            <label><input type="checkbox" checked={checked} disabled={running} onChange={event => {
              const next = { ...values }; if (event.target.checked) next[key] = ''; else delete next[key]; updateValues(next);
            }} /> Change {label}</label>
            <input className="input" aria-label={label} disabled={!checked || running} value={values[key] ?? ''} inputMode={numeric ? 'decimal' : 'text'}
              maxLength={numeric ? 30 : key.endsWith('Notes') || key === 'notes' ? 2000 : 200}
              onChange={event => updateValues({ ...values, [key]: event.target.value })} />
          </div>;
        })}</div> : <>
          <h3>Confirm replacements</h3><dl className={styles.summary}>{Object.entries(confirmation).map(([key, value]) => <div key={key}>
            <dt>{BULK_EDIT_FIELDS[key as BulkEditField]}</dt><dd>{value === null || value === '' ? 'Clear saved value' : String(value)}</dd>
          </div>)}</dl>
          <ul className={styles.items}>{selection.map(item => <li key={item.id}><strong>{item.sku}</strong> · {item.title} · {item.displayStatus}</li>)}</ul>
        </>}
        {Object.hasOwn(values, 'weightOz') && <p className="muted">Weight applies to every selected item. Check the packed parcel; clearing weight allows the existing item-type estimate.</p>}
        {error && <p role="alert">{error}</p>}
        {running && <p role="status">Recorded {receipt?.results.length ?? 0} of {selection.length} results. Stopping waits for the current save.</p>}
        <div className={styles.actions}>
          <button className="btn" autoFocus disabled={running} onClick={cancel}>Cancel</button>
          {running ? <button className="btn" onClick={() => { stop.current = true; setError('Stopping after the current item…'); }}>Stop after current item</button>
            : confirmation ? <><button className="btn" onClick={() => setConfirmation(null)}>Back to fields</button>
              <button className="btn btn-primary" onClick={() => void apply()}>Apply edits and return to Review</button></>
              : <button className="btn btn-primary" onClick={() => { try { setConfirmation(parseBulkEditChanges(values)); setError(''); } catch (failure) { setError((failure as Error).message); } }}>Review changes</button>}
        </div>
      </>}
    </dialog>
  </>;
}
