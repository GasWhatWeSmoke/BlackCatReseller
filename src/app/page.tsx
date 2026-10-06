"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, GitMerge, FolderUp, ClipboardList, Upload, Boxes, Loader2, CheckCircle2, ArrowRight, Play, X, Tag, BadgeDollarSign, Rocket } from "lucide-react";
import { CatMark } from "@/components/CatMark";
import HubActivity from "@/components/HubActivity";
import { MercariGoal } from "@/components/MercariGoal";
import { intakeStage, pollIntakeProgress, type IntakeProgress } from "@/lib/intake";
import { intakeFeedback, type IntakeSummary } from "@/lib/intakeOutcome";
import { problemMeta } from "@/lib/problemMeta";
import { usePolledRead } from '@/components/usePolledRead';
import { readSetupView, saveSetupChoice } from '@/lib/setupClient';
import { dashboardStatsView, collisionPageView, problemPageView, dismissalResult, type DashboardProblem, type DashboardPage } from '@/lib/dashboardDataView';
import styles from "./dashboard.module.css";
import { averageItemSalePrice } from '@/lib/dashboardSales';

// The dashboard IS the intake surface (the old /upload tab was folded in here —
// photo drops and the folder button both start here):
// upload button + live progress + last-result banner + collision/problem panels, plus the
// action stats. No passive history lists.

type Problem = DashboardProblem;
interface UploadResult { ok: boolean; text: string; created: number; }

async function readView<T>(url: string, signal: AbortSignal, validate: (value: unknown) => T): Promise<T> {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw Error(data?.error || 'This view could not be refreshed.');
  return validate(data);
}
const readStats = (signal: AbortSignal) => readView('/api/stats', signal, dashboardStatsView);

export default function Dashboard() {
  const [collisionPage, setCollisionPage] = useState(1), [problemPage, setProblemPage] = useState(1);
  const statsRead = usePolledRead(readStats, 30000);
  const collisionRead = usePolledRead(useCallback((signal: AbortSignal) => readView(`/api/collisions?page=${collisionPage}`, signal, collisionPageView), [collisionPage]), 30000);
  const problemRead = usePolledRead(useCallback((signal: AbortSignal) => readView(`/api/problems?page=${problemPage}`, signal, problemPageView), [problemPage]), 30000);
  const stats = statsRead.data, collisions = collisionRead.data?.collisions ?? [], problems = problemRead.data?.problems ?? [];
  const [resolvingGroup, setResolvingGroup] = useState<number | null>(null);
  const resolvingRef = useRef(false);
  const dismissingRef = useRef(false);
  const [dismissing, setDismissing] = useState<number | 'all' | null>(null), [dismissError, setDismissError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState<IntakeProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);

  // Setup guide banner. A new user lands HERE, not on the guide, so the dashboard has to
  // point at it — and only while something is genuinely unfinished.
  const setupRead = usePolledRead(readSetupView, null);
  const [setupHidden, setSetupHidden] = useState(false), [setupHiding, setSetupHiding] = useState(false), [setupHideError, setSetupHideError] = useState<string | null>(null);
  const setupHidingRef = useRef(false), setup = setupRead.data?.progress ?? null;
  const setupDismissed = setupHidden || setupRead.data?.dismissed !== false;
  async function hideSetup() {
    if (setupHidingRef.current || !setupRead.isFresh()) return;
    setupHidingRef.current = true; setSetupHiding(true); setSetupHideError(null);
    try { await saveSetupChoice({ dismissed: true }); setSetupHidden(true); }
    catch (error) { setSetupHideError(error instanceof Error ? error.message : 'The setup guide preference could not be saved.'); }
    finally { setupHidingRef.current = false; setSetupHiding(false); }
  }

  // Cancel the reading/grouping run mid-flight. The server kills the worker tree;
  // the stream then ends with a "cancelled" event (handled in processInto), and the
  // photos stay pending in /incoming with the one-click resume banner.
  async function cancelProcessing() {
    setCancelling(true);
    try { await fetch("/api/process/cancel", { method: "POST" }); } catch { /* ignore */ }
  }

  const loadStats = statsRead.load, loadCollisions = collisionRead.load, loadProblems = problemRead.load;
  const latestReads = useRef({ loadStats, loadCollisions, loadProblems });
  latestReads.current = { loadStats, loadCollisions, loadProblems };
  const load = useCallback(() => { const current = latestReads.current; return Promise.all([current.loadStats(), current.loadCollisions(), current.loadProblems()]); }, []);
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener("blackcat:intake-updated", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("blackcat:intake-updated", refresh); window.removeEventListener("focus", refresh); };
  }, [load]);
  useEffect(() => {
    if (dismissing === null && resolvingGroup === null) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dismissing, resolvingGroup]);

  // `webkitdirectory` isn't in React's input typings — set it on the DOM node so the
  // browser-fallback file picker chooses a whole folder.
  useEffect(() => {
    const el = folderInput.current;
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);

  // Group the just-imported /incoming photos into items. Reads the NDJSON progress STREAM
  // so the UI shows what's happening live (current SKU + counts), then reports the outcome.
  async function processInto(t: string | number, force = false) {
    setProgress({ label: "Scanning photos…", pct: 1 });
    // The POST stays headless until the worker admits (after hashing/EXIF/decode).
    // Poll the snapshot until the stream opens, then let the stream drive.
    let streamOpen = false;
    const stopPolling = pollIntakeProgress((p) => { if (!streamOpen) setProgress(p); });
    type Summary = IntakeSummary;
    let summary: Summary | null = null;
    let errorMsg: string | null = null;
    let errorReason: string | null = null;
    let cancelled = false;
    let terminalCount = 0;
    let protocolError: string | null = null;
    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const reader = res.body?.getReader();
      if (reader) {
        const dec = new TextDecoder();
        let buf = "";
        const handle = (ev: Record<string, unknown>) => {
          if (ev.type === "done") { terminalCount += 1; summary = ev.summary as Summary; return; }
          if (ev.type === "cancelled") { terminalCount += 1; cancelled = true; return; }
          if (ev.type === "deferred") {
            terminalCount += 1;
            errorMsg = "VISION_DEFERRED";
            errorReason = ev.reason ? String(ev.reason) : null;
            return;
          }
          if (ev.type === "error") {
            terminalCount += 1;
            errorMsg = String(ev.error);
            errorReason = ev.reason ? String(ev.reason) : null;
            return;
          }
          if (ev.type === "progress") {
            if (!streamOpen) { streamOpen = true; stopPolling(); }
            const p = intakeStage(ev);
            if (p) setProgress(p);
            return;
          }
          protocolError = "invalid process stream event";
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try { handle(JSON.parse(line)); }
            catch { protocolError = "invalid process stream JSON"; }
            if (terminalCount > 1) protocolError = "multiple process stream terminal events";
          }
        }
        if (buf.trim()) protocolError = "truncated process stream";
      } else {
        const j = await res.json().catch(() => ({ type: "error", error: "Server error" }));
        if (j.type === "done") summary = j.summary;
        else if (j.type === "deferred") {
          errorMsg = "VISION_DEFERRED";
          errorReason = j.reason ? String(j.reason) : null;
        } else errorMsg = j.error || "Processing failed";
      }
      if (protocolError || terminalCount !== 1) {
        errorMsg = protocolError || "process stream ended without one terminal result";
        summary = null;
        cancelled = false;
      }
    } catch (e) {
      errorMsg = "Processing failed: " + String(e);
    }
    stopPolling();
    setProgress(null);
    setCancelling(false);

    if (cancelled) {
      const m = "Cancelled — nothing was saved. The photos are still pending; use “Process them now” whenever you're ready.";
      toast.message(m, { id: t, duration: 8000 });
      setResult({ ok: false, text: m, created: 0 });
      await load();
      return;
    }
    if (errorMsg || !summary) {
      // Managed admission failed before intake mutation. Offer explicit no-AI
      // intent, but never turn retryable queue pressure into a blank import.
      if (errorMsg === "VISION_DEFERRED" || errorMsg === "VISION_UNAVAILABLE") {
        const deferred = errorMsg === "VISION_DEFERRED";
        const reason = errorReason || (deferred
          ? "another local vision batch is running"
          : "the local vision runtime is unavailable");
        const m = deferred
          ? `AI vision is busy — ${reason}. Nothing was imported or changed; the photos remain pending. Retry shortly.`
          : `AI identification is unavailable — ${reason}. Nothing was imported or changed; the photos remain pending.`;
        toast.error(m, {
          id: t, duration: 30000,
          action: { label: "Import anyway (no AI)", onClick: () => { void processInto(toast.loading("Importing without AI…"), true); } },
        });
        setResult({
          ok: false,
          text: m + " You can retry, use Settings → AI Vision → Test local vision, or explicitly import without AI and use Retry AI later.",
          created: 0,
        });
        await load();
        return;
      }
      const msg = errorMsg === "WORKER_VENV_MISSING"
        ? "The photo worker isn't installed yet — run worker setup, then try again."
        : errorMsg === "INTAKE_BUSY"
        ? "A photo batch is being imported or read — wait for it to finish before starting another."
        : (errorMsg || "Processing failed.");
      toast.error(msg, { id: t, duration: 8000 });
      setResult({ ok: false, text: msg, created: 0 });
      await load();
      return;
    }
    const feedback = intakeFeedback(summary);
    toast[feedback.tone](feedback.text, { id: t, duration: feedback.ok ? 10000 : 15000 });
    setResult({ ok: feedback.ok, text: feedback.text, created: feedback.created });
    await load();
  }

  // Upload a whole folder of photos AND group them into items in one step. Prefers the
  // desktop's native folder picker + a server-side copy (reliable for big folders);
  // falls back to a web folder input.
  async function uploadFolder() {
    setResult(null);
    const native = (window as Window & { blackcat?: { pickFolder?: () => Promise<string | null> } }).blackcat;
    if (native?.pickFolder) {
      const folderPath = await native.pickFolder();
      if (!folderPath) return; // cancelled
      setBusy(true);
      const t = toast.loading("Importing folder…");
      try {
        const res = await fetch("/api/import-folder", { method: "POST", body: JSON.stringify({ folderPath }) });
        const j = await res.json().catch(() => ({ ok: false, error: "Server error" }));
        if (!res.ok || !j.ok) {
          toast.error(j.error || "Import failed", { id: t, duration: 8000 });
          setResult({ ok: false, text: j.error || "Import failed.", created: 0 });
          return;
        }
        if (j.failed || j.imported !== j.found) {
          const message = `Imported ${j.imported} of ${j.found} photos. Grouping has not started because the batch is incomplete. ` +
            `The copied photos are retained in Incoming. Add the missing photos before processing. ` +
            (j.failedFiles ?? []).join(", ");
          toast.warning(message, { id: t, duration: 12000 });
          setResult({ ok: false, text: message, created: 0 });
          await load();
          return;
        }
        toast.loading(`Imported ${j.imported} photo(s) — grouping into items…`, { id: t });
        await processInto(t);
      } catch (e) {
        toast.error("Import failed: " + String(e), { id: t, duration: 8000 });
        setResult({ ok: false, text: "Import failed: " + String(e), created: 0 });
      } finally {
        setBusy(false);
      }
    } else {
      folderInput.current?.click(); // browser fallback
    }
  }

  // Browser fallback: upload the selected folder's JPEGs over HTTP, then process.
  async function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const all = Array.from(e.target.files ?? []);
    const files = all.filter((f) => /\.jpe?g$/i.test(f.name));
    if (folderInput.current) folderInput.current.value = "";
    if (!files.length) { toast.error("That folder has no JPEG images (.jpg/.jpeg)."); return; }
    setResult(null);
    setBusy(true);
    const t = toast.loading(`Uploading ${files.length} photo(s)…`);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({ imported: 0 }));
      if (!res.ok || !j.imported) {
        const message = j.error || "Upload failed — no photos imported.";
        toast.error(message, { id: t, duration: 8000 });
        setResult({ ok: false, text: message, created: 0 });
        return;
      }
      if (j.imported !== files.length || j.failed?.length || j.skipped?.length) {
        const message = `Uploaded ${j.imported} of ${files.length} photos. Grouping has not started because the batch is incomplete. ` +
          `The uploaded copies are retained in Incoming. Add the missing photos before processing. ` +
          [...(j.failed ?? []), ...(j.skipped ?? [])].join(", ");
        toast.warning(message, { id: t, duration: 12000 });
        setResult({ ok: false, text: message, created: 0 });
        await load();
        return;
      }
      toast.loading(`Uploaded ${j.imported} photo(s) — grouping into items…`, { id: t });
      await processInto(t);
    } catch (e) {
      toast.error("Upload failed: " + String(e), { id: t, duration: 8000 });
      setResult({ ok: false, text: "Upload failed: " + String(e), created: 0 });
    } finally {
      setBusy(false);
    }
  }

  async function resolve(id: number, resolution: string) {
    if (busy || resolvingRef.current || !collisionRead.isFresh() || !collisions.some(group => group.id === id && !group.error)) return;
    const sku = collisions.find(group => group.id === id)?.sku ?? "this item";
    if (resolution === "replace" && !confirm(`Replace the current photos for ${sku}?\n\nThe incoming photos will take their place. Archived originals and shared files are kept.`)) return;
    resolvingRef.current = true; setResolvingGroup(id);
    collisionRead.invalidate();
    try {
      const response = await fetch(`/api/collisions/${id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution }) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "Photo resolution could not be confirmed. Reload the current groups.");
      toast.success(`${resolution === "new" ? "Created" : "Updated"} ${result.target?.sku ?? sku}${result.duplicatesSkipped ? ` · ${result.duplicatesSkipped} duplicate photo(s) skipped` : ""}`);
      if (result.cleanupWarnings?.length) toast.warning(result.cleanupWarnings.join(" "));
    } catch (error) { toast.error(error instanceof Error ? error.message : "Photo resolution could not be confirmed."); }
    finally { await load().catch(() => {}); resolvingRef.current = false; setResolvingGroup(null); }
  }
  async function resolveProblem(id: number | null) {
    if (dismissingRef.current || !problemRead.isFresh() || (id !== null && !problems.some(problem => problem.id === id))) return;
    if (id === null && !confirm(`Dismiss all ${problemRead.data!.total} open problems across all pages?\n\nThis clears their reminders; it does not repair photos or listings.`)) return;
    dismissingRef.current = true; setDismissing(id ?? 'all'); setDismissError(null); problemRead.invalidate();
    const notice = toast.loading('Dismissing problems…');
    try {
      const response = await fetch('/api/problems', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id === null ? { all: true } : { id }) });
      const data = await response.json();
      if (!response.ok) throw Error(data?.error || 'Problem dismissal could not be confirmed. Refresh before trying again.');
      const result = dismissalResult(data, id);
      toast.success(result.resolved ? `Dismissed ${result.resolved} open problem(s).` : 'These problems were already closed.', { id: notice });
      await Promise.all([loadProblems(), loadStats()]);
    } catch (error) {
      problemRead.invalidate();
      const message = error instanceof Error ? error.message : 'Problem dismissal could not be confirmed. Refresh before trying again.';
      setDismissError(message); toast.error(message, { id: notice, duration: 10000 });
    } finally { dismissingRef.current = false; setDismissing(null); }
  }

  // One-click batch recovery for "AI Identification Failed": re-runs identification
  // for every item still missing AI data, straight from the dashboard. The server
  // resolves the problem row itself once nothing is failing anymore.
  const [aiRetryBusy, setAiRetryBusy] = useState(false);
  async function retryFailedAi() {
    if (aiRetryBusy) return;
    setAiRetryBusy(true);
    const t = toast.loading("Re-running AI identification for failed items… (each item takes ~20s)");
    try {
      const res = await fetch("/api/items/reidentify-failed", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(`AI retry failed — ${j.error ?? res.statusText}`, { id: t, duration: 12000 });
      } else if (j.retried === 0) {
        toast.success(j.message ?? "Nothing left to retry — all items have AI data.", { id: t });
      } else if (j.ok) {
        toast.success(`AI identification recovered all ${j.recovered} item(s). They're in Review.`, { id: t, duration: 8000 });
      } else {
        toast.warning(
          `AI recovered ${j.recovered} of ${j.retried} — still failing: ${(j.stillFailing ?? []).map((f: { sku: string }) => f.sku).join(", ")}. ` +
            "Check Settings → AI Vision → Test.",
          { id: t, duration: 12000 },
        );
      }
    } catch (e) {
      toast.error(`AI retry failed — ${e instanceof Error ? e.message : String(e)}`, { id: t });
    } finally {
      setAiRetryBusy(false);
      await load();
    }
  }

  const sc = stats?.statusCounts ?? {};
  // "Needs review" = anything not yet readied: freshly photographed + flagged.
  const reviewCount = stats ? (sc["Photographed"] ?? 0) + (sc["Needs Info"] ?? 0) : '—';
  const issues = stats ? stats.problemsOpen + stats.collisionsOpen : '—';
  const lifetime = stats?.lifetimeSales;
  const averageSale = lifetime ? averageItemSalePrice(lifetime) : null;
  const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className="hub-eyebrow">YOUR RESELLING STUDIO</div>
          <h1 className="hub-title">Dashboard</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Your inventory, sales, and next batch.
          </p>
        </div>
        <button className="btn btn-primary" onClick={uploadFolder} disabled={busy} style={{ fontSize: 15, padding: "11px 20px" }}>
          {busy ? <Loader2 size={18} className="spin" /> : <FolderUp size={18} />} {busy ? "Working…" : "Upload folder"}
        </button>
      </div>
      <ReadStatus label="Dashboard totals" hasData={!!stats} error={statsRead.error} refreshing={statsRead.refreshing} fresh={statsRead.fresh} retry={() => void loadStats()} />
      {stats?.incomingError && <p role="alert" className="card" style={{ padding: 14 }}>{stats.incomingError}</p>}
      <section className={styles.results} aria-label="Lifetime sales" aria-busy={statsRead.refreshing}>
        <Link href="/sales/insights" className={styles.earned} data-depth>
          <div className={styles.label}><BadgeDollarSign size={17} /> TOTAL EARNED · ALL TIME</div>
          <div className={styles.value}>{lifetime ? money(lifetime.totalEarned) : "—"}</div>
          <div className={styles.breakdown}><span>Item sales <strong>{lifetime ? money(lifetime.itemSales) : "—"}</strong></span><span>Shipping received <strong>{lifetime ? money(lifetime.shippingReceived) : "—"}</strong></span></div>
          <p className={styles.note}>Your recorded sales + shipping income, before fees and costs.</p>
          {!!lifetime?.missingSalePrices && <p className={styles.note}>{lifetime.missingSalePrices} sold item(s) still need their sale amount recorded.</p>}
          {!!lifetime?.missingShipping && <p className={styles.note}>Unrecorded shipping is not included.</p>}
        </Link>
        <Link href="/sales" className={styles.sold}>
          <div className={styles.label}><Tag size={17} /> ITEMS SOLD · ALL TIME</div>
          <div className={styles.value}>{lifetime ? lifetime.itemsSold.toLocaleString() : "—"}</div>
          <p className={styles.note}>Every sold piece, counted once across your marketplaces.</p>
          <p className={styles.note}>Average item sale price <strong>{averageSale === null ? '—' : money(averageSale)}</strong></p>
          <p className={styles.note}>{lifetime ? `${lifetime.itemsSold - lifetime.missingSalePrices} recorded item price(s); shipping excluded.` : 'Recorded prices unavailable.'}</p>
        </Link>
      </section>
      <div className={styles.journey}><strong>1. Add & process photos</strong><ArrowRight size={14} /><Link href="/review">2. Review items ({reviewCount})</Link><ArrowRight size={14} /><Link href="/ready">3. Crosslisting ({stats?.readyCount ?? '—'} ready)</Link></div>
      <input ref={folderInput} type="file" multiple accept="image/jpeg" onChange={onFolderPicked} style={{ display: "none" }} />

      {(setupRead.error || setupHideError) && <p role="alert" style={{ color: 'var(--warn)' }}>{setupHideError || setupRead.error} <button className="btn" onClick={async () => { if (await setupRead.load()) setSetupHideError(null); }} disabled={setupHiding}>Re-check setup guide</button> <Link href="/setup">Open setup guide</Link></p>}
      {setup && !setup.complete && !setupDismissed && (
        <div className="card" style={{ padding: 16, marginBottom: 20, borderColor: "var(--accent)", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <Rocket size={20} style={{ color: "var(--accent)" }} />
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              Finish setting up — {setup.done} of {setup.total} done
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
              A short, checked-as-you-go list: install the worker, point at your photo folder,
              connect your marketplaces, then list your first item.
            </div>
          </div>
          <Link className="btn btn-primary" href="/setup" style={{ fontSize: 13 }}>
            Open the guide <ArrowRight size={14} />
          </Link>
          <button
            className="btn"
            style={{ fontSize: 12 }}
            title="Hide this. The guide stays available in the sidebar."
            disabled={setupHiding || !setupRead.fresh}
            onClick={() => void hideSetup()}
          >
            <X size={13} /> {setupHiding ? 'Saving…' : 'Hide'}
          </button>
        </div>
      )}

      {/* Live intake progress — label + counts + an honest percent bar + Cancel. */}
      {progress && (
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, marginBottom: progress.pct != null ? 10 : 0 }}>
            <Loader2 size={15} className="spin" />
            <span>{progress.label}</span>
            {progress.sub && <span className="muted">{progress.sub}</span>}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              {progress.pct != null && <span className="muted" style={{ fontSize: 12 }}>{Math.round(progress.pct)}%</span>}
              <button className="btn" onClick={cancelProcessing} disabled={cancelling} data-sound="none"
                title="Stop reading this batch — nothing is saved; the photos stay pending so you can process them later">
                <X size={14} /> {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </span>
          </div>
          {progress.pct != null && (
            <div style={{ height: 8, borderRadius: 999, background: "var(--panel-2)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 999, background: "var(--accent)", width: `${Math.min(100, progress.pct)}%`, transition: "width .4s ease" }} />
            </div>
          )}
        </div>
      )}

      {/* Resume affordance: photos imported but never processed (e.g. an interrupted run).
          Originals-safe design means they're just sitting in /incoming — one click resumes. */}
      {!progress && !busy && (stats?.incomingCount ?? 0) > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 20, borderColor: "var(--warn)", display: "flex", alignItems: "center", gap: 12 }}>
          <AlertTriangle size={18} color="var(--warn)" />
          <span style={{ flex: 1, fontSize: 14 }}>
            <strong>{stats!.incomingCount} photo(s)</strong> are imported but not yet processed (an earlier run didn’t finish). Nothing is lost — pick up where it left off.
          </span>
          <button className="btn btn-primary" disabled={!statsRead.fresh} onClick={async () => {
            if (!statsRead.isFresh()) return;
            setBusy(true);
            const t = toast.loading("Processing pending photos…");
            try { await processInto(t); } finally { setBusy(false); }
          }}>
            <Play size={15} /> Process them now
          </button>
          <button
            className="btn btn-danger"
            disabled={!statsRead.fresh}
            data-sound="none"
            title="Discard the pending photos (e.g. you dropped the wrong ones)"
            onClick={async () => {
              if (!statsRead.isFresh()) return;
              if (!confirm(
                `Discard ${stats!.incomingCount} pending photo(s)?\n\n` +
                `This only deletes the app's imported COPIES waiting to be processed — the ` +
                `original files on your computer are untouched, so you can re-drop the right ` +
                `ones anytime. Items already in your inventory are not affected.`,
              )) return;
              const t = toast.loading("Discarding pending photos…");
              try {
                const r = await fetch("/api/maintenance/clear-incoming", { method: "POST" });
                const j = await r.json().catch(() => ({ ok: false }));
                if (r.ok && j.ok) toast.success(`Discarded ${j.removed} pending photo(s).`, { id: t });
                else toast.error(j.error || "Could not discard", { id: t });
              } catch (e) { toast.error(String(e), { id: t }); }
              load();
            }}
          >
            <X size={15} /> Discard
          </button>
        </div>
      )}

      {/* Persistent result of the last upload (so the outcome is obvious, not just a toast). */}
      {result && !progress && (
        <div className="card" style={{
          padding: 16, marginBottom: 20, display: "flex", alignItems: "center", gap: 12,
          borderColor: result.ok ? "#2e7d32" : "#8a6d00",
        }}>
          {result.ok ? <CheckCircle2 size={20} color="var(--ok)" /> : <AlertTriangle size={20} color="var(--warn)" />}
          <span style={{ flex: 1, fontSize: 14 }}>{result.text}</span>
          {result.ok && result.created > 0 && (
            <Link href="/review" className="btn btn-primary">Review them <ArrowRight size={15} /></Link>
          )}
        </div>
      )}

      {/* First-run welcome: an empty inventory gets the cat, not four zeros. */}
      {statsRead.fresh && stats && stats.totalItems === 0 && (
        <div className="card" style={{ padding: 36, marginBottom: 22, textAlign: "center", borderColor: "var(--accent)" }}>
          <CatMark size={52} blink />
          <div style={{ fontSize: 18, fontWeight: 800, margin: "12px 0 4px" }}>Welcome to Black Cat</div>
          <p className="muted" style={{ margin: "0 0 14px", fontSize: 14 }}>
            Photograph your items (SKU sticker last), then drop the photos on this Dashboard —
            they’ll be grouped, logged, and made ready to list automatically.
          </p>
          <button className="btn btn-primary" onClick={uploadFolder} disabled={busy}>
            <FolderUp size={16} /> Upload your first folder
          </button>
        </div>
      )}

      {/* Only the stats that drive a real action — plus the two outcomes that matter
          (what's live, what's sold), each linking to its list. */}
      <div className={styles.metrics}>
        <StatCard href="/inventory" icon={<Boxes size={20} />} label="Total inventory" value={stats?.totalItems ?? '—'} />
        <StatCard href="/review" icon={<ClipboardList size={20} />} label="Needs review" value={reviewCount} />
        <StatCard href="/ready" icon={<Upload size={20} />} label="Ready for crosslisting" value={stats?.readyCount ?? '—'} />
        <StatCard href="/ready/history" icon={<Tag size={20} />} label="Listed" value={stats?.listedCount ?? '—'}
          sub="Across your connected marketplaces" />
        <StatCard href="#issues" icon={<GitMerge size={20} />} label="Issues (collisions/problems)" value={issues} muted={issues === 0} />
      </div>

      <section className={styles.stockValues} aria-label="Inventory value" aria-busy={statsRead.refreshing}>
        <div><h2>Inventory value</h2><p>{stats?.stockValue ? `${stats.stockValue.activeItems} active unsold items. Sold, archived and removed items excluded.` : 'Stock values unavailable until the dashboard refreshes.'}</p></div>
        {(['cost','asking'] as const).map(kind=>{const value=stats?.stockValue?.[kind];return <Link href="/inventory" key={kind}>
          <span>{kind==='cost'?'Recorded stock cost':'Saved asking value'}</span><strong>{!value ? '—' : value.knownTotal === null ? 'Not recorded' : money(value.knownTotal)}</strong>
          <small>{value ? `${value.recorded} item(s) recorded${value.missing ? ` · ${value.missing} without a valid ${kind==='cost'?'cost':'asking price'}; partial total` : ''}` : 'Awaiting saved values'}</small>
        </Link>;})}
        <p className={styles.stockNote}>Saved asking prices describe your pricing, not guaranteed sale proceeds. Stock cost uses only recorded purchase costs.</p>
      </section>
      <HubActivity />
      <MercariGoal />
      <div id="issues">
        <ReadStatus label="Photo groups" hasData={!!collisionRead.data} error={collisionRead.error} refreshing={collisionRead.refreshing} fresh={collisionRead.fresh} disabled={resolvingGroup !== null} retry={() => void loadCollisions()} />
        {collisionRead.fresh && collisionRead.data?.total === 0 && <p className="muted">No unresolved photo groups.</p>}
        {collisions.length > 0 && (
          <section aria-label="Photo groups to resolve" aria-busy={collisionRead.refreshing || resolvingGroup !== null} className="card" style={{ padding: 18, marginBottom: 22 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Collisions to resolve ({collisionRead.data!.total})</h2>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
              These SKUs already exist in your inventory. Choose what to do with the newly-uploaded photos.
            </p>
            <QueuePages label="Photo groups" position="top" meta={collisionRead.data!} disabled={!collisionRead.fresh || resolvingGroup !== null} change={page => { collisionRead.invalidate(); setCollisionPage(page); }} />
            {collisions.map((c) => (
              <div key={c.id} style={{ display: "flex", flexWrap: 'wrap', gap: 10, alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <strong>{c.sku}</strong>
                  <span className="muted" style={{ fontSize: 13 }}> · {c.photoCount === null ? 'Photo count unavailable' : `${c.photoCount} new photo(s)`}</span>
                  {c.error && <p role="alert">{c.error}</p>}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn" disabled={busy || resolvingGroup !== null || !collisionRead.fresh || !!c.error} onClick={() => resolve(c.id, "append")}>{resolvingGroup === c.id ? "Saving…" : "Append"}</button>
                  <button className="btn" disabled={busy || resolvingGroup !== null || !collisionRead.fresh || !!c.error} onClick={() => resolve(c.id, "replace")}>Replace</button>
                  <button className="btn" disabled={busy || resolvingGroup !== null || !collisionRead.fresh || !!c.error} onClick={() => resolve(c.id, "new")}>New SKU</button>
                </div>
              </div>
            ))}
            <QueuePages label="Photo groups" meta={collisionRead.data!} disabled={!collisionRead.fresh || resolvingGroup !== null} change={page => { collisionRead.invalidate(); setCollisionPage(page); }} />
          </section>
        )}
        <ReadStatus label="Open problems" hasData={!!problemRead.data} error={problemRead.error} refreshing={problemRead.refreshing} fresh={problemRead.fresh} disabled={dismissing !== null} retry={() => void loadProblems()} />
        {dismissError && <p role="alert" style={{ color: 'var(--warn)', overflowWrap: 'anywhere' }}>{dismissError}</p>}
        {problemRead.fresh && problemRead.data?.total === 0 && <p className="muted">No open problems.</p>}
        {problems.length > 0 && (() => {
          // Tiered triage (v1.2): real errors first, advisory warnings grouped below them,
          // info lines last — so 2 genuine merge warnings can't drown under bulk noise.
          const tier = (p: Problem) => problemMeta(p.type).severity;
          const criticals = problems.filter((p) => tier(p) === "critical");
          const warnings = problems.filter((p) => tier(p) === "warning");
          const infos = problems.filter((p) => tier(p) === "info");
          const row = (p: Problem, color?: string) => (
            <div key={p.id} style={{ display: "flex", flexWrap: 'wrap', alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>
                <span className="chip" title={`${p.type}${problemMeta(p.type).hint ? ` — ${problemMeta(p.type).hint}` : ""}`}
                  style={{ background: "var(--panel-2)", marginRight: 8, color }}>
                  {problemMeta(p.type).label}
                </span>
                {p.sku ? <strong style={{ marginRight: 6 }}>{p.sku}</strong> : null}
                <span className="muted">{p.message || ""}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {p.type === "AI_ENRICH_FAILED" && (
                  <button className="btn" data-sound="none" disabled={aiRetryBusy}
                    title="Re-run AI identification for every item that failed — from the photos already imported"
                    onClick={() => void retryFailedAi()}>
                    {aiRetryBusy ? "Retrying…" : "Retry AI"}
                  </button>
                )}
                <button className="btn" disabled={!problemRead.fresh || dismissing !== null} onClick={() => void resolveProblem(p.id)} data-sound="none">{dismissing === p.id ? 'Dismissing…' : 'Dismiss'}</button>
              </div>
            </div>
          );
          return (
            <section aria-label="Open problems list" aria-busy={problemRead.refreshing || dismissing !== null} className="card" style={{ padding: 18, marginBottom: 22 }}>
              <div style={{ display: "flex", flexWrap: 'wrap', gap: 10, justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                  Open problems ({problemRead.data!.total})
                  {criticals.length > 0 && (
                    <span className="chip" style={{ marginLeft: 8, background: "var(--panel-2)", color: "var(--danger)" }}>
                      {criticals.length} critical on this page
                    </span>
                  )}
                </h2>
                <button className="btn" disabled={!problemRead.fresh || dismissing !== null} onClick={() => void resolveProblem(null)} data-sound="none">{dismissing === 'all' ? 'Dismissing…' : `Dismiss all ${problemRead.data!.total}`}</button>
              </div>
              <p className="muted" style={{ fontSize: 13, margin: "0 0 4px" }}>
                Errors need action; warnings are review hints (uncertain grouping, missing stickers…). Hover a label for what to do.
              </p>
              <QueuePages label="Open problems" position="top" meta={problemRead.data!} disabled={!problemRead.fresh || dismissing !== null} change={page => { problemRead.invalidate(); setProblemPage(page); }} />
              {criticals.map((p) => row(p, "var(--danger)"))}
              {warnings.length > 0 && (
                <details open={criticals.length === 0} style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700, padding: "4px 0" }}>
                    Review warnings ({warnings.length})
                  </summary>
                  {warnings.map((p) => row(p, "var(--warn)"))}
                </details>
              )}
              {infos.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 13, padding: "4px 0" }}>
                    Info ({infos.length})
                  </summary>
                  {infos.map((p) => row(p))}
                </details>
              )}
              <QueuePages label="Open problems" meta={problemRead.data!} disabled={!problemRead.fresh || dismissing !== null} change={page => { problemRead.invalidate(); setProblemPage(page); }} />
            </section>
          );
        })()}
      </div>
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function StatCard({ href, icon, label, value, sub, muted }: { href: string; icon: React.ReactNode; label: string; value: number | string; sub?: string; muted?: boolean }) {
  return (
    <Link href={href} className={`card ${styles.metric}`} data-muted={muted || undefined}>
      <div className={styles.metricTop}><span className={styles.metricIcon}>{icon}</span><ArrowRight size={15} aria-hidden="true" /></div>
      <div className={styles.metricValue}>{value}</div>
      <div className={styles.metricLabel}>{label}</div>
      {sub && <div className={styles.metricSub}>{sub}</div>}
    </Link>
  );
}

function ReadStatus({ label, hasData, error, refreshing, fresh, disabled, retry }: { label: string; hasData: boolean; error: string | null; refreshing: boolean; fresh: boolean; disabled?: boolean; retry: () => void }) {
  if (fresh || (hasData && refreshing && !error)) return null;
  return <div role={error ? 'alert' : 'status'} className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
    <span style={{ flex: 1, minWidth: 140, overflowWrap: 'anywhere' }}>{label}: {error || (refreshing ? 'Refreshing…' : 'Refresh before taking another action.')}{hasData ? ' Showing the last successful view.' : ' Counts are unavailable until this view loads.'}</span>
    <button className="btn" disabled={refreshing || disabled} onClick={retry}>Refresh {label.toLowerCase()}</button>
  </div>;
}
function QueuePages({ label, meta, disabled, change, position }: { label: string; meta: DashboardPage; disabled: boolean; change: (page: number) => void; position?: 'top' }) {
  const [target, setTarget] = useState(String(meta.page));
  useEffect(() => setTarget(String(meta.page)), [meta.page]);
  const page = /^[1-9]\d*$/.test(target) ? Number(target) : 0;
  return <nav aria-label={`${label} pages${position ? ' at top' : ''}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
    <span>Page {meta.page} of {meta.pages} · {meta.total} total</span>
    <button className="btn" disabled={disabled || meta.page <= 1} onClick={() => change(meta.page - 1)}>Previous {label.toLowerCase()}</button>
    <button className="btn" disabled={disabled || meta.page >= meta.pages} onClick={() => change(meta.page + 1)}>Next {label.toLowerCase()}</button>
    {meta.pages > 1 && <form onSubmit={event => { event.preventDefault(); if (!disabled && Number.isSafeInteger(page) && page >= 1 && page <= meta.pages && page !== meta.page) change(page); }} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Page <input className="input" aria-label={`Go to ${label.toLowerCase()} page`} inputMode="numeric" value={target} disabled={disabled} onChange={event => setTarget(event.target.value)} style={{ width: 75 }} /></label>
      <button className="btn" disabled={disabled || !Number.isSafeInteger(page) || page < 1 || page > meta.pages || page === meta.page}>Go</button>
    </form>}
  </nav>;
}
