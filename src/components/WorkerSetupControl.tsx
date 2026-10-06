"use client";
import { useEffect, useRef, useState } from 'react';
import styles from './StarterTutorial.module.css';

type SetupStatus = { state: 'idle' | 'running' | 'complete' | 'failed'; message: string };
type SetupBridge = { setupWorker: () => Promise<{ ok: boolean; error?: string }>; workerSetupStatus: () => Promise<SetupStatus> };
const bridge = () => (window as unknown as { blackcat?: Partial<SetupBridge> }).blackcat;

export function WorkerSetupControl({ onComplete }: { onComplete: () => void }) {
  const [supported, setSupported] = useState(false), [status, setStatus] = useState<SetupStatus | null>(null);
  const [requesting, setRequesting] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(false), generation = useRef(0), starting = useRef(false), reading = useRef(false);
  const previous = useRef<SetupStatus['state'] | null>(null), completed = useRef(onComplete);
  completed.current = onComplete;
  async function refresh() {
    const native = bridge(); if (!native?.workerSetupStatus || reading.current) return;
    const current = generation.current; reading.current = true;
    try {
      const result = await native.workerSetupStatus();
      if (!mounted.current || current !== generation.current) return;
      if (!result || !['idle', 'running', 'complete', 'failed'].includes(result.state) || typeof result.message !== 'string') throw Error('Worker setup returned an unreadable status.');
      setStatus(result); setError(null);
      if (result.state === 'complete' && previous.current !== 'complete') completed.current();
      previous.current = result.state;
    } catch (failure) {
      if (mounted.current && current === generation.current) setError(failure instanceof Error ? failure.message : 'Worker setup status is unavailable.');
    } finally { reading.current = false; }
  }
  useEffect(() => {
    mounted.current = true;
    const native = bridge();
    if (typeof native?.setupWorker === 'function' && typeof native.workerSetupStatus === 'function') {
      setSupported(true); void refresh();
      const timer = setInterval(() => void refresh(), 2000);
      return () => { mounted.current = false; generation.current++; clearInterval(timer); };
    }
    return () => { mounted.current = false; generation.current++; };
  }, []);
  async function start() {
    const native = bridge();
    if (!native?.setupWorker || starting.current || !status || status.state === 'running' || error) return;
    starting.current = true; generation.current++; previous.current = 'running'; setRequesting(true); setError(null);
    setStatus({ state: 'running', message: 'Starting worker setup…' });
    try {
      const result = await native.setupWorker();
      if (!result || result.ok !== true) throw Error(result?.error || 'Worker setup did not confirm completion.');
      if (mounted.current) await refresh();
    } catch (failure) {
      if (mounted.current) { setError(failure instanceof Error ? failure.message : 'Worker setup failed.'); setStatus({ state: 'failed', message: 'Setup needs attention. Re-check its status before retrying.' }); }
    } finally { starting.current = false; if (mounted.current) setRequesting(false); }
  }
  return <div className={styles.panel} style={{ padding: 0 }}>
    {supported ? <>
      <p>Install the private photo worker here. First-time setup downloads Python, photo tools and a browser; keep the app open and your internet connection available.</p>
      <p role="status">{status?.message || 'Checking worker setup…'}</p>
      {error && <p role="alert" className={styles.notice}>{error}</p>}
      <div className={styles.actions}>
        <button className="btn btn-primary" disabled={requesting || !status || status.state === 'running' || !!error} onClick={() => void start()}>
          {requesting || status?.state === 'running' ? 'Installing worker…' : status?.state === 'failed' ? 'Retry worker setup' : status?.state === 'complete' ? 'Re-run worker setup' : 'Install photo worker'}
        </button>
        <button className="btn" onClick={() => void refresh()} disabled={requesting}>Check setup status</button>
      </div>
    </> : <p className="muted">In the desktop app, use its worker setup control if available. For an unpacked build, run <b>Setup Black Cat Agent.cmd</b> beside the executable, then return and choose Re-check installation.</p>}
  </div>;
}
