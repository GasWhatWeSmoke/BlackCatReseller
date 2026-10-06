import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { inventoryNeighbors, parseInventoryQuery } from "@/lib/inventoryQuery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Indexed neighboring SKUs use the same filters and order as the inventory page.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cur = Number(id);
  if (!Number.isSafeInteger(cur) || cur <= 0) return NextResponse.json({ error: "Invalid item ID." }, { status: 400 });
  let query;
  try { query = parseInventoryQuery(req.nextUrl.searchParams); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid inventory filters." }, { status: 400 }); }
  try {
    const neighbors = await inventoryNeighbors(prisma, cur, query);
    return neighbors ? NextResponse.json(neighbors) : NextResponse.json({ error: "Item not found." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Previous and next items could not be loaded. Retry navigation." }, { status: 503 });
  }
}
