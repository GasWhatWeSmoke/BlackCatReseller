import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { transferPhotos } from "@/lib/photoRecovery";
import { PhotoChangeError } from "@/lib/photoMutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => { throw new PhotoChangeError("Invalid photo repair.", 400); });
    return NextResponse.json(await transferPhotos(prisma, Number(id), body, false));
  } catch (error) {
    if (!(error instanceof PhotoChangeError)) console.error("[photo-transfer] failed:", error);
    return NextResponse.json({ ok: false, error: error instanceof PhotoChangeError ? error.message : "Photos could not be moved. Reload the current selection and try again." },
      { status: error instanceof PhotoChangeError ? error.status : 500 });
  }
}
