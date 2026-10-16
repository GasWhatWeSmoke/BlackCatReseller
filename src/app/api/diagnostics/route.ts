import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { prisma } from "@/lib/db";
import { diagnosticsEnabled, exportDiagnostics, recordDiagnosticEvents, setDiagnosticsEnabled } from "@/lib/diagnostics";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (process.env.BLACKCAT_PREVIEW === "1") return NextResponse.json({ enabled: false, available: false }, { headers: { "Cache-Control": "no-store" } });
    const settings = await getSettings();
    if (req.nextUrl.searchParams.get("export") !== "1") return NextResponse.json({ enabled: diagnosticsEnabled(settings) }, { headers: { "Cache-Control": "no-store" } });
    return new NextResponse(JSON.stringify(await exportDiagnostics(settings, prisma), null, 2), { headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="BlackCat-diagnostics-${new Date().toISOString().slice(0, 10)}.json"`,
    } });
  } catch { return NextResponse.json({ error: "Could not read local diagnostics." }, { status: 500 }); }
}
export async function POST(req: NextRequest) {
  try {
    const text = await req.text();
    if (text.length > 24_000) return NextResponse.json({ error: "Diagnostic request is too large." }, { status: 413 });
    const body = JSON.parse(text), settings = await getSettings();
    if (body.action === "set_enabled") return NextResponse.json({ enabled: setDiagnosticsEnabled(settings, body.enabled) });
    return NextResponse.json({ recorded: recordDiagnosticEvents(settings, body.events) });
  } catch { return NextResponse.json({ error: "Local diagnostics could not be saved." }, { status: 400 }); }
}
