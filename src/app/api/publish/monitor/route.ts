import { NextRequest, NextResponse } from "next/server";
import { getRequiredSettings, updateSettings } from "@/lib/settings";
import { saleMonitorService, startSaleMonitor } from "@/lib/publish/saleMonitorService";
import { saleCheckMinutes, validSaleCheckMinutes, validSaleChecksPerDay } from "@/lib/publish/saleMonitorSettings";
import { saleMonitorWindowOpen } from "@/lib/publish/saleMonitorWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
  const settings = await getRequiredSettings();
  startSaleMonitor();
  return NextResponse.json({ enabled: settings.publish?.saleMonitorEnabled === true,
    windowOpen: saleMonitorWindowOpen(settings.dataRoot),
    intervalMinutes: saleCheckMinutes(settings.publish?.saleMonitorIntervalMinutes, settings.publish?.saleMonitorChecksPerDay),
    checksPerDay: validSaleChecksPerDay(settings.publish?.saleMonitorChecksPerDay) ? settings.publish.saleMonitorChecksPerDay : null,
    ...saleMonitorService().monitor.snapshot() });
  } catch { return NextResponse.json({error:'Saved monitoring settings could not be read. Refresh before changing monitoring.'},{status:503}); }
}

export async function POST(request: NextRequest) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid monitor request." }, { status: 400 }); }
  try {
  if (body && typeof body === "object" && ("intervalMinutes" in body || "checksPerDay" in body)) {
    if ("intervalMinutes" in body && "checksPerDay" in body)
      return NextResponse.json({ ok: false, error: "Choose minutes or checks per day, not both." }, { status: 400 });
    const daily = "checksPerDay" in body;
    if (daily ? !validSaleChecksPerDay(body.checksPerDay) : !validSaleCheckMinutes(body.intervalMinutes))
      return NextResponse.json({ ok: false, error: daily ? "Choose a whole number of checks per day from 1 to 720." : "Choose a whole number of minutes from 2 to 1440." }, { status: 400 });
    await updateSettings(settings => ({ publish: { ...settings.publish, ...(daily
      ? { saleMonitorChecksPerDay: body.checksPerDay }
      : { saleMonitorIntervalMinutes: body.intervalMinutes, saleMonitorChecksPerDay: null }) } }));
    await saleMonitorService().monitor.reschedule();
    startSaleMonitor();
    return NextResponse.json({ ok: true, intervalMinutes: saleCheckMinutes(body.intervalMinutes, daily ? body.checksPerDay : null),
      checksPerDay: daily ? body.checksPerDay : null });
  }
  if (typeof body?.enabled === "boolean") {
    await updateSettings(settings => ({ publish: { ...settings.publish, saleMonitorEnabled: body.enabled } }));
    startSaleMonitor();
    if (body.enabled) void saleMonitorService().monitor.tick(true);
    return NextResponse.json({ ok: true, enabled: body.enabled });
  }
  if (body?.action === "check") {
    if (!(await getRequiredSettings()).publish?.saleMonitorEnabled) return NextResponse.json({ ok: false, error: "Enable monitoring first." }, { status: 409 });
    startSaleMonitor();
    void saleMonitorService().monitor.tick(true);
    return NextResponse.json({ ok: true }, { status: 202 });
  }
  return NextResponse.json({ ok: false, error: "Unknown monitor action." }, { status: 400 });
  } catch { return NextResponse.json({ok:false,error:'The monitoring change could not be confirmed. Refresh the saved settings before trying again.'},{status:503}); }
}
