import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { clearBatchHistory } from "@/lib/batchHistory";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const batches = await prisma.batch.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
      include: {
        problemLogs: true,
        items: {
          orderBy: { sku: "asc" },
          select: {
            id: true, sku: true, brand: true, itemType: true, color: true,
            status: true, photoCount: true,
            photos: {
              where: { isMarker: false },
              orderBy: [{ isCover: "desc" }, { sortOrder: "asc" }],
              take: 1,
              select: { thumbPath: true, storedPath: true },
            },
          },
        },
      },
    });
    return NextResponse.json({ batches });
  } catch {
    return NextResponse.json({ error: 'Batch history could not be loaded. Try again.' }, { status: 503 });
  }
}

// Clear history while retaining unresolved work and all inventory/photos.
export async function DELETE() {
  if (!tryReserveIncomingMutation()) return NextResponse.json({ ok: false,
    error: "Photo operations are active. Wait for them to finish before clearing batch history." }, { status: 409 });
  try { return NextResponse.json(await clearBatchHistory(prisma)); }
  catch { return NextResponse.json({ ok: false, error: "Batch history could not be cleared. No history changes were saved." }, { status: 500 }); }
  finally { releaseIncomingMutation(); }
}
