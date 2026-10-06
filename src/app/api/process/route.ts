import { getSettings } from "@/lib/settings";
import { parseProcessIntent } from "@/lib/types";
import {
  INTAKE_CANCELLED,
  releaseIntakePrep,
  startIntake,
  tryReserveIntake,
  workerPythonExists,
} from "@/lib/worker";
import { persistWorkerResult } from "@/lib/persist";
import {
  InvalidManagedWorkRootsError,
  validateManagedWorkRoots,
} from "@/lib/workRoots";
import { managedVisionStatus } from "@/lib/visionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Clicking "Process" spawns the one-shot Python worker over /incoming, then the structured
// result is persisted via Prisma (single writer for app data). The response is an NDJSON
// STREAM (one JSON object per line) so the Upload page can show live progress (current SKU
// + counts) instead of a single spinner (§25.2):
//   { "type":"progress", "stage":"vision_boot"|"decode"|"group"|"item"|"enrich"|..., ... }
//   { "type":"persisting" }
//   { "type":"done", "summary":{...}, "counts":{...} }
//   { "type":"error", "error":"..." }
//
// Body (optional JSON): { "force": true } — explicitly run WITHOUT AI
// identification. The worker receives this intent before admission, acquires no
// local vision session, and makes no image request. Without force, the worker
// owns one serialized local-model session from admission through the final ask.
export async function POST(req: Request) {
  const settings = await getSettings();
  const enc = new TextEncoder();
  const ndjson = (o: Record<string, unknown>) => enc.encode(JSON.stringify(o) + "\n");
  const ndjsonResponse = (
    body: Record<string, unknown>,
    status: number,
    extraHeaders: Record<string, string> = {},
  ) => new Response(ndjson(body), {
    status,
    headers: { "Content-Type": "application/x-ndjson", ...extraHeaders },
  });
  const rawBody = await req.text();
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return ndjsonResponse({ type: "error", error: "INVALID_PROCESS_INTENT", reason: "request body is not valid JSON" }, 400);
    }
  }
  const intent = parseProcessIntent(body);
  if (!intent.ok) return ndjsonResponse({ type: "error", error: "INVALID_PROCESS_INTENT", reason: intent.error }, 400);
  const force = intent.forceNoAi;

  try {
    validateManagedWorkRoots(settings);
  } catch (error) {
    if (error instanceof InvalidManagedWorkRootsError) {
      return ndjsonResponse({ type: "error", error: error.code, reason: error.message }, 409);
    }
    throw error;
  }

  if (!workerPythonExists(settings)) {
    return ndjsonResponse(
      { type: "error", error: "WORKER_VENV_MISSING", pythonWorkerPath: settings.pythonWorkerPath },
      409,
    );
  }
  if (!force && settings.visionEnabled) {
    const visionStatus = await managedVisionStatus(true);
    if (!visionStatus.ok || visionStatus.kind !== "ready") {
      return ndjsonResponse({
        type: "error",
        error: "VISION_UNAVAILABLE",
        kind: visionStatus.kind,
        reason: visionStatus.reason,
      }, 503, visionStatus.kind === "starting" ? { "Retry-After": "30" } : {});
    }
  }
  if (req.signal.aborted) {
    return ndjsonResponse({ type: "cancelled" }, 409);
  }
  // One intake at a time: a second run over the same /incoming would double-process
  // photos, and the cooperative cancel registry can only target the newest worker.
  if (!tryReserveIntake()) {
    return ndjsonResponse({ type: "error", error: "INTAKE_BUSY" }, 409);
  }
  if (req.signal.aborted) {
    releaseIntakePrep();
    return ndjsonResponse({ type: "cancelled" }, 409);
  }

  // Admission must finish before headers are sent. That lets a managed GPU
  // deferral remain a real HTTP 503 (and leaves every source photo untouched),
  // instead of hiding a retryable outcome inside a 200 response stream.
  let intake: ReturnType<typeof startIntake>;
  let requestAborted: boolean = req.signal.aborted;
  let abortHandler: (() => void) | null = null;
  try {
    intake = startIntake(settings, { forceNoAi: force });
    abortHandler = () => {
      requestAborted = true;
      try { intake.cancel(); } catch { /* cleanup still waits for natural worker exit */ }
    };
    req.signal.addEventListener("abort", abortHandler, { once: true });
    if (requestAborted) {
      try { intake.cancel(); } catch { /* cleanup still waits for natural worker exit */ }
    }
    const admission = await intake.admission;
    if (!admission.ok) {
      if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
      releaseIntakePrep();
      if (admission.kind === "deferred") {
        return ndjsonResponse({
          type: "deferred",
          error: "VISION_DEFERRED",
          kind: admission.deferral.status,
          reason: admission.deferral.detail ?? admission.deferral.message,
          attempts: admission.deferral.attempts,
          elapsedSeconds: admission.deferral.elapsedSeconds,
        }, 503, { "Retry-After": "30" });
      }
      if (admission.kind === "cancelled") {
        return ndjsonResponse({ type: "cancelled" }, 409);
      }
      return ndjsonResponse({ type: "error", error: admission.error }, 500);
    }
  } catch (error) {
    if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
    releaseIntakePrep();
    const message = error instanceof Error ? error.message : String(error);
    return ndjsonResponse({ type: "error", error: message }, 500);
  }

  let finishPipeline!: () => void;
  const pipelineDone = new Promise<void>((resolve) => { finishPipeline = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: Record<string, unknown>) => {
        try {
          controller.enqueue(ndjson(o));
        } catch {
          /* stream already closed (client navigated away) */
        }
      };
      const unsubscribe = intake.subscribe((ev) => {
        // Worker data can never override the response-stream discriminator.
        send({ ...ev, type: "progress" });
        // Keep the server-log breadcrumbs for debugging.
        const s = ev.stage;
        if (s === "group") {
          console.log(`[worker] grouped ${ev.items} item(s) (${ev.needsReview} need-review, ${ev.problems} problem(s))`);
        } else if (s === "item") {
          console.log(`[worker] item ${ev.sku}: ${ev.listingPhotos} listing photo(s)` + (ev.collision ? " [collision]" : ""));
        } else if (s === "enrich_done") {
          console.log(`[worker] AI ${ev.sku}: ${ev.ok ? "ok" : "FAILED " + ev.error}`);
        }
      });
      try {
        const result = await intake.result;
        // Once Python returns a validated result it has already moved/copied the
        // source files. Persist even when the client disconnected; cancellation
        // observed before this boundary exits rc130 and never yields a result.
        send({ type: "persisting" });
        const summary = await persistWorkerResult(result, settings);
        console.log(`[process] batch #${summary.batchId} saved — ${summary.itemsCreated} item(s), ` +
          `${summary.duplicatesSkipped} dupe(s), ${summary.collisions} collision(s), ${summary.problems} problem(s)` +
          (summary.aiFailed ? `, AI FAILED for ${summary.aiFailed}/${summary.aiTotal}: ${summary.aiFirstError}` : ""));
        send({ type: "done", summary, counts: result.counts });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A user-initiated cancel (POST /api/process/cancel) is an outcome, not an
        // error — the photos are still pending in /incoming, nothing was saved.
        if (msg === INTAKE_CANCELLED) send({ type: "cancelled" });
        else send({ type: "error", error: msg });
      } finally {
        unsubscribe();
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        releaseIntakePrep();
        finishPipeline();
        try { controller.close(); } catch { /* client already cancelled */ }
      }
    },
    async cancel() {
      try { intake.cancel(); } catch { /* wait for the pipeline's natural cleanup */ }
      // ReadableStream.cancel runs concurrently with async start. Intake result
      // resolution is not enough: persistence may already be underway.
      await pipelineDone;
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform" },
  });
}
