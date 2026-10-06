"use client";
import { useEffect, useRef, useState } from 'react';
import styles from './ChromeConnection.module.css';

type Status = { available: boolean; connected: boolean; busy: boolean; paused: boolean; failed?: boolean; approvalPending?: boolean };
type NativeChrome = { chromeStatus: () => Promise<Status>; chromeConnect: () => Promise<Status>;
  chromeDisconnect: () => Promise<Status>; openChromeWidget: () => Promise<boolean>;
  openChromeExtensions: () => Promise<boolean>; showChromeExtensionFolder: () => Promise<string> };
const nativeChrome = () => (window as unknown as { blackcat?: NativeChrome }).blackcat;

export function ChromeConnection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [supported, setSupported] = useState(false);
  const running = useRef(false), generation = useRef(0);
  useEffect(() => {
    const native = nativeChrome();
    if (!native?.chromeStatus) return;
    setSupported(true);
    let disposed = false;
    const refresh = async () => {
      const current = generation.current;
      try { const value = await native.chromeStatus(); if (!disposed && current === generation.current && !running.current) setStatus(value); }
      catch { if (!disposed && current === generation.current) setStatus(null); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); generation.current++; };
  }, []);
  async function run(action: (native: NativeChrome) => Promise<void>) {
    const native = nativeChrome(); if (!native || running.current) return;
    running.current = true; generation.current++; setBusy(true); setMessage('');
    try { await action(native); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Chrome did not confirm the action.'); }
    finally { running.current = false; setBusy(false); }
  }
  const label = !status ? 'Checking connection…' : !status.available ? 'Not connected — connect to check Chrome'
    : status.approvalPending ? 'Waiting for Chrome — click Allow in its prompt' : status.busy ? 'Connected · browser task running'
    : status.paused ? 'Disconnected · automatic reconnect paused' : status.failed ? 'Connection lost' : status.connected ? 'Connected'
    : 'Ready to connect';
  async function open(native: NativeChrome, action: 'widget' | 'extensions') {
    const ok = await (action === 'widget' ? native.openChromeWidget() : native.openChromeExtensions());
    if (!ok) throw Error('Could not open Chrome. Connect it above and check that the second monitor is connected.');
    setMessage(action === 'widget' ? 'Extension controls opened on monitor 2. Choose Connect this browser or Disconnect and clear information there.'
      : 'Chrome extension settings opened on monitor 2. Enable Black Cat Marketplace Bridge, or choose Load unpacked for first-time setup.');
  }
  return <section className={`card ${styles.panel}`} style={{ padding: 22, marginBottom: 16 }} aria-label="Chrome connection">
    <h2 style={{ marginTop: 0 }}>Chrome connection</h2>
    <p>Connect Black Cat to your selling Chrome for eBay, Etsy and Mercari browser work. Depop and Poshmark use their linked account windows below.</p>
    <p className="muted">Keep the second monitor connected. Black Cat opens its work windows there in the background.</p>
    {!supported ? <p>Open the updated Black Cat desktop app to use these controls.</p> : <>
      <p role="status">{label}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-primary" disabled={busy || status?.busy || status?.connected || status?.approvalPending}
          onClick={() => void run(async native => { setStatus(await native.chromeConnect()); })}>Connect Chrome</button>
        <button className="btn" disabled={busy || !status?.available || status.busy || status.paused}
          onClick={() => void run(async native => { setStatus(await native.chromeDisconnect()); setMessage('Disconnected. Shared Chrome work stays paused until you reconnect or restart Black Cat. Your Chrome tabs remain open.'); })}>Disconnect Chrome</button>
      </div>
      <p className="muted">Keep Chrome open. If asked, click Allow in Chrome. Finish active browser work before disconnecting; sale checks and removals needing this connection cannot run while it is disconnected.</p>
      <details><summary>First-time Chrome setup</summary>
        <p>In your selling Chrome, open <code>chrome://inspect/#remote-debugging</code> and enable remote debugging. Return here and choose Connect Chrome.</p>
        <button className="btn" disabled={busy} onClick={() => void run(async () => {
          await navigator.clipboard.writeText('chrome://inspect/#remote-debugging');
          setMessage('Chrome setup address copied. Paste it into your selling Chrome’s address bar.');
        })}>Copy Chrome setup address</button>
        <p>Chrome’s own approval must be completed in Chrome.</p>
      </details>
      <h3>Chrome widget · optional inspection extension</h3>
      <p>Use the widget to inspect seller pages. Automatic sales and removals do not require it.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" disabled={busy || !status?.connected || status.busy} onClick={() => void run(native => open(native, 'widget'))}>Connect / disconnect widget</button>
        <button className="btn" disabled={busy || !status?.connected || status.busy} onClick={() => void run(native => open(native, 'extensions'))}>Enable / disable widget in Chrome</button>
        <button className="btn" disabled={busy} onClick={() => void run(async native => {
          const error = await native.showChromeExtensionFolder(); if (error) throw Error(error);
          setMessage('Extension folder opened. In Chrome’s extension settings, turn on Developer mode, choose Load unpacked, and select this folder.');
        })}>Open extension folder</button>
      </div>
    </>}
    {busy && <p role="status">Waiting for Chrome…</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
