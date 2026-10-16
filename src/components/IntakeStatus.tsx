"use client";
import { useEffect } from "react";
import Link from "next/link";
import { usePolledRead } from "./usePolledRead";
import { intakeStage } from "@/lib/intake";

export interface IntakeSnapshot {
  running: boolean;
  seq: number;
  event?: Record<string, unknown> | null;
  job?: {
    id: string; state: string; stage: string; updatedAt: string; heartbeatAt?: string;
    forceNoAi?: boolean;
    summary?: { itemsCreated?: number; problems?: number; collisions?: number; batchId?: number };
    error?: string | null;
  } | null;
}
async function readStatus(signal: AbortSignal): Promise<IntakeSnapshot> {
  const response = await fetch("/api/process/progress", { signal, cache: "no-store" });
  if (!response.ok) throw Error("Processing status is unavailable. Reconnecting…");
  return response.json();
}
export function useIntakeStatus() { return usePolledRead(readStatus, 2000); }

/** This observes server-owned work. Unmounting only aborts this read. */
export function IntakeStatus() {
  const status = useIntakeStatus();
  const snapshot = status.data, job = snapshot?.job;
  useEffect(() => {
    if (job && !snapshot?.running) window.dispatchEvent(new Event("blackcat:intake-updated"));
  }, [job?.id, job?.state, snapshot?.running]);
  if (!job && !snapshot?.running) return null;
  const progress = snapshot?.event ? intakeStage({ ...snapshot.event, type: "progress" }) : null;
  const issues = (job?.summary?.problems ?? 0) + (job?.summary?.collisions ?? 0);
  return <aside aria-label="Photo processing" aria-live="polite" style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 60,
    width: 460, maxWidth: "calc(100vw - 32px)", padding: "12px 16px", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 8px 28px #0006" }}>
    <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
      <strong>{status.error || (snapshot?.running ? progress?.label || "Processing photos…" : job?.state.replaceAll("_", " "))}</strong>
      <Link href={job ? `/batches?job=${encodeURIComponent(job.id)}` : "/batches"}>View batch</Link>
    </div>
    <div className="muted" style={{ fontSize: 12, marginTop: 5 }}>{progress?.sub}{job?.summary ? ` · ${job.summary.itemsCreated ?? 0} items saved · ${issues} review / error notices` : " · Originals remain on this computer"}</div>
    {job?.error && <p role="alert" style={{ margin: "6px 0 0", fontSize: 12 }}>{job.error}</p>}
    {snapshot?.running && progress?.pct != null && <progress aria-label="Batch progress" value={progress.pct} max={100} style={{ width: "100%", marginTop: 8 }} />}
  </aside>;
}
