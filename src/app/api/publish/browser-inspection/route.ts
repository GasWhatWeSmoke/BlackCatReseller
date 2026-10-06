import { NextRequest, NextResponse } from "next/server";
import { browserInspections, clearBrowserInspections, parseBrowserInspection, saveBrowserInspection } from "@/lib/publish/browserInspection";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ inspections: browserInspections() }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (raw.length > 150_000) return NextResponse.json({ error: "Inspection is too large." }, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid inspection." }, { status: 400 }); }
  const inspection = parseBrowserInspection(value);
  if (!inspection) return NextResponse.json({ error: "Invalid inspection." }, { status: 400 });
  const saved = saveBrowserInspection(inspection);
  return NextResponse.json({ ok: true, inspectedAt: saved.inspectedAt });
}
export async function DELETE() {
  clearBrowserInspections();
  return NextResponse.json({ ok: true });
}
