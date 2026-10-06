import { CheckCircle2, Clock3, Loader2 } from "lucide-react";
import type { StatusPayload } from "@/lib/publish/uiTypes";
import { elapsedTime, progressSummary, uploadStageLabel } from "@/lib/publish/progressSummary";
import styles from "./UploadRunOverview.module.css";

export default function UploadRunOverview({ status, now, stale = false }: { status: StatusPayload; now: number | null; stale?: boolean }) {
  if (!status.run) return null;
  const p = progressSummary(status), run = status.run, current = status.current;
  const complete = p.total > 0 && p.published === p.total;
  const title = complete ? "Everything is listed" : run.status === "paused" ? "Crosslisting paused"
    : run.status === "cancelled" ? "Run cancelled" : run.status === "done" ? "Run needs attention" : "Crosslisting your batch";
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const name = (id: string) => status.marketplaces.find(m => m.id === id)?.name ?? id;
  return <section className={styles.overview} aria-label="Crosslisting progress" data-stale={stale}>
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}>BATCH PROGRESS</p><h3>{title}</h3></div>
      <strong className={styles.percent}>{p.percent}<span>% live</span></strong>
    </div>
    <div className={styles.bar} role="progressbar" aria-label="Listings confirmed published" aria-valuemin={0} aria-valuemax={p.total || 1}
      aria-valuenow={p.published} aria-valuetext={`${p.published} of ${p.total} listings confirmed published`}>
      <div style={{ width: `${p.percent}%` }} />
    </div>
    <div className={styles.totals}>
      <span><strong>{p.published} / {p.total}</strong> listings published</span>
      {p.totalPieces > 0 && <span><strong>{p.completedPieces} / {p.totalPieces}</strong> pieces fully crosslisted</span>}
      <span className={styles.elapsed}><Clock3 size={14} /> {end === null ? "—" : elapsedTime(run.startedAt, end)} elapsed</span>
    </div>
    <div className={styles.counts}>
      <span>{p.queued} queued</span><span>{p.active} uploading</span>
      <span data-attention={p.attention > 0}>{p.attention} need attention</span>
      {p.cancelled > 0 && <span>{p.cancelled} cancelled</span>}
    </div>
    {current ? <div className={styles.current}>
      <Loader2 size={21} className={stale ? undefined : "spin"} aria-hidden="true" />
      <div><small>{stale ? "Last known activity · connection interrupted" : run.status === "paused" ? "Finishing the current browser action" : "WORKING NOW"}</small>
        <strong>{current.sku} <span>→</span> {name(current.marketplace)}</strong>
        <p role="status">{uploadStageLabel(current.phase?.stage, current.phase?.photoCount)}{current.attempt > 1 ? ` · attempt ${current.attempt}` : ""}</p>
      </div>
    </div> : complete ? <div className={styles.finished}><CheckCircle2 size={18} /> Every listing in this run is confirmed published.</div>
      : <p className={styles.waiting}>{stale ? "Progress will refresh when the connection returns." : run.status === "paused" ? "Resume when you are ready. Published listings stay live."
        : run.status === "cancelled" ? "Unfinished listings were cancelled. Published listings stay live."
        : run.status === "done" ? "Review the items needing attention below before retrying."
        : status.browserBusyWith ? `Waiting for ${status.browserBusyWith}. Your pieces remain queued.` : "Preparing the next listing…"}</p>}
    <div className={styles.platforms}>
      {p.platforms.map(platform => <div className={styles.platform} key={platform.marketplace} data-active={current?.marketplace === platform.marketplace}>
        <div><strong>{name(platform.marketplace)}</strong><span>{platform.published}/{platform.total}</span></div>
        <progress max={platform.total || 1} value={platform.published} aria-label={`${name(platform.marketplace)} listings published`} />
        <small>{platform.active ? "Uploading now" : platform.total > 0 && platform.published === platform.total ? "Complete" : `${platform.queued} queued`}
          {platform.attention > 0 && <span className={styles.warning}> · {platform.attention} need attention</span>}
          {platform.cancelled > 0 && <span> · {platform.cancelled} cancelled</span>}</small>
      </div>)}
    </div>
    <p className={styles.note}>Progress counts confirmed listings. A listing stays in progress while its photos, details and publication are checked.</p>
  </section>;
}
