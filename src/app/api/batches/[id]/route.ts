import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deleteItem } from "@/lib/itemDelete";
import { itemDeleteExpectation } from '@/lib/itemDeleteSelection';
import { clearBatchHistory } from "@/lib/batchHistory";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rename a batch (set its user-friendly label).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : null;
  const batch = await prisma.batch.update({
    where: { id: Number(id) },
    data: { name: name || null },
  });
  return NextResponse.json({ ok: true, batch });
}

// Delete a batch. With ?items=1 it also clears the items that batch created (an
// "undo import"); unresolved photo groups/issues remain available independently.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bid = Number(id);
  if (!Number.isSafeInteger(bid) || bid < 1) return NextResponse.json({ ok: false, error: "Invalid batch ID." }, { status: 400 });
  const withItems = req.nextUrl.searchParams.get("items") === "1";
  if (!tryReserveIncomingMutation()) return NextResponse.json({ ok: false,
    error: "Photo operations are active. Wait for them to finish before clearing batch history." }, { status: 409 });

  let itemsDeleted = 0;
  let soldKept = 0;
  const failed: { id: number; error?: string }[] = [];
  const cleanupWarnings: { id: number; warnings: string[] }[] = [];
  try {
    if (!await prisma.batch.findUnique({ where: { id: bid }, select: { id: true } })) {
      return NextResponse.json({ ok: false, error: "Batch not found." }, { status: 404 });
    }
    if (withItems) {
      const items = await prisma.item.findMany({ where: { batchId: bid }, select: { id: true, sku: true, createdAt: true, updatedAt: true } });
      for (const it of items) {
        // Never force here: a batch clear must not erase earnings history. Sold
        // items survive; their batchId detaches when the history row goes.
        const r = await deleteItem(it.id, { expected: itemDeleteExpectation(it) });
        if (r.ok) {
          itemsDeleted++;
          if (r.cleanupWarnings?.length) cleanupWarnings.push({ id: it.id, warnings: r.cleanupWarnings });
        }
        else if (r.error === "SOLD_HISTORY") soldKept++;
        else failed.push({ id: it.id, error: r.error });
      }
    }
    const history = await clearBatchHistory(prisma, bid);
    if (!history.ok) return NextResponse.json({ ...history, itemsDeleted, soldKept, failed, cleanupWarnings }, { status: 404 });
    console.log(`[batch-delete] removed batch #${bid}` + (withItems ? ` + ${itemsDeleted} item(s), ${soldKept} sold kept` : " (history only)"));
    return NextResponse.json({ ...history, itemsDeleted, soldKept, failed, cleanupWarnings });
  } catch {
    return NextResponse.json({ ok: false, historyCleared: false, itemsDeleted, soldKept, failed, cleanupWarnings,
      error: "Batch history could not be cleared. Any completed item deletions are reported separately." }, { status: 500 });
  } finally { releaseIncomingMutation(); }
}
