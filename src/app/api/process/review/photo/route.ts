import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import sharp from "sharp";
import { getSettings } from "@/lib/settings";
import { intakeReviewPhoto } from "@/lib/intakeReviewStore";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    const file = intakeReviewPhoto(await getSettings(), req.nextUrl.searchParams.get("job") ?? "", req.nextUrl.searchParams.get("photo") ?? "");
    const data = req.nextUrl.searchParams.get("full") === "1" ? await fs.promises.readFile(file)
      : await sharp(file).rotate().resize({ width: 360, height: 360, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
  } catch { return new NextResponse("Batch photo unavailable", { status: 404 }); }
}
