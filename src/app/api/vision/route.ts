import { NextRequest, NextResponse } from "next/server";
import { getRequiredSettings } from "@/lib/settings";
import {
  managedVisionProbe,
  managedVisionProbeHttpStatus,
  managedVisionStatus,
  type ManagedVisionProbeRunner,
} from "@/lib/visionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkerProbeModule = {
  runVisionProbe?: (
    settings: Awaited<ReturnType<typeof getRequiredSettings>>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  runManagedVisionProbe?: (
    settings: Awaited<ReturnType<typeof getRequiredSettings>>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

/** Resolve the worker-owned image probe without creating a second lifecycle path. */
async function workerProbeRunner(
  settings: Awaited<ReturnType<typeof getRequiredSettings>>,
  signal?: AbortSignal,
): Promise<ManagedVisionProbeRunner | undefined> {
  const worker = await import("@/lib/worker") as unknown as WorkerProbeModule;
  const probe = worker.runVisionProbe ?? worker.runManagedVisionProbe;
  return probe ? () => probe(settings, { signal }) : undefined;
}

// GET is deliberately read-only: local assets and Electron state, no model request.
export async function GET() {
  try {
  const settings = await getRequiredSettings();
  return NextResponse.json({ status: await managedVisionStatus(settings.visionEnabled) });
  } catch { return NextResponse.json({error:'Saved vision settings or local runtime status could not be read.'},{status:503}); }
}

// POST {action:"probe"} runs at most one bounded image request through the same
// serialized localhost worker path as intake. Electron alone owns server lifecycle.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const action = body.action ?? "probe";
  if (action !== "probe") {
    const retired = action === "ensure" || action === "release" || action === "test";
    return NextResponse.json({
      error: retired
        ? `vision action "${String(action)}" was retired; use the local image probe`
        : `unknown vision action "${String(action)}"`,
    }, { status: retired ? 410 : 400 });
  }

  try {
  const settings = await getRequiredSettings();
  const status = await managedVisionStatus(settings.visionEnabled);
  const runner = status.ok && status.kind !== "disabled"
    ? await workerProbeRunner(settings, req.signal)
    : undefined;
  const probe = await managedVisionProbe(settings.visionEnabled, runner);
  const headers = probe.kind === "busy" || probe.kind === "starting"
    ? { "Retry-After": "30" }
    : undefined;
  const httpStatus = managedVisionProbeHttpStatus(probe);
  return NextResponse.json({ status, probe }, { status: httpStatus, headers });
  } catch { return NextResponse.json({error:'The local vision probe could not be confirmed. Check saved settings and retry.'},{status:503}); }
}
