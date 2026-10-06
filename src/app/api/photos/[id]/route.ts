import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { editPhoto, removePhoto, PhotoChangeError } from "@/lib/photoMutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function body(req: NextRequest) {
  const text = await req.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new PhotoChangeError("Invalid photo change.", 400); }
}
function failure(error: unknown) {
  if (!(error instanceof PhotoChangeError)) console.error("[photos] Photo change failed:", error);
  return NextResponse.json({ ok: false, error: error instanceof PhotoChangeError ? error.message : "The photo change could not be saved. Reload its current photos and try again." },
    { status: error instanceof PhotoChangeError ? error.status : 500 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json(await removePhoto(prisma, Number(id), await body(req), await getSettings()));
  } catch (error) { return failure(error); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json(await editPhoto(prisma, Number(id), await body(req)));
  } catch (error) { return failure(error); }
}
