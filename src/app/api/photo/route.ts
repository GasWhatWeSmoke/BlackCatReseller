import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getSettings } from "@/lib/settings";
import { isUnderManagedRoots, contentTypeFor } from "@/lib/paths";

export const runtime = "nodejs";

// Streams an image from the managed media roots only (no path traversal).
// Shared by /api/photo and /api/thumb (a thumb path lives under /processing too).
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams.get("path");
  if (!p) return new NextResponse("missing path", { status: 400 });
  const settings = await getSettings();
  if (!isUnderManagedRoots(p, settings) || !fs.existsSync(p)) {
    return new NextResponse("forbidden", { status: 403 });
  }
  const data = await fs.promises.readFile(p);
  return new NextResponse(new Uint8Array(data), {
    headers: { "Content-Type": contentTypeFor(p), "Cache-Control": "no-store" },
  });
}
