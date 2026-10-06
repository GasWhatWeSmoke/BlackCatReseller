"use client";
import { useEffect, useRef, useState } from "react";

type Tab = { id: number; marketplace: string; url: string };
type Reply = { ok: boolean; error?: string; result?: { version?: string; tabs?: Tab[]; page?: { state: string; message?: string; controls?: unknown[] } } };
const names: Record<string, string> = { depop: "Depop", ebay: "eBay", etsy: "Etsy", poshmark: "Poshmark" };

export default function BrowserLinkPage() {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [message, setMessage] = useState("");
  const pending = useRef(new Map<string, { resolve: (reply: Reply) => void; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    const requests = pending.current;
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.channel !== "blackcat-response") return;
      const request = requests.get(event.data.id);
      if (!request) return;
      clearTimeout(request.timer); requests.delete(event.data.id); request.resolve(event.data.response);
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); for (const value of requests.values()) clearTimeout(value.timer); requests.clear(); };
  }, []);
  function send(request: Record<string, unknown>): Promise<Reply> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.current.delete(id); resolve({ ok: false, error: "Extension did not respond. Load it in this Chrome profile, then refresh this page." }); }, 10_000);
      pending.current.set(id, { resolve, timer });
      window.postMessage({ channel: "blackcat-request", id, request }, window.location.origin);
    });
  }
  async function refreshTabs() {
    const reply = await send({ type: "tabs" });
    if (!reply.ok) throw new Error(reply.error);
    setTabs(reply.result?.tabs ?? []);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "Connection failed."); }
    finally { setBusy(false); }
  }
  async function connect() {
    if (window.location.href !== "http://127.0.0.1:41999/browser-link") throw new Error("Open http://127.0.0.1:41999/browser-link in your selling Chrome profile.");
    const reply = await send({ type: "ping" });
    if (!reply.ok) throw new Error(reply.error);
    await refreshTabs(); setConnected(true);
  }
  async function open(marketplace: string) {
    const reply = await send({ type: "open", marketplace });
    if (!reply.ok) throw new Error(reply.error);
    setMessage("Finish sign-in in the marketplace tab, then return here and refresh the list.");
  }
  async function inspect(tab: Tab) {
    const reply = await send({ type: "inspect", marketplace: tab.marketplace, tabId: tab.id });
    if (!reply.ok) throw new Error(reply.error);
    const response = await fetch("/api/publish/browser-inspection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply.result) });
    if (!response.ok) throw new Error("Could not save the inspection in Black Cat.");
    setMessage(reply.result?.page?.state === "seller_page"
      ? `${names[tab.marketplace]} page inspected. This confirms page access in this browser; uploading is still handled separately.`
      : reply.result?.page?.message ?? "Finish sign-in and open the seller page first.");
  }
  return <div style={{ maxWidth: 850 }}>
    <h1>Connect your selling browser</h1>
    <p>The Black Cat extension gathers information from your open seller pages. Uploading stays with Black Cat’s browser automation.</p>
    <p>Use this page in the Chrome profile where you sell. Keep Black Cat running.</p>
    {!connected ? <>
      <ol><li>Open <code>chrome://extensions</code> and turn on Developer mode.</li>
        <li>In Black Cat’s Settings, choose <strong>Open extension folder</strong>. Choose <strong>Load unpacked</strong> in Chrome and select that folder.</li>
        <li>Refresh this page, then connect below.</li></ol>
      <button className="btn btn-primary" disabled={busy} onClick={() => run(connect)}>Connect this browser</button>
    </> : <>
      <p>Extension connected · information gathering only</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{Object.entries(names).map(([id, name]) =>
        <button className="btn" key={id} disabled={busy} onClick={() => run(() => open(id))}>Open {name}</button>)}</div>
      <p><button className="btn" disabled={busy} onClick={() => run(refreshTabs)}>Refresh open tabs</button></p>
      {tabs.length ? <ul>{tabs.map((tab) => <li key={tab.id} style={{ marginBottom: 12 }}>
        <strong>{names[tab.marketplace]}</strong> <span style={{ overflowWrap: "anywhere" }}>{tab.url}</span>{" "}
        <button className="btn" disabled={busy} onClick={() => run(() => inspect(tab))}>Inspect seller page</button>
      </li>)}</ul> : <p>No marketplace tabs found. Open a seller page above.</p>}
    </>}
      <button className="btn" disabled={busy} onClick={() => run(async () => {
        const response = await fetch("/api/publish/browser-inspection", { method: "DELETE" });
        if (!response.ok) throw new Error("Could not clear inspections.");
        setConnected(false); setTabs([]); setMessage("Disconnected and cleared gathered information.");
      })}>Disconnect and clear information</button>
    {busy && <p role="status">Working…</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
