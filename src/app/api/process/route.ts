import { getSettings } from "@/lib/settings";
import { parseProcessIntent } from "@/lib/types";
import { workerPythonExists } from "@/lib/worker";
import { existingIntakeJob, startIntakeJob } from "@/lib/intakeJobs";
import { validIntakeJobId } from "@/lib/intakeJobStore";
import {
  InvalidManagedWorkRootsError,
  validateManagedWorkRoots,
} from "@/lib/workRoots";
import { managedVisionStatus } from "@/lib/visionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The request observes a service-owned job. Disconnecting this stream never
// cancels its worker; explicit POST /api/process/cancel is the only cancel path.
export async function POST(req: Request) {
  const enc = new TextEncoder();
  const ndjson = (value: Record<string, unknown>) => enc.encode(JSON.stringify(value) + "\n");
  const reply = (value: Record<string, unknown>, status: number, extra: Record<string, string> = {}) =>
    new Response(ndjson(value), { status, headers: { "Content-Type": "application/x-ndjson", ...extra } });
  let body: unknown;
  try { const text = await req.text(); body = text.trim() ? JSON.parse(text) : {}; }
  catch { return reply({ type: "error", error: "INVALID_PROCESS_INTENT", reason: "request body is not valid JSON" }, 400); }
  const intent = parseProcessIntent(body);
  if (!intent.ok) return reply({ type: "error", error: "INVALID_PROCESS_INTENT", reason: intent.error }, 400);
  const resumeJobId = (body as Record<string, unknown>).resumeJobId;
  if (resumeJobId !== undefined && !validIntakeJobId(resumeJobId)) {
    return reply({ type: "error", error: "INVALID_PROCESS_INTENT", reason: "resumeJobId must identify a saved job" }, 400);
  }
  const settings = await getSettings();
  try { validateManagedWorkRoots(settings); }
  catch (error) {
    if (error instanceof InvalidManagedWorkRootsError) return reply({ type: "error", error: error.code, reason: error.message }, 409);
    throw error;
  }
  let job = existingIntakeJob(settings);
  if (!job) {
    if (!workerPythonExists(settings)) return reply({ type: "error", error: "WORKER_VENV_MISSING", pythonWorkerPath: settings.pythonWorkerPath }, 409);
    if (!intent.forceNoAi && settings.visionEnabled) {
      const status = await managedVisionStatus(true);
      if (!status.ok || status.kind !== "ready") return reply({ type: "error", error: "VISION_UNAVAILABLE", kind: status.kind, reason: status.reason },
        503, status.kind === "starting" ? { "Retry-After": "30" } : {});
    }
  }
  try {
    job = startIntakeJob(settings, { forceNoAi: intent.forceNoAi, ...(typeof resumeJobId === "string" ? { resumeJobId } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ type: "error", error: message }, message === "INTAKE_BUSY" ? 409 : 500);
  }
  const admission = await job.admission;
  if (!admission.ok) {
    if (admission.kind === "deferred") return reply({ type: "deferred", error: "VISION_DEFERRED", kind: admission.deferral.status,
      reason: admission.deferral.detail ?? admission.deferral.message }, 503, { "Retry-After": "30" });
    if (admission.kind === "cancelled") return reply({ type: "cancelled" }, 409);
    return reply({ type: "error", error: admission.error, jobId: job.job.id }, 500);
  }
  let unsubscribe = () => {};
  const active = job;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = active.subscribe(event => { try { controller.enqueue(ndjson(event)); } catch { /* detached */ } });
      void active.terminal.finally(() => { unsubscribe(); try { controller.close(); } catch { /* detached */ } });
    },
    cancel() { unsubscribe(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform" } });
}
