"use client";
// Run activity: the live queue. What is posting right now,
// per-marketplace tallies, every failure with its reason, and the controls —
// Pause / Resume / Cancel / Retry. Polls fast while a run is alive; the polling
// is also what revives the engine after an app restart.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ExternalLink, Loader2, Play, Pause, RotateCcw, Square, XCircle } from "lucide-react";
import { RUN_ACTIVE, type StatusPayload } from "@/lib/publish/uiTypes";
import UploadRunOverview from "./UploadRunOverview";
import RecoveryCenter from "./RecoveryCenter";
import { progressSummary } from '@/lib/publish/progressSummary';
import { usePolledRead } from './usePolledRead';

async function readRun(signal: AbortSignal): Promise<StatusPayload> {
  const response=await fetch('/api/publish/status',{cache:'no-store',signal});
  if(!response.ok)throw new Error('Could not refresh run activity. Controls will return when the connection recovers.');
  const data=await response.json();
  if(!Array.isArray(data?.marketplaces)||data.run===undefined||data.run!==null&&(
    !Number.isSafeInteger(data.run.id)||typeof data.run.status!=='string'||!Number.isSafeInteger(data.run.totalJobs)
    ||!Array.isArray(data.run.marketplaces)||!data.byMarketplace||!Array.isArray(data.jobs)))
    throw new Error('Run activity returned incomplete information. Refresh before controlling this run.');
  return data;
}

export default function DirectUploadProgress({ embedded = false }: { embedded?: boolean }) {
  const view=usePolledRead(readRun, data=>data?.run&&RUN_ACTIVE.has(data.run.status)?2500:15000);
  const {data:status,error,load}=view;
  const loaded=status!==null;
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const controlling = useRef(false);

  const run = status?.run ?? null;
  const runActive = !!run && RUN_ACTIVE.has(run.status);
  useEffect(() => {
    setNow(Date.now());
    if (!runActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runActive]);
  async function control(action: string, jobIds?: number[]) {
    if (!run || controlling.current || !view.isFresh()) return;
    if (action === "cancel" && !confirm("Cancel this run? Queued items will not be published (already-posted listings stay up).")) return;
    controlling.current = true; setBusy(true); view.invalidate();
    try {
      const r = await fetch(`/api/publish/runs/${run.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, jobIds }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `${action} failed`);
      if (action === "retry") toast.success(`${j.retried ?? 0} job(s) re-queued`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not update the upload."); }
    finally { await load(); controlling.current = false; setBusy(false); }
  }

  const connectionError = error && <div className="card" role="alert" style={{ padding: 16, borderColor: "var(--danger)" }}>{error} <button className="btn" onClick={() => void load()}>Try again</button></div>;
  const refreshButton = <button className="btn" style={{alignSelf:'flex-start'}} disabled={busy} onClick={()=>void load()}>Refresh activity</button>;
  if (error && !run) return connectionError;
  if (loaded && !run && view.fresh) {
    if (embedded) return null;
    return (
      <div className="card" style={{ padding: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          No crosslisting runs yet. Choose reviewed items under <Link href="/ready" style={{ fontWeight: 700 }}>Queue &amp; Auto Run</Link>.
          Progress, published links and any items needing attention will appear here.
        </p>
        {refreshButton}
      </div>
    );
  }
  if (!run) return <div className="card" style={{ padding: 16 }}><p role="status"><Loader2 size={15} className="spin" /> Loading run activity…</p>{refreshButton}</div>;
  if(embedded&&!runActive) {
    const progress=progressSummary(status!);
    return <>{connectionError}<div className="card" style={{padding:'16px 20px',display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',flexWrap:'wrap'}}>
      <div><strong style={{fontSize:13}}>Last run #{run.id} · {run.status==='cancelled'?'Cancelled':'Finished'}</strong><p className="muted" style={{fontSize:12,margin:'5px 0 0'}}>{progress.published} of {progress.total} listings confirmed{progress.attention?` · ${progress.attention} attempts to review`:''}</p></div>
      <Link className="btn" href={progress.attention?'/ready/recovery':'/ready/activity'}>{progress.attention?'Resolve upload issues':'View run details'}</Link>
    </div></>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth:0 }}>
      {connectionError}
      {!view.fresh && <p className="muted" role="status">Showing the last loaded run. Controls return after a successful refresh.</p>}
      {refreshButton}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Run #{run.id}</h2>
          <span className="chip">{run.status}</span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            started {new Date(run.startedAt).toLocaleString()}
            {run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ""}
          </span>
          {run.note && <span className="muted" style={{ fontSize: 12.5 }}>{run.note}</span>}
          <fieldset disabled={busy || !view.fresh} style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap", border: 0, padding: 0, minWidth:0 }}>
            {run.status === "running" && <button className="btn" onClick={() => void control("pause")}><Pause size={14} /> Pause</button>}
            {run.status === "paused" && <button className="btn btn-primary" onClick={() => void control("resume")}><Play size={14} /> Resume</button>}
            {RUN_ACTIVE.has(run.status) && <button className="btn btn-danger" onClick={() => void control("cancel")}><Square size={14} /> Cancel</button>}
            <Link className="btn" href="/ready/recovery">Resolve upload issues</Link>
          </fieldset>
        </div>
        {status && <UploadRunOverview status={status} now={now} stale={!!error} />}
      </div>

      <RecoveryCenter runId={run.id} compact />

      {(status?.published?.length ?? 0) > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <strong>Published this run ({status!.published!.length})</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8, fontSize: 13.5 }}>
            {status!.published!.map((p) => (
              <div key={p.jobId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap:'wrap' }}>
                <strong>{p.sku}</strong>
                <span className="chip">{p.marketplace}</span>
                {p.url && (
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    Open listing <ExternalLink size={12} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
