"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePolledRead } from "@/components/usePolledRead";
import type { IntakeCorrections, IntakeManifest, IntakeVerification, ManifestPhoto } from "@/lib/intakeReview";
import type { IntakeSnapshot } from "@/components/IntakeStatus";

interface Review {
  job: NonNullable<IntakeSnapshot["job"]> & { committedPhotoIds?: string[]; forceNoAi?: boolean } | null;
  manifest?: IntakeManifest | null; verification?: IntakeVerification | null; corrections?: IntakeCorrections | null;
  problems?: { type?: string; message?: string; filename?: string }[];
}
type EvidencePhoto = ManifestPhoto & { sku?: string | null; markerReviewReason?: string; markerEvidence?: unknown };
const pageSize = 48;
export default function BatchReview() {
  const [jobId, setJobId] = useState("");
  useEffect(() => { setJobId(new URLSearchParams(window.location.search).get("job") ?? ""); }, []);
  const read = useCallback(async (signal: AbortSignal): Promise<Review> => {
    const response = await fetch(`/api/process/review${jobId ? `?job=${encodeURIComponent(jobId)}` : ""}`, { signal, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Batch review is unavailable.");
    return data;
  }, [jobId]);
  const view = usePolledRead(read, 3000), data = view.data, job = data?.job;
  const [order, setOrder] = useState<string[]>([]), [markers, setMarkers] = useState<Record<string, string | null>>({});
  const [orderVerified, setOrderVerified] = useState(false), [dirty, setDirty] = useState(false), [page, setPage] = useState(1);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState("");
  const [expectedRevision, setExpectedRevision] = useState(0);
  const manifest = data?.manifest, verification = data?.verification;
  useEffect(() => {
    if (!manifest || dirty) return;
    setOrder(data?.corrections?.order ?? manifest.photos.map(photo => photo.id));
    setMarkers({}); setOrderVerified(data?.corrections?.orderVerified === true);
    setExpectedRevision(data?.corrections?.revision ?? 0);
  }, [manifest, data?.corrections, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const photoMap = useMemo(() => new Map((verification?.photos ?? manifest?.photos ?? []).map(photo => [photo.id, photo as EvidencePhoto])), [verification, manifest]);
  const committed = new Set(job?.committedPhotoIds ?? []);
  const running = !!job && ["queued", "detecting", "processing", "persisting"].includes(job.state);
  const groups = verification?.groups ?? [], unresolved = verification?.unresolved ?? [];
  const totalPages = Math.max(1, Math.ceil(order.length / pageSize)), activePage = Math.min(page, totalPages);
  function move(id: string, delta: number) {
    const index = order.indexOf(id), target = index + delta;
    if (target < 0 || target >= order.length || committed.has(id) || committed.has(order[target])) return;
    const next = [...order]; [next[index], next[target]] = [next[target], next[index]];
    setOrder(next); setDirty(true); setOrderVerified(false);
  }
  async function save() {
    if (!job) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/process/review", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id, expectedRevision, order, markers, orderVerified }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      setDirty(false); setExpectedRevision(result.corrections.revision); setMarkers({});
      setMessage("Corrections saved. Resume this batch to revalidate its unresolved ranges."); await view.load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Save failed."); }
    finally { setSaving(false); }
  }
  async function resume() {
    if (!job || dirty) return;
    setSaving(true); setMessage("Reconnecting this batch to the local worker…");
    try {
      const response = await fetch("/api/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resumeJobId: job.id, force: job.forceNoAi === true }) });
      const events = (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const failure = events.find(event => event.type === "error" || event.type === "deferred");
      if (failure) throw Error(failure.reason || failure.error);
      if (!response.ok) throw Error("This batch could not be resumed.");
      setMessage("Batch status updated. Review any remaining exceptions below."); await view.load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Resume failed."); }
    finally { setSaving(false); }
  }
  return <div style={{ paddingBottom: 130 }}>
    <Link href="/">← Dashboard</Link><h1>Batch verification</h1>
    <p className="muted">Review photo order and the sticker that ends each item. Original photos remain available. The 32-photo limit includes the final sticker photo.</p>
    {view.error && <p role="alert">{view.error} <button className="btn" onClick={() => void view.load()}>Reconnect</button></p>}
    {!job ? <p>{view.refreshing ? "Loading batch…" : "No processing job yet. Import or resume pending photos from the Dashboard."}</p> : <>
      <section className="card" style={{ padding: 18 }} aria-label="Batch status">
        <strong>{job.state.replaceAll("_", " ")} · {job.stage}</strong>
        <p>{manifest?.photos.length ?? 0} durably stored photos · {(verification?.photos as EvidencePhoto[] | undefined)?.filter(photo => photo.sku).length ?? 0} detected markers · {groups.length} validated groups · {unresolved.length} unresolved ranges</p>
        {job.summary && <p>{job.summary.itemsCreated ?? 0} items saved · {(job.summary.problems ?? 0) + (job.summary.collisions ?? 0)} review / error notices</p>}
        {!!data?.problems?.length && <ul aria-label="Batch notices">{data.problems.map((problem, index) => <li key={index}>
          {problem.message || problem.type || "A processing issue needs review."}{problem.filename ? ` · ${problem.filename}` : ""}
        </li>)}</ul>}
        {job.error && <p role="alert">{job.error}</p>}
        <p className="muted">{running ? "You can visit other pages while this job runs. Stop processing before correcting the batch." : "Save corrections, then resume this same batch. Already saved item boundaries are protected."}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {running ? <button className="btn" onClick={async () => { await fetch("/api/process/cancel", { method: "POST" }); await view.load(); }}>Stop processing</button>
            : <button className="btn btn-primary" disabled={saving || dirty || !manifest || job.state === "completed"} onClick={() => void resume()}>Resume / revalidate this batch</button>}
          <button className="btn" disabled={running || saving || !dirty} onClick={() => void save()}>Save corrections</button>
          <Link className="btn" href="/inventory">Open inventory</Link>
        </div>
        {message && <p role="status">{message}</p>}{dirty && <p role="status">Save your corrections before leaving this page.</p>}
      </section>
      {verification?.orderReviewRequired && <p role="alert">Photo chronology is uncertain. Check the complete contact sheet and confirm the order before resuming.</p>}
      {!!unresolved.length && <section aria-label="Unresolved ranges"><h2>Needs review</h2>{unresolved.map((range, index) => <div className="card" key={index} style={{ padding: 12, marginBottom: 8 }}>
        <strong>{range.reason}</strong><p className="muted">{range.photoIds.length} photos · {range.photoIds.map(id => photoMap.get(id)?.originalFilename ?? id).join(", ")}</p>
        <button className="btn" onClick={() => setPage(Math.floor(Math.max(0, order.indexOf(range.photoIds[0])) / pageSize) + 1)}>Show range</button>
      </div>)}</section>}
      {!!groups.length && <details className="card" style={{ padding: 16, marginTop: 16 }}><summary>{groups.length} validated groups and final markers</summary>
        <table style={{ width: "100%" }}><thead><tr><th>SKU</th><th>Photos</th><th>Final marker</th><th>Review</th></tr></thead><tbody>{groups.map((group, index) => <tr key={`${group.sku}-${index}`}>
          <td>{group.sku}</td><td>{group.photoIds.length}</td><td>{photoMap.get(group.markerPhotoId ?? "")?.originalFilename ?? "Unknown"}</td><td>{group.reasons?.join("; ") || group.status || "validated"}</td>
        </tr>)}</tbody></table>
      </details>}
      {!!order.length && <section aria-label="Ordered source contact sheet">
        <h2>Source photos · {verification?.orderSource ?? manifest?.orderSource ?? "manifest"} order</h2>
        <label><input type="checkbox" checked={orderVerified} disabled={running || saving} onChange={event => { setOrderVerified(event.target.checked); setDirty(true); }} /> I checked the complete source order</label>
        <p className="muted">Enter a SKU only on its final inventory sticker photo. “Remove marker” confirms that photo does not end an item. Unknown readings stay unresolved.</p>
        <nav aria-label="Contact sheet pages" style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
          <button className="btn" disabled={activePage <= 1} onClick={() => setPage(activePage - 1)}>Previous photos</button><span>Page {activePage} of {totalPages}</span>
          <button className="btn" disabled={activePage >= totalPages} onClick={() => setPage(activePage + 1)}>Next photos</button>
        </nav>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
          {order.slice((activePage - 1) * pageSize, activePage * pageSize).map((id, offset) => {
            const photo = photoMap.get(id); if (!photo) return null;
            const saved = committed.has(id), explicit = id in markers ? markers[id] : data?.corrections?.markers[id];
            const marker = explicit === undefined ? photo.sku : explicit;
            const url = `/api/process/review/photo?job=${encodeURIComponent(job.id)}&photo=${encodeURIComponent(id)}`;
            return <article className="card" key={id} style={{ padding: 10, minWidth: 0 }}>
              <a href={`${url}&full=1`} target="_blank" rel="noreferrer"><img src={url} loading="lazy" alt={`Source ${photo.originalFilename}`} style={{ width: "100%", height: 175, objectFit: "contain", background: "var(--panel-2)" }} /></a>
              <p style={{ overflowWrap: "anywhere", fontSize: 12 }}>{(activePage - 1) * pageSize + offset + 1}. {photo.originalFilename}</p>
              <strong>{marker ? `END · ${marker}` : explicit === null ? "Confirmed non-marker" : "No verified marker"}</strong>
              {saved && <p className="muted">Saved to inventory</p>}{photo.markerReviewReason && <p>{photo.markerReviewReason}</p>}
              <label style={{ display: "block", marginTop: 8 }}>Correct end-marker SKU<input className="input" aria-label={`End marker for ${photo.originalFilename}`} value={typeof explicit === "string" ? explicit : ""} placeholder={marker || "BC-000042"} maxLength={9} disabled={running || saving || saved} onChange={event => { setMarkers(current => ({ ...current, [id]: event.target.value.toUpperCase() })); setDirty(true); }} style={{ width: "100%" }} /></label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <button className="btn" disabled={running || saving || saved} onClick={() => { setMarkers(current => ({ ...current, [id]: null })); setDirty(true); }}>Remove marker</button>
                <button className="btn" aria-label={`Move ${photo.originalFilename} earlier`} disabled={running || saving || saved || order.indexOf(id) === 0} onClick={() => move(id, -1)}>←</button>
                <button className="btn" aria-label={`Move ${photo.originalFilename} later`} disabled={running || saving || saved || order.indexOf(id) === order.length - 1} onClick={() => move(id, 1)}>→</button>
              </div>
              {!!photo.markerEvidence && <details style={{ fontSize: 12, marginTop: 8 }}><summary>Marker evidence</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(photo.markerEvidence, null, 2)}</pre></details>}
            </article>;
          })}
        </div>
      </section>}
    </>}
  </div>;
}
