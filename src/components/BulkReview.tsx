"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { approveReviewedBatch, MAX_REVIEW_BATCH, type BatchApprovalResult, type BatchReviewOperations } from "@/lib/bulkReview";
import { checkpointProblem, type ReviewCheckpoint, type ReviewItem, type ReviewRules } from "@/lib/reviewCheckpoint";
import { forgetReviewCheckpoint, listReviewCheckpoints } from "@/lib/reviewCheckpointStore";
import { browserReviewOperations } from "@/lib/reviewClient";
import { draftIdentity, listItemDrafts } from "@/lib/itemDrafts";
import { MARKETPLACE_NAMES } from "@/lib/publish/platforms";
import { inventoryState } from "@/lib/inventoryState";

interface Entry { checkpoint: ReviewCheckpoint; item: ReviewItem | null; problem: string | null }
interface Plan { checkpoints: ReviewCheckpoint[]; rules: ReviewRules; excluded: number }

export function BulkReview({ onReview, onBusy, onFinished, operations = browserReviewOperations }: {
  onReview: (id?: number) => void; onBusy: (busy: boolean) => void; onFinished: () => void;
  operations?: BatchReviewOperations;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [results, setResults] = useState<BatchApprovalResult[]>([]);
  const [total, setTotal] = useState(0);
  const stopped = useRef(false);
  const active = useRef(true);
  const runningRef = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const callbacks = useRef({ onBusy, onFinished }); callbacks.current = { onBusy, onFinished };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [checkpoints, rules, ...draftLists] = await Promise.all([
        listReviewCheckpoints(), operations.readRules(),
        listItemDrafts("review"), listItemDrafts("editor"), listItemDrafts("pricing"),
      ]);
      const dirty = new Set<string>();
      for (const [index, scope] of (["review", "editor", "pricing"] as const).entries())
        for (const draft of draftLists[index]) { const item = draftIdentity(draft.key, scope); dirty.add(`${item.id}:${item.createdAt}`); }
      const pending = checkpoints.filter(checkpoint => checkpoint.phase !== "approved").sort((a, b) => a.sku.localeCompare(b.sku));
      const next: Entry[] = new Array(pending.length); let position = 0;
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (position < pending.length) {
          const index = position++, checkpoint = pending[index];
          try {
            const item = await operations.readItem(checkpoint.id);
            const matching = item && item.createdAt === checkpoint.createdAt ? item : null;
            const problem = await checkpointProblem(checkpoint, matching, rules)
              || (dirty.has(`${checkpoint.id}:${checkpoint.createdAt}`) ? "Unfinished local edits must be saved or discarded first." : null);
            next[index] = { checkpoint, item: matching, problem };
          } catch (failure) { next[index] = { checkpoint, item: null, problem: failure instanceof Error ? failure.message : "Saved item unavailable." }; }
        }
      }));
      if (active.current) setEntries(next);
      return { entries: next, rules };
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "The reviewed batch could not be loaded.");
      return null;
    } finally { if (active.current) setLoading(false); }
  }, [operations]);

  useEffect(() => { active.current = true; void load(); return () => { active.current = false; stopped.current = true; }; }, [load]);
  useEffect(() => {
    if (plan) dialog.current?.showModal(); else dialog.current?.close();
  }, [plan]);
  useEffect(() => {
    callbacks.current.onBusy(running);
    if (!running) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigation = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.("a[href], [data-draft-navigation]")) {
        event.preventDefault(); event.stopPropagation(); setError("Use Stop after current item before switching screens. Completed approvals remain in Crosslisting.");
      }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigation, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigation, true); callbacks.current.onBusy(false); };
  }, [running]);

  async function preview() {
    const fresh = await load();
    if (!fresh) return;
    const wanted = fresh.entries.filter(entry => selected.has(entry.checkpoint.key));
    const eligible = wanted.filter(entry => !entry.problem).map(entry => entry.checkpoint);
    if (!eligible.length) { setError("No selected items still have a valid individual review. Review the changed items first."); return; }
    if (eligible.length > MAX_REVIEW_BATCH) { setError(`Choose up to ${MAX_REVIEW_BATCH} items for this batch.`); return; }
    setPlan({ checkpoints: eligible, rules: fresh.rules, excluded: selected.size - eligible.length });
  }

  async function approve() {
    if (!plan || runningRef.current) return;
    const confirmed = plan;
    runningRef.current = true; stopped.current = false;
    setPlan(null); setRunning(true); setStopping(false); setResults([]); setTotal(confirmed.checkpoints.length); setError(null);
    let completionMessage: string | null = null;
    try {
      const outcome = await approveReviewedBatch(confirmed.checkpoints, confirmed.rules, operations, {
        stopped: () => stopped.current,
        progress: result => { if (active.current) setResults(previous => [...previous, result]); },
      });
      if (outcome.remaining) completionMessage = `${outcome.remaining} item(s) were left untouched. Review the results before starting another batch.`;
    } catch (failure) { completionMessage = failure instanceof Error ? failure.message : "The batch could not start."; }
    finally {
      runningRef.current = false;
      if (active.current) { setRunning(false); setSelected(new Set()); await load(); if (active.current && completionMessage) setError(completionMessage); callbacks.current.onFinished(); }
    }
  }

  async function reviewAgain(entry: Entry) {
    try {
      await forgetReviewCheckpoint(entry.checkpoint);
      if (entry.item && ["Photographed", "Needs Info"].includes(entry.item.status)) onReview(entry.item.id);
      else { await load(); callbacks.current.onFinished(); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The checkpoint could not be changed."); }
  }

  const eligible = entries.filter(entry => !entry.problem);
  const selectionCount = eligible.filter(entry => selected.has(entry.checkpoint.key)).length;
  return <section aria-label="Individually reviewed batch">
    <h1 style={{ marginBottom: 8 }}>Batch approval</h1>
    <p className="muted">Review each item, then choose “Reviewed for batch & next.” Only unchanged reviews with no unfinished edits can be selected here.</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
      <button className="btn" disabled={running || loading} onClick={() => void load()}>Refresh reviewed items</button>
      <button className="btn" disabled={running || loading || !!error || !eligible.length}
        onClick={() => setSelected(new Set(eligible.slice(0, MAX_REVIEW_BATCH).map(entry => entry.checkpoint.key)))}>Select first {Math.min(eligible.length, MAX_REVIEW_BATCH)} eligible</button>
      <button className="btn" disabled={running || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
      <button className="btn btn-primary" disabled={running || loading || !selectionCount || !!error} onClick={() => void preview()}>Review batch ({selectionCount})</button>
    </div>
    {error && <p role="alert" style={{ color: "var(--warn)" }}>{error}</p>}
    {loading && <p role="status">Checking saved reviews and current item details…</p>}
    {running && <div className="card" style={{ padding: 16, marginBottom: 14 }}>
      <p role="status">{stopping ? "Stopping after the current item…" : "Preparing approvals…"} {results.length} / {total} checked.</p>
      <progress value={results.length} max={total} style={{ width: "100%" }} />
      <p>Stay on this screen while photos are prepared, or stop after the current item before switching screens. Completed approvals remain in Crosslisting.</p>
      <button className="btn" disabled={stopping} onClick={() => { stopped.current = true; setStopping(true); }}>Stop after current item</button>
    </div>}
    {!!results.length && <div className="card" style={{ padding: 16, marginBottom: 14 }} aria-label="Batch approval results">
      <strong>{results.filter(result => result.kind === "approved").length} approved · {results.filter(result => result.kind !== "approved").length} need attention</strong>
      {!!results.some(result => result.kind !== "approved") && <ul>{results.filter(result => result.kind !== "approved").map(result => <li key={result.id}>#{result.sku}: {result.message}</li>)}</ul>}
      {!!results.some(result => result.kind === "approved") && <details style={{ marginTop: 10 }}><summary>View approved items and notes</summary>
        <ul>{results.filter(result => result.kind === "approved").map(result => <li key={result.id}>#{result.sku}: {result.message}</li>)}</ul></details>}
    </div>}
    {!loading && !entries.length && !error && <div className="card" style={{ padding: 20 }}>
      <p>No individual reviews are waiting for batch approval.</p><button className="btn" disabled={running} onClick={() => onReview()}>Open Review queue</button>
    </div>}
    {!!entries.length && <div className="card" style={{ overflowX: "auto", padding: 12 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead><tr><th>Select</th><th>SKU / reviewed listing</th><th>Shared price</th><th>Photos</th><th>Review status</th><th>Action</th></tr></thead>
      <tbody>{entries.map(entry => <tr key={entry.checkpoint.key} style={{ borderTop: "1px solid var(--border)" }}>
        <td><input type="checkbox" aria-label={`Select ${entry.checkpoint.sku}`} disabled={running || loading || !!entry.problem || (selectionCount >= MAX_REVIEW_BATCH && !selected.has(entry.checkpoint.key))}
          checked={!entry.problem && selected.has(entry.checkpoint.key)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.checkpoint.key); else next.delete(entry.checkpoint.key); return next; })} /></td>
        <td style={{ padding: 10 }}><strong>{entry.checkpoint.sku}</strong><br />{entry.checkpoint.title}</td>
        <td>${entry.checkpoint.price.toFixed(2)}</td><td>{entry.checkpoint.photos}</td>
        <td style={{ maxWidth: 300, padding: 10 }}>{entry.problem || "Individually reviewed"}{entry.item && entry.problem && <small style={{ display: "block" }}>Saved status: {inventoryState(entry.item)}</small>}</td>
        <td>{entry.item && <a href={`/inventory/${entry.item.id}`}>Open item</a>}<br />
          <button className="btn" disabled={running} onClick={() => void reviewAgain(entry)}>{entry.item && ["Photographed", "Needs Info"].includes(entry.item.status) ? "Review again" : "Clear local checkpoint"}</button>
          {entry.checkpoint.phase !== "reviewed" && <small style={{ display: "block" }}>Clearing this checkpoint does not undo an approval. Check the saved item first.</small>}
        </td>
      </tr>)}</tbody>
    </table></div>}
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); setPlan(null); }}
      style={{ width: "min(760px, 92vw)", maxWidth: "calc(100vw - 32px)", boxSizing: "border-box", maxHeight: "85vh", overflow: "auto", overflowWrap: "anywhere", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 12, padding: 22 }}>
      {plan && <><h2 id={titleId}>Approve {plan.checkpoints.length} reviewed item{plan.checkpoints.length === 1 ? "" : "s"}?</h2>
        <p>{plan.rules.autoRun ? `Auto Run is on for ${plan.rules.marketplaces.map(name => MARKETPLACE_NAMES[name as keyof typeof MARKETPLACE_NAMES] ?? name).join(", ")}. Items may start publishing as they become ready.`
          : "Auto Run is off now. These items will become available in Crosslisting; enabling Auto Run can publish them later."}</p>
        {plan.rules.preserveMarketplacePrices && <p>Relisting keeps saved marketplace prices. The amounts below are shared item prices.</p>}
        {!!plan.excluded && <p role="alert">{plan.excluded} changed or unfinished item(s) were excluded.</p>}
        <ul>{plan.checkpoints.map(checkpoint => <li key={checkpoint.key}><strong>{checkpoint.sku}</strong> · ${checkpoint.price.toFixed(2)} · {checkpoint.photos} photo{checkpoint.photos === 1 ? "" : "s"} · {checkpoint.title}</li>)}</ul>
        <p>Each item is checked again before approval. Blocked items are reported separately; an unclear response stops the remaining batch. Stay on this screen, or stop after the current item before switching screens.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button className="btn" autoFocus onClick={() => setPlan(null)}>Keep reviewing</button>
          <button className="btn btn-primary" onClick={() => void approve()}>Approve {plan.checkpoints.length} item{plan.checkpoints.length === 1 ? "" : "s"}</button></div>
      </>}
    </dialog>
  </section>;
}
