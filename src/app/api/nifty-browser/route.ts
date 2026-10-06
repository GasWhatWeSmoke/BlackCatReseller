import { NextResponse } from "next/server";
import { browserHolder, browserNote } from "@/lib/browserCoordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What the shared Nifty browser is doing right now, for the Ready page to show while a
// run is in flight — above all the worker's "waiting for you" note when a security check
// is showing in the Nifty window. The worker never solves or bypasses a check; a person
// completes it in the window, and this is how they find out it is waiting.
export async function GET() {
  const holder = browserHolder();
  return NextResponse.json({ busy: holder != null, holder, note: browserNote() });
}
