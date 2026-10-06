import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getSettings } from "@/lib/settings";
import { isUnderManagedRoots, contentTypeFor } from "@/lib/paths";

export const runtime = "nodejs";

// Same guard as /api/photo. Falls back to the full image if a thumb is missing.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams.get("path");
  if (!p) return new NextResponse("missing path", { status: 400 });
  const settings = await getSettings();
  if (!isUnderManagedRoots(p, settings)) {
    return new NextResponse("forbidden", { status: 403 });
  }
  const fallback = req.nextUrl.searchParams.get("full");
  const target = fs.existsSync(p) ? p : fallback && isUnderManagedRoots(fallback, settings) ? fallback : null;
  if (!target || !fs.existsSync(target)) return new NextResponse("not found", { status: 404 });
  const data = await fs.promises.readFile(target);
  return new NextResponse(new Uint8Array(data), {
    headers: { "Content-Type": contentTypeFor(target), "Cache-Control": "no-store" },
  });
}
