import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { removalBacklog } from "@/lib/publish/saleProtection";
import { removalServiceStatus, startRemovalPass } from "@/lib/publish/removalService";
import { supportsBrowserRemoval } from "@/lib/publish/delistWorker";
import { getSettings } from "@/lib/settings";
import { saleMonitorService } from "@/lib/publish/saleMonitorService";
import { reviewRemoval, RemovalReviewError } from '@/lib/publish/removalRecovery';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const backlog = await removalBacklog(prisma);
  return NextResponse.json({
    ...removalServiceStatus(), monitoringActive: (await getSettings()).publish?.saleMonitorEnabled === true && !!saleMonitorService().timer,
    backlog: backlog.map((listing) => ({ ...listing, supported: supportsBrowserRemoval(listing.marketplace) })),
  });
}

export async function POST(request: NextRequest) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  if (body?.action === 'retry_removal' || body?.action === 'confirm_manual_removal') {
    try {
      const result = await reviewRemoval(prisma, body);
      // A saved retry remains queued even if another pass already owns the browser.
      if (body.action === 'retry_removal') startRemovalPass();
      return NextResponse.json(result);
    } catch (error) {
      return NextResponse.json({ ok: false, error: error instanceof RemovalReviewError ? error.message : 'Removal review could not be saved. Refresh before trying again.' }, { status: 409 });
    }
  }
  if (body?.action !== "process") return NextResponse.json({ ok: false, error: "Unknown removal action." }, { status: 400 });
  const started = startRemovalPass();
  return NextResponse.json({ ok: true, started }, { status: started ? 202 : 200 });
}
