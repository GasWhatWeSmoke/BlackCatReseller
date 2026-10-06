import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { prepareReidentifyItem } from "@/lib/reidentify";
import { runReenrich, ManagedVisionDeferredError, ManagedVisionCancelledError } from "@/lib/worker";
export const runtime = "nodejs";
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = await request.json().catch(() => null);
  if (!Number.isSafeInteger(id) || !Array.isArray(body?.photoIds) || body.photoIds.length < 1 || body.photoIds.length > 4 || body.photoIds.some((value: unknown) => !Number.isSafeInteger(value))) return NextResponse.json({ error: "Choose one to four item photos." }, { status: 400 });
  const settings = await getSettings();
  if (!settings.visionEnabled) return NextResponse.json({ error: "Enable local AI in Settings to request suggestions." }, { status: 422 });
  const result = await prepareReidentifyItem(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const selected = [...new Set<number>(body.photoIds)].map(photoId => result.prepared.photos.find(photo => photo.photoId === photoId));
  if (selected.some(photo => !photo)) return NextResponse.json({ error: "The chosen photos are no longer included in this item." }, { status: 409 });
  try {
    const enrichment = await runReenrich(settings, result.prepared.item.sku, selected as typeof result.prepared.photos, { signal: request.signal });
    if (enrichment.error) return NextResponse.json({ error: enrichment.error }, { status: 422 });
    const raw = enrichment.raw && typeof enrichment.raw === "object" ? enrichment.raw as Record<string, unknown> : {};
    const mapped = enrichment.fields ?? {};
    const values = { brand: mapped.brand, itemType: mapped.itemType, size: mapped.size, color: mapped.color,
      department: raw.department, model: raw.model, styleNumber: raw.styleNumber };
    return NextResponse.json({ suggestions: Object.entries(values).filter(([,value]) => typeof value === "string" && value.trim() && value.length <= 200).map(([field,value]) => ({ field, value })),
      note: "Suggestions only. Nothing has been changed until you choose a value and save." });
  } catch (error) {
    if (error instanceof ManagedVisionDeferredError) return NextResponse.json({ error: "Local AI is busy. Try again when the current task finishes." }, { status: 409 });
    if (error instanceof ManagedVisionCancelledError) return NextResponse.json({ error: "AI suggestion check cancelled." }, { status: 409 });
    return NextResponse.json({ error: "The local AI check could not finish. Your item has not changed." }, { status: 500 });
  }
}
