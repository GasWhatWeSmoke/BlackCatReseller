import { NextResponse } from "next/server";
import { cancelIntake } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cancel the running photo-intake worker. Safe mid-run: nothing is written to the DB
// until the worker finishes, and originals stay in /incoming — so a cancelled batch
// simply shows up as "pending photos" with the one-click resume on the Dashboard.
export async function POST() {
  try {
    const cancelled = await cancelIntake();
    return NextResponse.json({ ok: true, cancelled });
  } catch {
    return NextResponse.json({ ok: false, error: "CANCEL_REQUEST_FAILED" }, { status: 500 });
  }
}
