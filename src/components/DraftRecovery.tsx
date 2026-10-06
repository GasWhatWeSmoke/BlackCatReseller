"use client";
import { useEffect, useState } from "react";
import type { DraftItem, DraftValue } from "@/lib/itemDrafts";
import type { ItemDraftRecovery } from "./useItemDraft";

const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2");
const display = (value: DraftValue | undefined) => value === null || value === undefined ? "Not set" : value === "" ? "Cleared" : String(value);

export function DraftRecovery({ recovery, item, compact = false, disabled = false }: { recovery: ItemDraftRecovery; item: DraftItem; compact?: boolean; disabled?: boolean }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => { setConfirmDiscard(false); }, [item.id, item.createdAt]);
  const { draft, conflicts, error, ready, other } = recovery;
  if (compact && ready && !recovery.dirty && !error && !conflicts.length && other === undefined) return null;
  return <div style={{ margin: "10px 0", fontSize: 13 }}>
    <p role="status" style={{ color: "var(--muted)", margin: "6px 0" }}>
      {!ready ? "Checking for a local draft…" : recovery.discarding ? "Discarding local edits…" : error ? "Local draft recovery needs attention. Keep this window open."
        : recovery.writing ? "Keeping draft on this device…"
        : recovery.dirty ? "Draft kept on this device. Save to update inventory." : "No unsaved field edits."}
    </p>
    {error && <div role="alert" style={{ color: "var(--warn)" }}>{error} {!ready && <button className="btn" onClick={recovery.retryRead}>Retry draft recovery</button>}</div>}
    {recovery.dirty && ready && other === undefined && <div style={{ marginBottom: 8 }}>
      {confirmDiscard ? <div role="group" aria-label="Confirm discarding local draft">
        <span>Discard these local edits? Saved inventory stays unchanged. </span>
        <button className="btn" disabled={disabled || recovery.discarding} onClick={() => { void recovery.discard().then(ok => { if (ok) setConfirmDiscard(false); }); }}>Discard local edits</button>
        <button className="btn" disabled={recovery.discarding} onClick={() => setConfirmDiscard(false)}>Keep editing</button>
      </div> : <button className="btn" disabled={disabled || recovery.discarding} onClick={() => setConfirmDiscard(true)}>Discard draft</button>}
    </div>}
    {!!conflicts.length && <div role="alert" className="card" style={{ padding: 14, borderColor: "var(--warn)" }}>
      <strong>Saved information changed while this draft was unfinished.</strong>
      <p>Compare the values below before saving. Your edits have been kept.</p>
      {conflicts.includes("status") && <div style={{ marginBottom: 12 }}>
        <p>Previous status: {draft?.baseline.status}. Current status: {item.status}.</p>
        {String(draft?.baseline.status).startsWith("Older draft:") && <ul>{Object.entries(draft?.changes ?? {}).map(([field, value]) =>
          <li key={field}>{label(field)}: {display(value)} (saved: {display(item[field] as DraftValue)})</li>)}</ul>}
        <button className="btn" onClick={() => recovery.resolve("status", true)}>I reviewed this draft against the current item</button>
      </div>}
      {conflicts.filter(field => field !== "status").map(field => <div key={field} style={{ borderTop: "1px solid var(--border)", padding: "10px 0", overflowWrap: "anywhere" }}>
        <strong>{label(field)}</strong><p>Saved: {display(item[field] as DraftValue)}<br />Your edit: {display(draft?.changes[field])}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="btn" onClick={() => recovery.resolve(field, true)}>Keep my edit</button>
          <button className="btn" onClick={() => recovery.resolve(field, false)}>Use saved value</button></div>
      </div>)}
    </div>}
    {other !== undefined && <div role="alert" className="card" style={{ padding: 14, borderColor: "var(--warn)" }}>
      <strong>Another window updated this local draft.</strong>
      <ul>{[...new Set([...Object.keys(draft?.changes ?? {}), ...Object.keys(other?.changes ?? {})])].map(field => <li key={field}>
        {label(field)} — this window: {display(draft?.changes[field])}; other window: {display(other?.changes[field])}</li>)}</ul>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="btn" onClick={() => recovery.chooseWindow(true)}>Keep this window's draft</button>
        <button className="btn" onClick={() => recovery.chooseWindow(false)}>Use the other window's draft</button></div>
    </div>}
  </div>;
}
