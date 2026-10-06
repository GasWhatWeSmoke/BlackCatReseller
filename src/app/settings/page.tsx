"use client";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import Link from 'next/link';
import { FolderOpen, Save, Trash2 } from "lucide-react";
import {
  LOCAL_VISION_MAX_OUTPUT_TOKENS,
  LOCAL_VISION_MAX_PHOTOS,
  type AppSettingsData,
} from "@/lib/types";
import { MarketplaceAccounts } from "@/components/MarketplaceAccounts";
import { SaleRemovalStatus } from "@/components/SaleRemovalStatus";
import { SaleMonitorControls } from "@/components/SaleMonitorControls";
import { BrowserHelp } from "@/components/BrowserHelp";
import { MercariGoal } from "@/components/MercariGoal";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { BackupStatus } from "@/components/BackupStatus";
import { BrandCleanup } from "@/components/BrandCleanup";
import { ArchiveCleanup } from "@/components/ArchiveCleanup";
import { usePolledRead } from "@/components/usePolledRead";
import { useSettingsDraft } from "@/components/useSettingsDraft";
import { describeSettingsValue, type GeneralSettingsField } from "@/lib/settingsDrafts";
import styles from "./Settings.module.css";

const SectionName = createContext("");
const SettingName = createContext("");
const GeneralEditing = createContext(true);
function settingsForForm(value: unknown): AppSettingsData {
  const data=value as AppSettingsData | null;
  if(!data || typeof data.dataRoot !== 'string' || !data.dataRoot.trim() || ![data.skuPrefixes,data.requiredFieldsForReady,data.visionFields].every(list=>Array.isArray(list)&&list.every(entry=>typeof entry==='string'))
    || !data.feeModel || typeof data.feeModel!=='object' || Array.isArray(data.feeModel)
    || Object.values(data.feeModel).some(fee=>!fee||!Number.isFinite(fee.feePercent)||!Number.isFinite(fee.fixedFee))
    || !data.shippingModel || !Array.isArray(data.shippingModel.tiers) || !Number.isFinite(data.shippingModel.default)
    || data.shippingModel.tiers.some(tier=>!tier||!Number.isFinite(tier.maxOz)||!Number.isFinite(tier.cost)))
    throw new Error('Saved settings are incomplete. Reload before editing them.');
  return data;
}

const PATH_KEYS = [
  "dataRoot", "incomingPath", "processingPath", "readyPath", "needsReviewPath",
  "archivePath", "exportsPath", "logsPath", "backupsPath", "pythonWorkerPath",
] as const satisfies readonly GeneralSettingsField[];

const PATH_LABELS: Record<string, string> = {
  dataRoot: "Data root",
  incomingPath: "Incoming (drop) folder",
  processingPath: "Processing folder",
  readyPath: "Prepared photo folder",
  needsReviewPath: "Needs-review folder",
  archivePath: "Archive (originals)",
  exportsPath: "Exports folder",
  logsPath: "Logs folder",
  backupsPath: "Backups folder",
  pythonWorkerPath: "Python worker (python.exe)",
};
const DRAFT_LABELS: Record<string, string> = { ...PATH_LABELS, priceWarnMin: 'Low-price warning', priceWarnMax: 'High-price warning',
  feeModel: 'Marketplace fee estimates', shippingModel: 'Shipping estimates', mercariShipFrom: 'Mercari ship-from address' };

declare global {
  interface Window {
    blackcat?: { pickFolder: () => Promise<string | null>; pickFile: () => Promise<string | null> };
  }
}

export default function SettingsPage() {
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const recovery = useSettingsDraft(savingRef);
  const s = recovery.form, loadDraft = recovery.load;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadingPreferences, setLoadingPreferences] = useState(true);

  useEffect(() => {
    let active = true; const controller = new AbortController();
    setLoadError(null); setLoadingPreferences(true);
    fetch("/api/settings", { signal:controller.signal, cache:'no-store' }).then(async r => {
      const result = await r.json();
      if (!r.ok || !result.settings) throw new Error(result.error || "Saved settings could not be loaded.");
      return settingsForForm(result.settings);
    }).then(async settings => { if (active) await loadDraft(settings); })
      .catch(error => { if (active) setLoadError(error instanceof Error ? error.message : "Saved settings could not be loaded."); })
      .finally(() => { if (active) setLoadingPreferences(false); });
    return () => { active = false; controller.abort(); };
  }, [loadAttempt, loadDraft]);

  if (loadError) return <div role="alert" className="card" style={{ padding: 20 }}>{loadError} <button className="btn" onClick={() => setLoadAttempt(value => value + 1)}>Retry loading settings</button></div>;
  if (!s) return <p className="muted">Loading…</p>;
  const set = recovery.change;

  async function browse(key: typeof PATH_KEYS[number], file = false) {
    if (window.blackcat) {
      const p = file ? await window.blackcat.pickFile() : await window.blackcat.pickFolder();
      if (p) set(key, p as AppSettingsData[typeof key]);
    } else {
      toast.message("Folder picker is available in the desktop app; edit the path manually here.");
    }
  }

  async function save() {
    if (!s || savingRef.current) return;
    savingRef.current=true; setSavingGeneral(true); setSaveError(null);
    try {
      const token = await recovery.prepareSave();
      if (!Object.keys(token.patch).length) { toast.message("General preferences are already saved"); return; }
      const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token.patch) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Save failed");
      const confirmed=settingsForForm(j.settings);
      recovery.savedSuccessfully(token, confirmed);
      toast.success("General preferences saved");
    } catch (error) { const message=error instanceof Error ? error.message : "Save failed"; setSaveError(message); toast.error(message, { duration: 8000 }); }
    finally { savingRef.current=false; setSavingGeneral(false); }
  }

  async function clearBatchHistory() {
    if (!confirm(
      "Clear the recent batch history?\n\n" +
      "This removes batch history and resolved batch issues. Items, photos, unresolved photo groups, and open issues remain available.",
    )) return;
    const t = toast.loading("Clearing batch history…");
    try {
      const r = await fetch("/api/batches", { method: "DELETE" });
      const result = await r.json().catch(() => ({ ok: false }));
      if (!r.ok || !result.ok) throw new Error(result.error || "Could not clear batch history");
      const kept = [result.pendingGroupsKept ? `${result.pendingGroupsKept} unresolved photo group(s)` : "",
        result.openIssuesKept ? `${result.openIssuesKept} open issue(s)` : ""].filter(Boolean);
      toast.success(`Batch history cleared.${kept.length ? ` Kept ${kept.join(" and ")}.` : ""}`, { id: t });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear batch history", { id: t });
    }
  }

  return (
    <GeneralEditing.Provider value={recovery.ready && !loadingPreferences}><div className={`hub-settings ${styles.workspace}`}>
      <div className={styles.header}>
        <div><div className="hub-eyebrow">MAKE IT YOURS</div><h1 className="hub-title">Settings</h1></div>
        <button className="btn btn-primary" onClick={save} disabled={savingGeneral || loadingPreferences || !recovery.ready || recovery.otherWindow || recovery.conflicts.length > 0}><Save size={16} /> {savingGeneral ? "Saving…" : "Save general preferences"}</button>
      </div>
      {saveError && <p role="alert" style={{color:'var(--warn)'}}>{saveError} Your edits are still shown. Saving has not been confirmed.</p>}
      {(loadingPreferences || !recovery.ready || recovery.dirty || recovery.error || recovery.otherWindow) && <section className="card" aria-label="General preferences draft" style={{padding:16}}>
        <p role="status" style={{marginTop:0}}>{loadingPreferences || !recovery.ready ? 'Loading saved preferences and local draft…' : recovery.writing ? 'Keeping your preferences draft on this device…' : recovery.dirty ? 'Unsaved general preferences. Save general preferences to apply them.' : 'General preferences draft recovery needs attention.'}</p>
        {recovery.dirty && !recovery.error && !recovery.writing && <p className="muted">Your draft is kept on this device and will return after a reload.</p>}
        {recovery.error && <p role="alert" style={{color:'var(--warn)'}}>{recovery.error}</p>}
        {recovery.error && recovery.dirty && <p>Save general preferences before leaving to keep the edits shown here.</p>}
        {!!recovery.conflicts.length && !recovery.otherWindow && <>
          <p>Some saved preferences changed since this draft started. Review the differences before choosing which values to keep.</p>
          {recovery.conflicts.map(key => <details key={key} style={{marginBottom:10}}>
            <summary>{DRAFT_LABELS[key] ?? key.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}</summary>
            <p className="muted">Currently saved</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{describeSettingsValue(key,recovery.saved?.[key as keyof AppSettingsData])}</p>
            <p className="muted">Recovered draft</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{describeSettingsValue(key,recovery.draft?.changes[key as keyof typeof recovery.draft.changes] ?? recovery.draft?.workspace)}</p>
          </details>)}
          <button className="btn" disabled={!recovery.ready || loadingPreferences || savingGeneral} onClick={recovery.confirmRecovered}>Keep recovered edits for review</button>{' '}
        </>}
        {recovery.otherWindow ? <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <button className="btn" disabled={!recovery.ready || loadingPreferences || savingGeneral} onClick={async () => { if(confirm("Replace the shared local draft with this window's edits? The other window will need to review the change before saving.")) { setLoadingPreferences(true); if(await recovery.keepThisWindow()) setLoadAttempt(value=>value+1); else setLoadingPreferences(false); } }}>Keep this window’s draft</button>
          <button className="btn" disabled={!recovery.ready || loadingPreferences || savingGeneral} onClick={() => { if(confirm("Replace this form's unsaved edits with the other window's draft?")) { setLoadingPreferences(true); setLoadAttempt(value=>value+1); } }}>Use the other window’s draft</button>
        </div> : recovery.dirty && <button className="btn" disabled={!recovery.ready || loadingPreferences || savingGeneral} onClick={() => { if(confirm('Discard the unsaved general preferences shown here? Saved preferences will not change.')) void recovery.discard(); }}>Discard unsaved preferences</button>}
      </section>}

      <p><Link className="btn" href="/setup">Getting started · tutorial & practice batch</Link></p>
      <div id="marketplaces"><MarketplaceAccounts key={recovery.saved!.dataRoot} workspace={recovery.saved!.dataRoot} /></div>
      <AppearanceSettings />
      <BackupStatus />
      <SaleMonitorControls />
      <BrowserHelp />
      <div id="mercari-goal"><MercariGoal editable /></div>
      <SaleRemovalStatus />

      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Black Cat {process.env.NEXT_PUBLIC_APP_VERSION} · Beta</h3>
        <p>Working toward 2.0: dependable listing and sale protection, faster inventory workflows,
          and an app that is easier to use every day.</p>
        <p className="muted">Marketplace verification and daily-use acceptance are still in progress.</p>
      </section>

      <Section title="Folders">
        {PATH_KEYS.map((k) => (
          <Row key={k} label={PATH_LABELS[k] ?? k}>
            <div className={styles.path}>
              <input className="input" aria-label={PATH_LABELS[k] ?? k} value={String(s[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
              <button className="btn" aria-label={`Choose ${PATH_LABELS[k] ?? k}`} onClick={() => browse(k, k === "pythonWorkerPath")}><FolderOpen size={15} /></button>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="SKU & review">
        <Row label="SKU prefixes (comma)">
          <input className="input" value={s.skuPrefixes.join(",")} onChange={(e) => set("skuPrefixes", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
        </Row>
        <Row label="SKU length"><input className="input" type="number" value={s.skuLength} onChange={(e) => set("skuLength", Number(e.target.value))} /></Row>
        <Row label="SKU regex"><input className="input" value={s.skuRegex} onChange={(e) => set("skuRegex", e.target.value)} /></Row>
        <Row label="Required fields (comma)">
          <input className="input" value={s.requiredFieldsForReady.join(",")} onChange={(e) => set("requiredFieldsForReady", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
        </Row>
        <Row label="Min listing photos"><input className="input" type="number" value={s.minListingPhotos} onChange={(e) => set("minListingPhotos", Number(e.target.value))} /></Row>
        <Row label="File stability (seconds)"><input className="input" type="number" value={s.fileStabilitySeconds} onChange={(e) => set("fileStabilitySeconds", Number(e.target.value))} /></Row>
        <Row label="Backup retention"><input className="input" type="number" value={s.backupRetention} onChange={(e) => set("backupRetention", Number(e.target.value))} /></Row>
      </Section>

      <Section title="OCR">
        <Row label="OCR engine"><code>PaddleOCR (CPU)</code></Row>
        <Row label="Enabled"><Toggle v={s.ocrEnabled} on={(v) => set("ocrEnabled", v)} /></Row>
        <Row label="Preprocess"><Toggle v={s.ocrPreprocess} on={(v) => set("ocrPreprocess", v)} /></Row>
        <Row label="Format correct"><Toggle v={s.ocrPostCorrect} on={(v) => set("ocrPostCorrect", v)} /></Row>
      </Section>

      <Section title="Clothing-tag reading">
        <div className="muted" style={{ fontSize: 12 }}>
          Reads text in the item’s photos to help suggest brand, size and other details.
          It starts with the last photos and may stop early on text that looks like a label.
          Graphics, care text and unclear labels can be misread; a text match does not verify
          the brand or size. Check the photos in Review. Reading more photos can take longer;
          turning this off skips this text-reading step.
        </div>
        <Row label="Enabled"><Toggle v={s.tagOcrEnabled ?? true} on={(v) => set("tagOcrEnabled", v)} /></Row>
        <Row label="Max photos to read">
          <input className="input" type="number" min="1" max="8" value={s.tagOcrMaxPhotos ?? 4}
            onChange={(e) => set("tagOcrMaxPhotos", Number(e.target.value))} />
        </Row>
        <Row label="Minimum confidence">
          <input className="input" type="number" min="0" max="1" step="0.05" aria-describedby="tag-ocr-confidence-help" value={s.tagOcrMinConfidence ?? 0.6}
            onChange={(e) => set("tagOcrMinConfidence", Number(e.target.value))} />
        </Row>
        <p id="tag-ocr-confidence-help" className="muted" style={{fontSize:12,margin:0}}>
          Minimum confidence filters weak text readings. It is not a confidence score for the suggested brand or size.
        </p>
      </Section>

      <Section title="AI Vision (item identification)">
        <Row label="Enabled"><Toggle v={s.visionEnabled ?? false} on={(v) => set("visionEnabled", v)} /></Row>
        <div className="muted" style={{ fontSize: 12 }}>
          Black Cat Reseller runs a fixed, offline vision model on this computer while the app is
          open. Intake and Retry AI share one bounded local GPU session. If the runtime is missing
          or unavailable, turn vision off and enter item fields manually.
        </div>
        <Row label="Runtime"><VisionRuntimeStatus /></Row>
        <Row label="Max photos per item">
          <input className="input" type="number" min="1" max={LOCAL_VISION_MAX_PHOTOS} value={s.visionMaxPhotos}
            onChange={(e) => set("visionMaxPhotos", Number(e.target.value))} />
        </Row>
        <Row label="Fields (comma)">
          <input className="input" value={s.visionFields.join(",")}
            onChange={(e) => set("visionFields", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
        </Row>
        <Row label="Timeout (seconds)">
          <input className="input" type="number" min="10" max="900" value={s.visionTimeoutSeconds}
            onChange={(e) => set("visionTimeoutSeconds", Number(e.target.value))} />
        </Row>
        <Row label="Maximum answer tokens">
          <input className="input" type="number" min="128" max={LOCAL_VISION_MAX_OUTPUT_TOKENS} value={s.visionMaxTokens}
            onChange={(e) => set("visionMaxTokens", Number(e.target.value))} />
        </Row>
        <Row label="Test">
          <VisionTest />
        </Row>
      </Section>

      <Section title="Shipping">
        <Row label="Mercari ship-from ZIP"><input className="input" inputMode="numeric" maxLength={5} value={s.mercariShipFrom?.zip ?? ""} onChange={e=>set("mercariShipFrom",{...s.mercariShipFrom,zip:e.target.value})}/></Row>
        <p className="muted" style={{fontSize:12}}>Used when selecting Mercari labels. Keep it consistent with your shipping address on Mercari.</p>
      </Section>
      <Section title="Automation safeguards">
        <Row label="Stop after consecutive failures"><input className="input" type="number" min={0} value={s.publishAbortAfterConsecutiveFailures} onChange={e=>set("publishAbortAfterConsecutiveFailures",Number(e.target.value))}/></Row>
        <p className="muted" style={{fontSize:12}}>A failing run stops after this many consecutive failures. Zero disables this safeguard.</p>
      </Section>
      <Section title="Earnings — fee & shipping model">
        <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
          Used to estimate fees and postage when actual amounts are not recorded (marked ≈).
          Fee estimate = (item sale price + recorded shipping income) × % + fixed.
          Unrecorded shipping income contributes $0 to this estimate.
        </div>
        {Object.entries(s.feeModel).map(([plat, m]) => (
          <Row key={plat} label={plat === "default" ? "Default / other" : plat}>
            <div className={styles.inlineFields}>
              <input className="input" type="number" aria-label={`${plat} fee percentage`} step="0.1" style={{ width: 86 }} value={m.feePercent}
                onChange={(e) => set("feeModel", { ...s.feeModel, [plat]: { ...m, feePercent: Number(e.target.value) } })} />
              <span className="muted" style={{ fontSize: 12 }}>% +</span>
              <input className="input" type="number" aria-label={`${plat} fixed fee`} step="0.01" style={{ width: 86 }} value={m.fixedFee}
                onChange={(e) => set("feeModel", { ...s.feeModel, [plat]: { ...m, fixedFee: Number(e.target.value) } })} />
              <span className="muted" style={{ fontSize: 12 }}>fixed</span>
            </div>
          </Row>
        ))}
        {s.shippingModel.tiers.map((tier, i) => (
          <Row key={i} label={i === 0 ? "Shipping: ≤ oz → $" : "… ≤ oz → $"}>
            <div className={styles.inlineFields}>
              <input className="input" type="number" aria-label={`Shipping tier ${i+1} maximum ounces`} style={{ width: 86 }} value={tier.maxOz}
                onChange={(e) => { const tiers = s.shippingModel.tiers.slice(); tiers[i] = { ...tier, maxOz: Number(e.target.value) }; set("shippingModel", { ...s.shippingModel, tiers }); }} />
              <span className="muted" style={{ fontSize: 12 }}>oz → $</span>
              <input className="input" type="number" aria-label={`Shipping tier ${i+1} cost`} step="0.01" style={{ width: 86 }} value={tier.cost}
                onChange={(e) => { const tiers = s.shippingModel.tiers.slice(); tiers[i] = { ...tier, cost: Number(e.target.value) }; set("shippingModel", { ...s.shippingModel, tiers }); }} />
            </div>
          </Row>
        ))}
        <Row label="Shipping over top tier ($)">
          <input className="input" type="number" step="0.01" style={{ width: 86 }} value={s.shippingModel.default}
            onChange={(e) => set("shippingModel", { ...s.shippingModel, default: Number(e.target.value) })} />
        </Row>
      </Section>

      <Section title="Pricing">
        <Row label=".99 endings">
          <select className="select" value={s.priceNinetyNine ?? "down"}
            onChange={(e) => set("priceNinetyNine", e.target.value as AppSettingsData["priceNinetyNine"])}>
            <option value="down">Round down (25 → 24.99)</option>
            <option value="up">Round up (25 → 25.99)</option>
            <option value="off">Off — save exactly what I type</option>
          </select>
        </Row>
        <Row label="Warn below ($)">
          <input className="input" type="number" min="0" style={{ width: 96 }} value={s.priceWarnMin ?? 5}
            onChange={(e) => set("priceWarnMin", Number(e.target.value))} />
        </Row>
        <Row label="Warn above ($)">
          <input className="input" type="number" min="0" style={{ width: 96 }} value={s.priceWarnMax ?? 500}
            onChange={(e) => set("priceWarnMax", Number(e.target.value))} />
        </Row>
        <div className="muted" style={{ fontSize: 12 }}>
          Applied in Review → Pricing: whole numbers get the .99 ending (typed decimals are kept as-is), and a
          price outside the range needs a second Enter — a cheap guard against typos like $2 instead of $20.
        </div>
        <Row label="One-click Google Lens"><Toggle v={s.lensPublicUpload ?? false} on={(v) => set("lensPublicUpload", v)} /></Row>
        <div className="muted" style={{ fontSize: 12 }}>
          ON: the 📷 button uploads the cover photo to a temporary public host (auto-deletes after ~1 hour) so
          Lens opens with results in one click. OFF: the photo is only copied to your clipboard — paste it into
          Lens yourself; nothing leaves this machine.
        </div>
      </Section>

      <Section title="Maintenance">
        <Row label="Fix brand spellings">
          <BrandCleanup />
        </Row>
        <Row label="Archive cleanup">
          <ArchiveCleanup savedPath={recovery.saved?.archivePath ?? ""} settingsKey={JSON.stringify(PATH_KEYS.map(key=>recovery.saved?.[key]))} dirty={PATH_KEYS.some(key=>s[key]!==recovery.saved?.[key])}/>
        </Row>
        <Row label="Clear batch history">
          <div>
            <button className="btn btn-danger" onClick={clearBatchHistory} data-sound="none">
              <Trash2 size={15} /> Clear batch history
            </button>
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Removes the recent upload/batch log only. Items &amp; photos are not affected.
            </p>
          </div>
        </Row>
      </Section>
    </div></GeneralEditing.Provider>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const editable = useContext(GeneralEditing);
  return (
    <details className={`card hub-preferences ${styles.section}`}>
      <summary style={{ fontSize: 14, fontWeight: 700, cursor:"pointer" }}>{title}</summary>
      <SectionName.Provider value={title}><fieldset className={styles.sectionBody} disabled={!editable}>{children}</fieldset></SectionName.Provider>
    </details>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const id=useId(), section=useContext(SectionName), name=`${section}: ${label}`;
  const native=isValidElement<{id?:string;'aria-label'?:string;'aria-labelledby'?:string}>(children)
    && typeof children.type==='string' && ['input','select','textarea'].includes(children.type);
  const controlId=native ? children.props.id ?? id : undefined;
  const content=native ? cloneElement(children,{id:controlId,...(!children.props['aria-label']&&!children.props['aria-labelledby']?{'aria-label':name}:{})}) : children;
  return (
    <div className={styles.row}>
      {native?<label className={styles.label} htmlFor={controlId}>{label}</label>:<span className={styles.label}>{label}</span>}
      <SettingName.Provider value={name}><div className={styles.controls} role={native?undefined:'group'} aria-label={native?undefined:name}>{content}</div></SettingName.Provider>
    </div>
  );
}
function Toggle({ v, on }: { v: boolean; on: (v: boolean) => void }) {
  const name=useContext(SettingName);
  // Sliding pill switch — matches the Ready page toggle so the app has one toggle style.
  return (
    <button
      type="button"
      onClick={() => on(!v)}
      data-sound="toggle"
      role="switch" aria-label={name} aria-checked={v} className={styles.toggle}
    >
      <span className={styles.toggleTrack}><span /></span>
    </button>
  );
}

type VisionView = { kind:string; model?:string; reason?:string; serverReady:boolean };
async function readVisionStatus(signal:AbortSignal):Promise<VisionView> {
  const response=await fetch('/api/vision',{cache:'no-store',signal});
  if(!response.ok)throw Error('Could not read local runtime status.');
  const {status}=await response.json();
  if(!status||typeof status.kind!=='string'||!status.kind||typeof status.serverReady!=='boolean'
    ||[status.model,status.reason].some(value=>value!==undefined&&typeof value!=='string'))
    throw Error('Local runtime status is incomplete. Refresh to confirm it.');
  return status;
}
function VisionRuntimeStatus() {
  const view=usePolledRead(readVisionStatus,5000);
  const {data:status,error,load}=view;
  return <div style={{fontSize:12}}>
    {error&&<p role="alert">{error}</p>}
    {!status?<span>{error?'Runtime status is unavailable.':'Checking…'}</span>:<span style={{color:view.fresh&&status.serverReady?'var(--ok)':'var(--muted)'}}>
      {!view.fresh&&'Last loaded: '}{status.serverReady?'Ready':status.kind}
      {status.model?` · ${status.model}`:''}{status.reason?` — ${status.reason}`:''}
    </span>}
    {error&&<button className="btn" onClick={()=>void load()}>Refresh runtime status</button>}
  </div>;
}

// The probe uses the same serialized localhost image path as production.
function VisionTest() {
  const [busy, setBusy] = useState(false);
  const busyRef=useRef(false);
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);

  async function run() {
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);
    setResult("Sending one image probe to the local GPU model…");
    setOk(null);
    try {
      const r = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "probe" }),
      });
      const j = await r.json();
      const p = j.probe;
      if (r.ok && p?.ok===true) {
        setOk(true);
        setResult(p.tested
          ? `Working — the local model answered the image probe${p.model ? ` as ${p.model}` : ""}.`
          : p.reason);
      } else {
        setOk(false);
        setResult(p?.kind === "deferred"
          ? `${p.reason} Nothing was started; retry shortly.`
          : (p?.reason ?? j.error ?? "The local vision probe could not be confirmed."));
      }
    } catch (e) {
      setOk(false);
      setResult(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current=false;setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={run} disabled={busy} data-sound="none"
          title="Run one bounded image probe through the offline local vision model">
          {busy ? "Testing…" : "Test local vision"}
        </button>
      </div>
      {result && (
        <p style={{ fontSize: 12, margin: "6px 0 0", color: ok == null ? "var(--muted)" : ok ? "var(--ok)" : "var(--danger)" }}>
          {ok === true ? "✓ " : ok === false ? "✗ " : ""}{result}
        </p>
      )}
    </div>
  );
}
