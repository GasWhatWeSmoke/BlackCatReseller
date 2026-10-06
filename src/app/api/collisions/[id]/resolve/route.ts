import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRequiredSettings } from "@/lib/settings";
import { resolvePhotoCollision } from "@/lib/photoRecovery";
import { PhotoChangeError } from "@/lib/photoMutations";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let reserved = false;
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => { throw new PhotoChangeError("Invalid photo resolution.", 400); });
    if (!tryReserveIncomingMutation()) throw new PhotoChangeError("Photo processing is active. Wait for it to finish before resolving this group.", 409);
    reserved = true;
    return NextResponse.json(await resolvePhotoCollision(prisma, Number(id), body?.resolution, await getRequiredSettings()));
  } catch (error) {
    if (!(error instanceof PhotoChangeError)) console.error("[photo-resolution] failed:", error);
    return NextResponse.json({ ok: false, error: error instanceof PhotoChangeError ? error.message : "Photo resolution could not be confirmed. Reload the current groups before retrying." },
      { status: error instanceof PhotoChangeError ? error.status : 500 });
  } finally { if (reserved) releaseIncomingMutation(); }
}
