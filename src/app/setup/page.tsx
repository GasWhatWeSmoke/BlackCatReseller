"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckCircle2, Circle, AlertTriangle, ArrowRight, RefreshCw, Loader2 } from "lucide-react";
import { CatMark } from "@/components/CatMark";
import { usePolledRead } from '@/components/usePolledRead';
import { readSetupView, saveSetupChoice } from '@/lib/setupClient';
import { StarterTutorial, RealBatchChecklist } from '@/components/StarterTutorial';
import { PracticeBatch } from '@/components/PracticeBatch';
import { WorkerSetupControl } from '@/components/WorkerSetupControl';

// The first-run guide. Deliberately a LIVE checklist rather than a page of instructions:
// it reads the machine every time it loads, so it can say which step you are actually
// stuck on instead of describing a happy path and leaving you to work out where it broke.

export default function SetupPage() {
  const view = usePolledRead(readSetupView, null), load = view.load;
  const steps = view.data?.steps ?? [], progress = view.data?.progress;
  const savingRef = useRef(false), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState<string | null>(null);
  async function recheck() { if (await load()) setSaveError(null); }
  async function acknowledge(id: string, value: boolean) {
    if (savingRef.current || !view.isFresh() || id !== 'ebay-policy') return;
    savingRef.current = true; setSaving(true); setSaveError(null); view.invalidate();
    try {
      await saveSetupChoice({ acknowledge: 'ebay-policy', value });
      toast.success('Setup choice saved.');
      await load();
    } catch (error) {
      view.invalidate(); const message = error instanceof Error ? error.message : 'Your setup choice could not be confirmed.';
      setSaveError(message); toast.error(message);
    } finally { savingRef.current = false; setSaving(false); }
  }

  const pct = progress ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: "flex", flexWrap: 'wrap', alignItems: "center", gap: 10 }}>
        <CatMark size={26} blink />
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.3 }}>Getting started</h1>
        <button className="btn" onClick={() => void recheck()} disabled={saving} style={{ marginLeft: "auto", fontSize: 12 }}>
          {view.refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Re-check
        </button>
      </div>

      <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 8, maxWidth: 700 }}>
        Start with the short tutorial, check your installation, and try ten fictional garments.
        Your real inventory stays on this computer. Marketplace actions use your signed-in accounts.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <a className="btn" href="#installation">Check installation</a>
        <a className="btn" href="#practice">Try practice batch</a>
        <a className="btn" href="#real-batch">Real-garment test</a>
      </div>
      <StarterTutorial />
      <h2 id="installation" style={{ fontSize: 18 }}>Installation and first-listing checklist</h2>
      <p className="muted">Re-check to refresh the observed state. This checklist includes marketplace setup and your first listing;
        you can start learning and organizing locally before connecting accounts. The eBay policy step applies when using eBay.</p>

      {(view.error || !view.fresh) && <p role={view.error ? 'alert' : 'status'} style={{ color: view.error ? 'var(--warn)' : 'var(--muted)' }}>{view.error || (view.refreshing ? 'Checking setup…' : 'Re-check setup before changing another choice.')}{view.data ? ' Showing the last successful checklist.' : ' Setup progress is unavailable until these checks load.'}</p>}
      {saveError && <p role="alert" style={{ color: 'var(--warn)' }}>{saveError}</p>}
      {/* Progress */}
      <div className="card" style={{ padding: "14px 16px", margin: "18px 0", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ fontWeight: 700 }}>
              {progress ? progress.complete ? "You're set up." : `${progress.done} of ${progress.total} steps complete` : 'Setup progress unavailable'}
            </span>
            <span className="muted">{progress ? `${progress.done}/${progress.total}` : '—'}</span>
          </div>
          <div style={{ height: 7, borderRadius: 4, background: "var(--panel-2)", overflow: "hidden" }}>
            <div style={{ width: `${pct ?? 0}%`, height: "100%", background: "var(--accent)", transition: "width .25s" }} />
          </div>
        </div>
      </div>

      {view.fresh && progress?.complete && (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: "var(--accent)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 5 }}>Ready to work.</div>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
            Photograph a batch with a SKU marker as the last photo of each item, choose
            <b> Upload folder</b> on the Dashboard, check and complete each item in <b>Review</b>,
            then approve it and open <b>Crosslisting</b>.
            Manage marketplace accounts and posting preferences in <b>Settings</b>.
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {steps.map((s, i) => {
          const done = s.state === "done";
          return (
            <div
              key={s.id}
              className="card"
              style={{
                padding: 15, display: "flex", gap: 13, alignItems: "flex-start",
                borderColor: !done && s.blocking ? "#5a4a1f" : "var(--border)",
              }}
            >
              <div style={{ paddingTop: 1, color: done ? "var(--accent)" : "var(--muted)" }}>
                {done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="muted" style={{ fontSize: 11, fontWeight: 700 }}>{i + 1}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, textDecoration: done ? "line-through" : "none" }}>
                    {s.title}
                  </span>
                  {s.optional && <span className="chip muted">optional</span>}
                  {!done && s.blocking && (
                    <span className="chip" style={{ color: "#f59e0b", borderColor: "#5a4a1f" }}>
                      <AlertTriangle size={11} style={{ marginRight: 4, verticalAlign: -1 }} />required for listing
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 5 }}>{s.detail}</div>
                {s.id === 'worker' && <WorkerSetupControl onComplete={() => void recheck()} />}
                {s.note && (
                  <div style={{ fontSize: 12, marginTop: 7, color: done ? "var(--accent)" : "var(--muted)" }}>
                    {s.note}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  {s.href && !done && (
                    <Link className="btn btn-primary" href={s.href} style={{ fontSize: 12 }}>
                      {s.action ?? "Go"} <ArrowRight size={13} />
                    </Link>
                  )}
                  {s.manual && (
                    <button className="btn" disabled={saving || (s.id === 'ebay-policy' && !view.fresh)} onClick={() => s.id === 'ebay-policy' ? void acknowledge(s.id, !done) : void recheck()} style={{ fontSize: 12 }}>
                      {s.id !== 'ebay-policy' ? 'Re-check installation' : saving ? 'Saving…' : done ? "Not done after all" : "I've done this"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <PracticeBatch />
      <RealBatchChecklist />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 20, lineHeight: 1.6 }}>
        Need help? Note the screen, item SKU, marketplace and exact error. Logs are in the
        saved Logs folder in Settings. Review relevant logs for account, customer and personal
        information before sharing them. You can reopen this guide from Settings → Getting started.
      </div>

      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
