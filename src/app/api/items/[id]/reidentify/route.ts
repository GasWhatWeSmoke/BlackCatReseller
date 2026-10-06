import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import {
  ManagedVisionCancelledError,
  ManagedVisionCancelRequestError,
  ManagedVisionDeferredError,
  workerPythonExists,
} from "@/lib/worker";
import { reidentifyItem } from "@/lib/reidentify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/items/[id]/reidentify — re-run AI vision identification for one item
// from its STORED photos (no re-import). The recovery path for items that came in
// with aiError set (dead endpoint / text-only model) and for accessory items
// imported before the category-aware prompt existed. Core logic: src/lib/reidentify.ts.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const settings = await getSettings();
  if (!settings.visionEnabled) {
    return NextResponse.json({ error: "AI vision is disabled in Settings" }, { status: 422 });
  }
  if (!workerPythonExists(settings)) {
    return NextResponse.json({ error: "worker venv missing" }, { status: 409 });
  }

  try {
    const r = await reidentifyItem(id, settings, { signal: req.signal });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, item: r.item, filled: r.filled });
  } catch (error) {
    if (error instanceof ManagedVisionDeferredError) {
      return NextResponse.json({
        ok: false,
        error: "VISION_DEFERRED",
        retryable: true,
        ...error.deferral,
      }, { status: 503, headers: { "Retry-After": "30" } });
    }
    if (error instanceof ManagedVisionCancelledError) {
      return NextResponse.json({ ok: false, error: "VISION_CANCELLED" }, { status: 409 });
    }
    if (error instanceof ManagedVisionCancelRequestError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 500 });
    }
    return NextResponse.json({ ok: false, error: "re-identification failed" }, { status: 500 });
  }
}
