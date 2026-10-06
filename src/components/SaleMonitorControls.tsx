"use client";

import { useRef, useState } from "react";
import Link from 'next/link';
import type { SaleMonitorStatus } from "@/lib/publish/saleMonitor";
import { validSaleCheckMinutes, validSaleChecksPerDay } from "@/lib/publish/saleMonitorSettings";
import { toast } from "sonner";
import { monitorPresentation } from "@/lib/monitorPresentation";
import { usePolledRead } from './usePolledRead';

const labels: Record<string, string> = { not_checked: "Not checked", checking: "Checking sales", checked: "Last scan complete",
  limited: "Recent orders checked", partial: "Incomplete check", failed: "Needs attention", waiting: "No direct listings",
  busy: "Waiting for browser", paused: "Paused", unsupported: "Not available" };
const names: Record<string, string> = { depop: "Depop", poshmark: "Poshmark", ebay: "eBay", etsy: "Etsy", mercari: "Mercari" };
type FrequencyDraft = { mode: "minutes" | "daily"; value: string };
type MonitorView = SaleMonitorStatus & { enabled: boolean; intervalMinutes: number; checksPerDay: number | null; windowOpen: boolean };
async function readMonitor(signal:AbortSignal):Promise<MonitorView> {
  const response=await fetch('/api/publish/monitor',{signal,cache:'no-store'});
  if(!response.ok)throw Error('Could not load sale monitoring status. Refresh before changing monitoring.');
  const data=await response.json();
  const textOrNull=(value:unknown)=>value===null||typeof value==='string';
  if(!data||[data.enabled,data.windowOpen,data.active,data.waitingForBrowser].some(value=>typeof value!=='boolean')
    ||![data.lastError,data.currentPlatform,data.lastStartedAt,data.lastFinishedAt,data.nextCheckAt].every(textOrNull)
    ||!Number.isFinite(data.intervalMinutes)||!(data.checksPerDay===null?validSaleCheckMinutes(data.intervalMinutes):validSaleChecksPerDay(data.checksPerDay)&&Math.abs(data.intervalMinutes-1440/data.checksPerDay)<0.000001)
    ||!data.platforms||typeof data.platforms!=='object'||Array.isArray(data.platforms)
    ||Object.keys(names).some(name=>!data.platforms[name])
    ||Object.values(data.platforms).some((scan:any)=>!scan||typeof scan.state!=='string'||![scan.lastCheckedAt,scan.reason,scan.limitation].every(textOrNull)))
    throw Error('Sale monitoring status is incomplete. Refresh before changing monitoring.');
  return data;
}
function formatWait(minutes: number) {
  const value = minutes >= 60 ? minutes / 60 : minutes;
  const unit = minutes >= 60 ? "hour" : "minute";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}${value === 1 ? "" : "s"}`;
}

export function SaleMonitorControls() {
  const view=usePolledRead(readMonitor,data=>data?.active?2500:15000);
  const {data:status,error,load}=view;
  const [frequencyDraft, setFrequencyDraft] = useState<FrequencyDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef=useRef(false);

  async function control(body: { enabled: boolean } | { action: "check" } | { intervalMinutes: number } | { checksPerDay: number }) {
    if(savingRef.current||!view.isFresh())return;
    savingRef.current=true;setSaving(true);setActionError(null);view.invalidate();
    try {
      const response = await fetch("/api/publish/monitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || result?.ok!==true) throw new Error(result?.error || "The monitoring change could not be confirmed. Refresh before trying again.");
      if('enabled' in body&&result.enabled!==body.enabled)throw Error('The saved monitoring preference could not be confirmed.');
      if ("intervalMinutes" in body || "checksPerDay" in body) {
        const expectedMinutes='checksPerDay' in body?1440/body.checksPerDay:body.intervalMinutes;
        const expectedDaily='checksPerDay' in body?body.checksPerDay:null;
        if(result.intervalMinutes!==expectedMinutes||result.checksPerDay!==expectedDaily)throw Error('The saved frequency could not be confirmed. Your frequency edit is still shown.');
        setFrequencyDraft(null);toast.success("Sale check frequency saved");
      }
    } catch (error) { setActionError(error instanceof Error ? error.message : "Could not update monitoring."); }
    finally { await load();savingRef.current=false;setSaving(false); }
  }

  const frequency = frequencyDraft ?? { mode: status?.checksPerDay ? "daily" : "minutes",
    value: String(status?.checksPerDay ?? status?.intervalMinutes ?? "") };
  const validFrequency = frequency.mode === "daily" ? validSaleChecksPerDay(Number(frequency.value)) : validSaleCheckMinutes(Number(frequency.value));
  const draftMinutes = validFrequency ? (frequency.mode === "daily" ? 1440 / Number(frequency.value) : Number(frequency.value)) : status?.intervalMinutes ?? 60;

  return <section className="card hub-monitor" data-enabled={status?.enabled} style={{ padding: 22 }} aria-label="Automatic sale monitoring">
    <h3 style={{ marginTop: 0 }}>Automatic sale monitoring</h3>
    <p>Checks your connected marketplaces while Black Cat is running and this PC is awake.
      Confirmed sales queue the item&apos;s other listings for removal. Removal results stay linked to each item in your history.</p>
    <p className="muted">Automatic checks run only while the Black Cat window is open (minimized is fine).
      Closing it to the tray pauses checks after the current browser action. Reopen it to resume.
      Quitting, sleeping, or shutting down this PC stops checks. Keep your second monitor connected.</p>
    {(error || actionError || status?.lastError) && <p role="alert">{error || actionError || status?.lastError}</p>}
    {status&&!view.fresh&&<p role="status">Showing the last loaded monitoring status until it can be refreshed.</p>}
    <button type="button" className="btn" disabled={saving} onClick={()=>void load()}>Refresh monitoring status</button>
    {!status ? <p>{error?'Monitoring status is unavailable.':'Loading monitor status…'}</p> : <>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={status.enabled} disabled={saving || !view.fresh}
          onChange={(event) => void control({ enabled: event.target.checked })} />
        Enable automatic sale checks and removals
      </label>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
        <label htmlFor="sale-check-mode">Set frequency by</label>
        <select id="sale-check-mode" className="input" style={{ width: "auto", maxWidth: "100%" }} value={frequency.mode} disabled={saving}
          onChange={event => setFrequencyDraft({ mode: event.target.value as FrequencyDraft["mode"],
            value: String(Math.round(event.target.value === "daily" ? 1440 / draftMinutes : draftMinutes)) })}>
          <option value="minutes">Minutes between checks</option>
          <option value="daily">Checks per day</option>
        </select>
        <input id="sale-check-frequency" className="input" type="number" min={frequency.mode === "daily" ? 1 : 2}
          max={frequency.mode === "daily" ? 720 : 1440} step={1}
          style={{ width: 100 }} value={frequency.value} disabled={saving}
          aria-label={frequency.mode === "daily" ? "Checks per day" : "Minutes between checks"}
          onChange={event => setFrequencyDraft({ mode: frequency.mode as FrequencyDraft["mode"], value: event.target.value })}
          aria-invalid={!validFrequency} aria-describedby="sale-check-help sale-check-draft" />
        <span>{frequency.mode === "daily" ? "checks / day" : "minutes"}</span>
        <button className="btn" disabled={saving || !view.fresh || frequencyDraft === null || !validFrequency}
          onClick={() => void control(frequency.mode === "daily" ? { checksPerDay: Number(frequency.value) } : { intervalMinutes: Number(frequency.value) })}>Save frequency</button>
      </div>
      <p id="sale-check-draft" className="muted">{!validFrequency
        ? (frequency.mode === "daily" ? "Enter a whole number from 1 to 720 checks per day." : "Enter a whole number from 2 to 1440 minutes.")
        : frequencyDraft ? `Not saved yet: wait about ${formatWait(draftMinutes)} after each full check.`
        : "Choose 1–720 checks per day or 2–1440 minutes between checks."}</p>
      <p id="sale-check-help" className="muted"><strong>Saved: {status.checksPerDay
        ? `${status.checksPerDay} ${status.checksPerDay === 1 ? "check" : "checks"} per day — about ${formatWait(status.intervalMinutes)} between checks.`
        : `${formatWait(status.intervalMinutes)} between checks.`}</strong>{" "}
        Daily targets spread checks across 24 hours. The wait starts when each full check finishes.
        Checks run only while the app window is open, so sleep, time spent checking, and a busy browser can reduce the daily total.
        Checks never overlap. Timing is checked every 30 seconds.</p>
      <p role="status"><strong>{monitorPresentation(status).label}</strong> · {monitorPresentation(status).detail}</p>
      <p className="muted">Pausing lets the current browser action finish, then stops further automatic actions.</p>
      <details><summary>Platform status and coverage</summary><div tabIndex={0} role="region" aria-label="Sale check status by marketplace" style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left" }}>
        <thead><tr><th>Platform</th><th>Sale checks</th><th>Last scan</th></tr></thead>
        <tbody>{Object.entries(status.platforms).map(([marketplace, scan]) => <tr key={marketplace}>
          <td>{names[marketplace] ?? marketplace}</td>
          <td>{labels[scan.state] ?? scan.state}{scan.reason && <div className="muted">{scan.reason}</div>}
            {scan.reason && /sign.in is required|sign up or log in|sign.in or security verification/i.test(scan.reason) &&
              <Link className="btn" href="/settings#marketplace-accounts">Reconnect {names[marketplace] ?? marketplace}</Link>}
            {scan.limitation && <div className="muted">{scan.limitation}</div>}</td>
          <td>{scan.lastCheckedAt ? new Date(scan.lastCheckedAt).toLocaleString() : "Not yet"}</td>
        </tr>)}</tbody>
      </table></div></details>
      <button type="button" className="btn" style={{ marginTop: 12 }} disabled={!status.enabled || status.active || saving || !view.fresh}
        onClick={() => void control({ action: "check" })}>Check sales now</button>
    </>}
  </section>;
}
