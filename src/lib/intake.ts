// Shared mapping from the /api/process NDJSON events to a display state — used by BOTH
// the dashboard's progress card and the global drag-drop pill, so every intake path shows
// the same live progress (label + counts + an honest percent).
//
// Percent weighting reflects where wall-clock actually goes. hash/exif/decode each touch
// every photo in the batch and together are minutes on a large drop; per-item processing
// + AI vision still dominates (42–95%); persist is the tail (96%).

export interface IntakeProgress {
  label: string;
  sub?: string;
  pct: number | null; // 0..100, null = indeterminate
}

/** Position within a stage's slice of the bar, clamped so a miscounted total
 * can never drive the bar backwards past the next stage. */
function span(done: number, total: number, from: number, to: number): number {
  const frac = Math.max(0, Math.min(1, done / Math.max(1, total)));
  return from + frac * (to - from);
}

export function intakeStage(ev: Record<string, unknown>): IntakeProgress | null {
  const type = ev.type as string;
  if (type === "persisting") return { label: "Saving items…", pct: 96 };
  if (type !== "progress") return null;

  const st = ev.stage as string;
  const done = Number(ev.done) || 0;
  const total = Math.max(1, Number(ev.total) || 1);
  const message = typeof ev.message === "string" ? ev.message : "";

  if (st === "vision_boot") {
    return { label: message || "Checking the AI vision model…", pct: 1 };
  }
  if (st === "scan") {
    const found = Number(ev.total) || 0;
    if (message) return { label: message, pct: 2 };
    return { label: found ? `Found ${found} photo(s)…` : "Scanning photos…", pct: 2 };
  }
  if (st === "hash") {
    return { label: "Checking photos…", sub: `${done}/${total}`, pct: span(done, total, 3, 16) };
  }
  if (st === "exif") {
    return { label: "Reading photo dates…", sub: `${done}/${total}`, pct: span(done, total, 16, 24) };
  }
  if (st === "sort") return { label: "Putting photos in order…", pct: 25 };
  if (st === "decode") {
    // The engine-unavailable warning rides this stage with no counts.
    if (!ev.done && message) return { label: message, pct: 25 };
    return {
      label: "Reading SKU stickers…",
      sub: `${done}/${total}`,
      pct: span(done, total, 25, 40),
    };
  }
  if (st === "group") return { label: `Grouped ${ev.items} item(s)…`, pct: 42 };
  if (st === "item" || st === "enrich") {
    const i = Number(ev.i) || 0;
    const n = Number(ev.n) || 0;
    const sku = String(ev.sku ?? "");
    const label = st === "enrich" ? `Analyzing ${sku} with AI…` : `Processing ${sku}…`;
    if (i > 0 && n > 0) {
      // Within an item, "item" (file ops) is the first sliver and "enrich" the bulk.
      const frac = (i - 1 + (st === "enrich" ? 0.35 : 0.1)) / n;
      return { label, sub: `item ${i} of ${n}`, pct: 42 + frac * 53 };
    }
    return { label, pct: null };
  }
  return null; // enrich_done etc. — keep showing the previous state
}

/** Poll GET /api/process/progress while the POST is still headless.
 *
 * POST /api/process withholds its response until the worker admits, and the worker
 * admits only after hashing, EXIF and decoding the entire batch — on a several-hundred
 * photo drop that is minutes during which the stream can say nothing at all. Polling
 * the snapshot covers exactly that window; the stream takes over once it opens.
 *
 * Returns a stop function. The poller also stops on its own once the server reports
 * no intake running, so a missed stop cannot leak a timer forever.
 */
export function pollIntakeProgress(
  onProgress: (p: IntakeProgress) => void,
  intervalMs = 700,
): () => void {
  let stopped = false;
  let lastSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetch("/api/process/progress", { cache: "no-store" });
      if (res.ok) {
        const snap = await res.json() as { running?: boolean; seq?: number; event?: Record<string, unknown> | null };
        if (stopped) return;
        if (snap.running === false && lastSeq > 0) { stopped = true; return; }
        if (snap.event && typeof snap.seq === "number" && snap.seq > lastSeq) {
          lastSeq = snap.seq;
          const p = intakeStage({ ...snap.event, type: "progress" });
          if (p) onProgress(p);
        }
      }
    } catch {
      /* a dropped poll is not an intake failure — the stream is still the source of truth */
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
  };

  timer = setTimeout(() => { void tick(); }, intervalMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
