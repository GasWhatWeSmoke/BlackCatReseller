"use client";
import { useEffect, useState } from "react";

export function DiagnosticSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function configure(value: boolean) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/diagnostics", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_enabled", enabled: value }) });
      const result = await response.json();
      if (!response.ok || result.enabled !== value) throw Error("The diagnostic preference could not be saved.");
      setEnabled(value); window.dispatchEvent(new CustomEvent("blackcat-diagnostics-enabled", { detail: { enabled: value } }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save diagnostic preferences."); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/diagnostics?export=1", { cache: "no-store" }), report = await response.json();
      if (!response.ok || report.schemaVersion !== 1 || typeof report.appVersion !== "string") throw Error("Could not prepare the diagnostic report.");
      const native = (window as unknown as { blackcat?: { chromeStatus?: () => Promise<Record<string, unknown>> } }).blackcat;
      try {
        const status = await native?.chromeStatus?.();
        if (status) report.chrome = Object.fromEntries(["available", "connected", "busy", "paused", "approvalPending"].map(key => [key, status[key] === true]));
      } catch { report.chrome = { statusUnavailable: true }; }
      report.display = { width: screen.width, height: screen.height, extended: (screen as Screen & { isExtended?: boolean }).isExtended ?? null };
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `BlackCat-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Diagnostic file prepared. Review it, then send it with a short description of what went wrong.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not export diagnostics."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/diagnostics", { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok || typeof result.enabled !== "boolean") throw Error("Could not load diagnostic preferences.");
      setEnabled(result.enabled);
    }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); });
    return () => controller.abort();
  }, []);
  return <section className="card" style={{ padding: 22 }} aria-label="Support and diagnostics">
    <h3>Support and diagnostics</h3>
    <p>Records app actions and errors on this computer. Nothing is sent automatically. The export includes recent item IDs, reviewed listing fields, configured policy names, posting results and error summaries, without photos, cookies or the database file.</p>
    <label><input type="checkbox" checked={enabled ?? false} disabled={busy || enabled === null} onChange={event => void configure(event.target.checked)} /> Record local diagnostics</label>
    <p><button className="btn" disabled={busy} data-diagnostic-action="diagnostics_export" onClick={() => void download()}>Export diagnostic report</button></p>
    {message && <p role="status">{message}</p>}
  </section>;
}
