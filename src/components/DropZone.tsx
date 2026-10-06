"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { intakeStage, pollIntakeProgress, type IntakeProgress } from "@/lib/intake";
import { intakeFeedback, type IntakeSummary } from "@/lib/intakeOutcome";

// NDJSON reader for POST /api/process — streams live stage progress to `onProgress` and
// returns the final summary (or throws). This is what makes a drag-drop a REAL intake
// path instead of a dead end (§29) — with the same visible progress as the dashboard.
type ProcessSummary = IntakeSummary;

class ProcessRunError extends Error {
  constructor(readonly code: string, readonly reason: string | null = null) {
    super(
      code === "WORKER_VENV_MISSING" ? "the photo worker isn't installed yet"
      : code === "INTAKE_BUSY" ? "another batch is being imported or read — wait for it to finish first"
      : code === "VISION_DEFERRED" ? `managed vision is busy — ${reason || "retry shortly"}`
      : code === "VISION_UNAVAILABLE" ? `managed vision is unavailable — ${reason || "try Settings → AI Vision"}`
      : code,
    );
    this.name = "ProcessRunError";
  }
}

function reportDropSummary(summary: ProcessSummary, _imported: number, toastId: string | number): void {
  const feedback = intakeFeedback(summary);
  toast[feedback.tone](feedback.text, { id: toastId, duration: feedback.ok ? 10000 : 15000 });
}

// The POST below sends nothing until the worker admits, which happens only after the
// whole batch is hashed, EXIF-read and decoded. Poll the progress snapshot across that
// window, and hand over to the stream the instant it produces its first event.
async function runProcess(
  onProgress?: (p: IntakeProgress) => void,
  forceNoAi = false,
): Promise<{ summary: ProcessSummary; cancelled: boolean }> {
  let streamOpen = false;
  const stopPolling = onProgress
    ? pollIntakeProgress((p) => { if (!streamOpen) onProgress(p); })
    : () => {};
  const onStreamProgress = (p: IntakeProgress) => {
    if (!streamOpen) { streamOpen = true; stopPolling(); }
    onProgress?.(p);
  };
  try {
    return await readProcessStream(onStreamProgress, forceNoAi);
  } finally {
    stopPolling();
  }
}

async function readProcessStream(
  onProgress?: (p: IntakeProgress) => void,
  forceNoAi = false,
): Promise<{ summary: ProcessSummary; cancelled: boolean }> {
  const res = await fetch("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: forceNoAi }),
  });
  const reader = res.body?.getReader();
  if (!reader) {
    const j = await res.json().catch(() => ({ type: "error", error: "Server error" }));
    if (j.type === "done") return { summary: (j.summary ?? {}) as ProcessSummary, cancelled: false };
    if (j.type === "deferred") throw new ProcessRunError("VISION_DEFERRED", j.reason ? String(j.reason) : null);
    throw new ProcessRunError(j.error || "Processing failed", j.reason ? String(j.reason) : null);
  }
  const dec = new TextDecoder();
  let buf = "";
  let summary: ProcessSummary | null = null;
  let err: string | null = null;
  let errReason: string | null = null;
  let cancelled = false;
  let terminalCount = 0;
  let protocolError: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "done") {
          terminalCount += 1;
          summary = ev.summary as ProcessSummary;
        }
        else if (ev.type === "cancelled") { terminalCount += 1; cancelled = true; }
        else if (ev.type === "deferred") {
          terminalCount += 1;
          err = "VISION_DEFERRED";
          errReason = ev.reason ? String(ev.reason) : null;
        }
        else if (ev.type === "error") {
          terminalCount += 1;
          err = String(ev.error);
          errReason = ev.reason ? String(ev.reason) : null;
        }
        else if (ev.type === "progress") {
          const p = intakeStage(ev);
          if (p) onProgress?.(p);
        }
        else protocolError = "invalid process stream event";
        if (terminalCount > 1) protocolError = "multiple process stream terminal events";
      } catch { protocolError = "invalid process stream JSON"; }
    }
  }
  if (buf.trim()) protocolError = "truncated process stream";
  if (protocolError) throw new ProcessRunError(protocolError);
  if (err) {
    throw new ProcessRunError(err, errReason);
  }
  if (cancelled && terminalCount === 1) return { summary: {}, cancelled: true };
  if (!summary || terminalCount !== 1) throw new ProcessRunError("process stream ended without one terminal result");
  return { summary, cancelled: false };
}

// Window-level listeners keep file drops from navigating away. Only Dashboard
// drops import photos and immediately group them into items.
export function DropZone() {
  const pathname = usePathname();
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [prog, setProg] = useState<IntakeProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Kill the grouping run mid-read; the stream then reports "cancelled" and the
  // dropped photos stay pending in /incoming (Dashboard shows the resume banner).
  async function cancelRun() {
    setCancelling(true);
    try { await fetch("/api/process/cancel", { method: "POST" }); } catch { /* ignore */ }
  }

  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setOver(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      if (pathname !== "/") {
        toast.message("Add and process photos on the Dashboard.", { action: { label: "Open Dashboard", onClick: () => router.push("/") } });
        return;
      }
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const t = toast.loading(`Importing ${files.length} file(s)…`);
      let imported = 0;
      try {
        const res = await fetch("/api/import", { method: "POST", body: fd });
        const j = await res.json();
        imported = j.imported ?? 0;
        if (!res.ok || !imported) {
          toast.warning(
            j.error || `No photos imported${j.skipped?.length ? ` — ${j.skipped.length} skipped (only .jpg/.jpeg)` : " (only .jpg/.jpeg)"}.`,
            { id: t, duration: 7000 },
          );
          return;
        }
        if (imported !== files.length || j.failed?.length || j.skipped?.length) {
          toast.warning(
            `Uploaded ${imported} of ${files.length} photos. Grouping has not started because the batch is incomplete. ` +
              `The uploaded copies are retained in Incoming. Add the missing photos before processing. ` +
              [...(j.failed ?? []), ...(j.skipped ?? [])].join(", "),
            { id: t, duration: 12000 },
          );
          window.dispatchEvent(new Event("blackcat:intake-updated"));
          return;
        }
      } catch {
        toast.error("Import failed", { id: t });
        return;
      }
      // Don't dead-end: group the just-imported photos into items right away, with the
      // live progress pill so a long AI-enrich run never looks frozen.
      toast.loading(`Imported ${imported} — grouping into items…`, { id: t });
      setProg({ label: "Scanning photos…", pct: 1 });
      const importWithoutAi = async () => {
        toast.loading(`Importing ${imported} pending photo(s) without AI…`, { id: t });
        setProg({ label: "Grouping without AI…", pct: 1 });
        try {
          const forced = await runProcess(setProg, true);
          if (forced.cancelled) {
            toast.message(
              `Cancelled — nothing was saved. The ${imported} photo(s) remain pending on the Dashboard.`,
              { id: t, duration: 8000 },
            );
          } else {
            reportDropSummary(forced.summary, imported, t);
          }
        } catch (error) {
          toast.error(
            `Could not import without AI: ${error instanceof Error ? error.message : String(error)}. The photos remain pending.`,
            { id: t, duration: 10000 },
          );
        } finally {
          setProg(null);
          setCancelling(false);
          window.dispatchEvent(new Event("blackcat:intake-updated"));
        }
      };
      try {
        const { summary: s, cancelled } = await runProcess(setProg);
        if (cancelled) {
          toast.message(
            `Cancelled — nothing was saved. The ${imported} photo(s) are still pending on the Dashboard.`,
            { id: t, duration: 8000 },
          );
          return;
        }
        reportDropSummary(s, imported, t);
      } catch (err) {
        if (err instanceof ProcessRunError &&
            (err.code === "VISION_DEFERRED" || err.code === "VISION_UNAVAILABLE")) {
          const reason = err.reason || (err.code === "VISION_DEFERRED"
            ? "another local vision batch is running"
            : "the local vision runtime is unavailable");
          toast.error(
            `Imported ${imported} photo(s), but ${reason}. No items were created or source photos changed; they remain pending. Retry shortly.`,
            {
              id: t,
              duration: 30000,
              action: { label: "Import anyway (no AI)", onClick: () => { void importWithoutAi(); } },
            },
          );
        } else {
          toast.error(
            `Imported ${imported}, but grouping failed: ${err instanceof Error ? err.message : String(err)}`,
            { id: t, duration: 9000 },
          );
        }
      } finally {
        setProg(null);
        setCancelling(false);
        window.dispatchEvent(new Event("blackcat:intake-updated"));
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [pathname, router]);

  return (
    <>
      {over && <div className="drop-overlay">{pathname === "/" ? "Drop photos to import & group into items" : "Add photos on the Dashboard"}</div>}
      {/* Global processing pill: visible on ANY page while a dropped batch is grouping,
          so a long AI pass never looks like a hang again. */}
      {prog && (
        <div style={{
          position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 18, zIndex: 60,
          width: 400, maxWidth: "calc(100vw - 40px)", background: "var(--panel)",
          border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px",
          boxShadow: "0 8px 28px rgba(0,0,0,0.65)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: prog.pct != null ? 8 : 0 }}>
            <span style={{
              width: 12, height: 12, border: "2px solid var(--accent)", borderTopColor: "transparent",
              borderRadius: "50%", display: "inline-block", animation: "dz-spin 0.9s linear infinite",
            }} />
            <span>{prog.label}</span>
            {prog.sub && <span className="muted">{prog.sub}</span>}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              {prog.pct != null && <span className="muted" style={{ fontSize: 11 }}>{Math.round(prog.pct)}%</span>}
              <button className="btn" onClick={cancelRun} disabled={cancelling} data-sound="none"
                style={{ padding: "2px 8px", fontSize: 12 }}
                title="Stop reading this batch — nothing is saved; the photos stay pending on the Dashboard">
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </span>
          </div>
          {prog.pct != null && (
            <div style={{ height: 6, borderRadius: 999, background: "var(--panel-2)", overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 999, background: "var(--accent)", width: `${Math.min(100, prog.pct)}%`, transition: "width .4s ease" }} />
            </div>
          )}
          <style>{`@keyframes dz-spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
    </>
  );
}
