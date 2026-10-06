import { NextRequest, NextResponse } from "next/server";
import { createRun } from "@/lib/publish/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start an Auto Run (§45.7): queue the selected approved items for the selected
// marketplaces. Items already published or already queued are SKIPPED and
// reported, never silently double-queued (§45.19).
export async function POST(req: NextRequest) {
  let itemIds: number[] = [];
  let marketplaces: string[] = [];
  try {
    const body = await req.json();
    itemIds = Array.isArray(body?.itemIds) ? body.itemIds.map(Number).filter(Number.isInteger) : [];
    marketplaces = Array.isArray(body?.marketplaces) ? body.marketplaces.map(String) : [];
  } catch {
    return NextResponse.json({ ok: false, error: "bad request body" }, { status: 400 });
  }
  const result = await createRun(itemIds, marketplaces);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
