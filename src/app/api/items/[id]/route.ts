import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { inventoryState } from "@/lib/inventoryState";
import { deleteItem } from "@/lib/itemDelete";
import { applyItemChanges } from '@/lib/itemUpdate';
import { parseItemDeleteExpectation } from '@/lib/itemDeleteSelection';
import { readManualSale } from '@/lib/manualSaleStore';
import { startRemovalPass } from '@/lib/publish/removalService';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const item = await prisma.item.findUnique({
    where: { id: Number(id) },
    include: { photos: { orderBy: { sortOrder: "asc" } }, marketplaceListings:true },
  });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ item: {...item,displayStatus:inventoryState(item)}, manualSale: await readManualSale(prisma, item) });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const result = await applyItemChanges(prisma, Number(id), body);
  if (body?.manualSale && result.status === 200) {
    // The sale and removal queue are durable even if the browser is unavailable.
    try { startRemovalPass(); } catch { /* The regular removal recovery pass will pick up the queue. */ }
  }
  return NextResponse.json(result.body, { status: result.status });
}

// Clear a single item: removes it + its photos + dedup hashes + working files (the
// /archive originals are kept). Used by the inventory page and the batch item list.
// A SOLD item is earnings history — deleting it requires ?force=1, which the UI only
// sends after a spell-it-out confirm (this is the "clear this sale on purpose" path).
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const force = req.nextUrl.searchParams.get("force") === "1";
  let expected;
  try { const body = await req.json(); expected = parseItemDeleteExpectation(body?.expected); if (expected.id !== Number(id)) throw Error(); }
  catch { return NextResponse.json({ ok: false, error: 'Reload the item and confirm deletion again.' }, { status: 400 }); }
  const r = await deleteItem(Number(id), { force, expected });
  if (!r.ok) {
    if (r.error === "SOLD_HISTORY") {
      return NextResponse.json(
        { ...r, error: "This item has SOLD — deleting it erases its sale from the earnings history forever." },
        { status: 409 },
      );
    }
    return NextResponse.json(r, { status: r.error === "not found" ? 404 : ["BAD_ID", "INVALID_CONFIRMATION"].includes(r.code ?? '') ? 400 : r.code === 'DELETE_UNCONFIRMED' ? 503 : r.code ? 409 : 500 });
  }
  return NextResponse.json(r);
}
