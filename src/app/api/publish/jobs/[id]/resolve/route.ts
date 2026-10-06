import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolvePublishAttempt } from "@/lib/publish/attempts";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = Number((await context.params).id);
  const body = await req.json().catch(() => null);
  if (!Number.isSafeInteger(id) || id <= 0 || !body || body.confirmed !== true ||
      !["published", "not_published"].includes(body.outcome) ||
      typeof body.expectedRevision !== "string" || !body.expectedRevision || body.expectedRevision.length > 5000 ||
      (body.outcome === "published" && (typeof body.url !== "string" || body.url.length > 2000))) {
    return NextResponse.json({ ok: false, error: "Confirm the marketplace check and provide its result." }, { status: 400 });
  }
  const result = await resolvePublishAttempt(prisma, id, body.outcome, body.url, body.expectedRevision);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
