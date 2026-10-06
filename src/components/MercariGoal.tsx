"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { mercariGoal } from "@/lib/publish/mercariGoal";

export function MercariGoal({ editable = false }: { editable?: boolean }) {
  const [goal, setGoal] = useState<ReturnType<typeof mercariGoal> | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [lifted, setLifted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/publish/mercari-goal", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not refresh Mercari progress.");
      setGoal(await response.json()); setError(null);
    } catch (error) { setError((error as Error).message); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, [load]);
  async function save() {
    if (!goal || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/publish/mercari-goal", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked: !(lifted ?? (goal.tracking && !goal.blocked)), confirmedSaleSkus: selected ?? goal.sales.filter(sale => sale.confirmed).map(sale => sale.sku) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save Mercari progress.");
      setGoal(result); setSelected(null); setLifted(null); setError(null); toast.success("Mercari goal saved");
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  if (!goal) return <p className="muted" role="status">{error ?? "Loading Mercari progress…"}</p>;
  if (!goal.tracking && !editable) return null;
  const confirmed = selected ?? goal.sales.filter(sale => sale.confirmed).map(sale => sale.sku);
  if (!editable) return <section className="card" style={{ padding: "12px 17px", marginBottom: 16, display: "flex", gap: 15, flexWrap: "wrap", alignItems: "center" }} aria-label="Mercari five-sale goal">
    <strong style={{ fontSize: 13 }}>Mercari · {goal.completed}/{goal.target}</strong>
    <progress aria-label="Confirmed completed Mercari sales" value={Math.min(goal.completed, goal.target)} max={goal.target} style={{ width: 110, height: 7, accentColor: "var(--mint)" }} />
    <span className="muted" style={{ fontSize: 12 }}>{goal.blocked ? `New uploads paused · ${goal.remaining ? `${goal.remaining} sales remaining` : "confirm the restriction is lifted"}` : "Posting restriction lifted by you"}</span>
    <Link style={{ marginLeft: "auto", fontSize: 12 }} href="/settings#mercari-goal">Review goal ↗</Link>
    {error && <span role="alert">Progress could not refresh</span>}
  </section>;
  return <section className="card" style={{ padding: 20, marginBottom: 18, width: "100%" }} aria-label="Mercari five-sale goal">
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
      <div><h3 style={{ margin: "0 0 6px" }}>Mercari · five-sale goal</h3>
        <p style={{ margin: 0 }}>{goal.blocked ? "New uploads paused" : goal.tracking ? "Posting restriction lifted by you" : "Track your account’s listing restriction"}</p></div>
      <strong style={{ color: "var(--mint)", fontSize: 26 }}>{goal.completed} / {goal.target}</strong>
    </div>
    <progress aria-label="Confirmed completed Mercari sales" value={Math.min(goal.completed, goal.target)} max={goal.target}
      style={{ width: "100%", height: 10, marginTop: 14, accentColor: "var(--mint)" }} />
    <p className="muted">{goal.remaining ? `${goal.remaining} more completed sales to reach your goal.` : goal.blocked ? "Five-sale goal reached. Confirm Mercari has lifted the restriction before resuming uploads." : "Five-sale goal reached."}
      {goal.blocked && " Sale checks and removal of existing listings remain available."}</p>
    {error && <p role="alert" style={{ color: "var(--warn)" }}>{error} <button className="btn" onClick={() => void load()}>Refresh</button></p>}
    {editable ? <details><summary>Confirm completed sales</summary>
      <p className="muted">Select sales you have confirmed as completed in Mercari. Sold or shipped alone does not confirm completion.
        Refunded items returned to inventory do not count. This changes the goal tracker only.</p>
      {goal.sales.length ? goal.sales.map(sale => <label key={sale.sku} style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0" }}>
        <input type="checkbox" checked={confirmed.includes(sale.sku)} disabled={busy || !!error}
          onChange={event => { setSelected(event.target.checked ? [...confirmed, sale.sku] : confirmed.filter(sku => sku !== sale.sku)); setLifted(false); }} />
        Completed · <Link href={`/inventory/${sale.id}`}>Inventory {sale.sku}</Link>
      </label>) : <p>No Mercari sales are recorded yet.</p>}
      <label style={{ display: "block", margin: "14px 0" }}><input type="checkbox" checked={lifted ?? (goal.tracking && !goal.blocked)} disabled={busy || !!error || confirmed.length < goal.target}
        onChange={event => setLifted(event.target.checked)} /> I confirmed that Mercari has lifted the upload restriction</label>
      <button className="btn" disabled={busy || !!error} onClick={() => void save()}>{busy ? "Saving…" : "Save Mercari goal"}</button>
    </details> : <Link href="/settings#mercari-goal">Review completed sales in Settings →</Link>}
  </section>;
}
