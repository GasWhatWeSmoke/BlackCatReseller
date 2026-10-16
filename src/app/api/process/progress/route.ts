import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { intakeJobSnapshot } from "@/lib/intakeJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(intakeJobSnapshot(await getSettings()), {
    headers: { "Cache-Control": "no-store" },
  });
}
