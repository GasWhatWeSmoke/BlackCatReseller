import { NextRequest, NextResponse } from "next/server";
import { getRequiredSettings } from "@/lib/settings";
import { runStatus, engineActive } from "@/lib/publish/queue";
import { availableMarketplaces } from "@/lib/publish/adapters/registry";
import { browserHolder } from "@/lib/browserCoordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live publishing status (§45.15): the latest (or requested) run's per-marketplace
// tallies, the item being published right now, and every problem with its reason.
// Polling this is also what revives the engine after an app restart.
export async function GET(req: NextRequest) {
  try {
  const runId = req.nextUrl.searchParams.get("run");
  const settings = await getRequiredSettings();
  const status = await runStatus(runId ? Number(runId) : undefined);
  return NextResponse.json({
    ...status,
    engineActive: engineActive(),
    browserBusyWith: browserHolder(),
    marketplaces: availableMarketplaces(settings),
  });
  } catch { return NextResponse.json({ error: 'Crosslisting status could not be refreshed. Check saved settings and try again.' }, { status: 503 }); }
}
