import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRequiredSettings } from "@/lib/settings";
import { AUTO_MARKETPLACES, configureAutoRun, readAutoRun } from "@/lib/publish/autoRun";
import { autoRunService, startAutoCrosslisting } from "@/lib/publish/autoRunService";
import { getAdapter } from "@/lib/publish/adapters/registry";
import { kickEngine } from "@/lib/publish/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
  const settings = await getRequiredSettings();
  startAutoCrosslisting();
  return NextResponse.json({ config: readAutoRun(settings.publish?.autoRun), ...autoRunService().controller.snapshot() });
  } catch { return NextResponse.json({ error: 'Auto Run settings could not be refreshed. Try again.' }, { status: 503 }); }
}
export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid Auto Run settings." }, { status: 400 }); }
  if (!body || typeof body.enabled !== "boolean" || !Array.isArray(body.marketplaces) || !body.marketplaces.length || body.marketplaces.some((name: string) => !AUTO_MARKETPLACES.includes(name as typeof AUTO_MARKETPLACES[number]))) return NextResponse.json({ error: "Choose supported platforms for Auto Run." }, { status: 400 });
  try {
  if (body.enabled) {
    const settings = await getRequiredSettings();
    if (body.marketplaces.some((name: string) => !getAdapter(name)?.availability(settings).configured)) return NextResponse.json({ error: "Connect and enable the selected platforms first." }, { status: 422 });
  }
  const config = await configureAutoRun(prisma, body.enabled, body.marketplaces);
  startAutoCrosslisting();
  if (config.enabled) { void kickEngine(); void autoRunService().controller.tick(); }
  return NextResponse.json({ ok: true, config, ...autoRunService().controller.snapshot() });
  } catch { return NextResponse.json({ error: 'Auto Run change could not be confirmed. Refresh the saved state before trying again.' }, { status: 503 }); }
}
