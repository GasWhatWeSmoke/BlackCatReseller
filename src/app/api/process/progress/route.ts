import { NextResponse } from "next/server";
import { intakeProgressSnapshot } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only companion to POST /api/process. That route cannot emit a byte until the
// worker admits (a managed-vision deferral must stay a real 503), and the worker only
// admits after hashing, EXIF and decoding the whole batch — minutes of work on a big
// drop that the stream structurally cannot report. The client polls this while its POST
// is still headless so those phases show real movement instead of a frozen 1%.
export async function GET() {
  return NextResponse.json(intakeProgressSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
