import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import { prisma } from "@/lib/db";
import { saleMonitorService } from "@/lib/publish/saleMonitorService";
import { removalBacklog } from "@/lib/publish/saleProtection";
import { syncAll } from "@/lib/syncAll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const syncKey = Symbol.for("blackcat.manualSync");
const shared = globalThis as unknown as Record<symbol, Promise<Awaited<ReturnType<typeof syncAll>>> | undefined>;

// Sync only the connected marketplaces and finish confirmed-sale removals.
export async function POST(_request: NextRequest) {
  if (!shared[syncKey]) shared[syncKey] = syncAll({
    scan: () => saleMonitorService().monitor.checkNow(),
    backlog: async () => (await removalBacklog(prisma)).length,
    saveSummary: async (at, summary) => { await saveSettings({ lastSyncAt: at, lastSyncSummary: summary }); },
  }).finally(() => { delete shared[syncKey]; });
  const result = await shared[syncKey];
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

// Lightweight status for the UI (last sync time + summary), no Nifty call.
export async function GET() {
  const s = await getSettings();
  return NextResponse.json({ lastSyncAt: s.lastSyncAt ?? null, lastSyncSummary: s.lastSyncSummary ?? null,
    marketplaces: saleMonitorService().monitor.snapshot(), monitoringEnabled: s.publish?.saleMonitorEnabled === true });
}
