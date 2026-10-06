import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { comparableInput } from "@/lib/priceResearch";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const brand = (request.nextUrl.searchParams.get("brand") ?? item.brand).trim().slice(0, 100);
  const itemType = (request.nextUrl.searchParams.get("itemType") ?? item.itemType ?? "").trim().slice(0, 100);
  const [market, past] = await Promise.all([
    prisma.marketItem.findUnique({ where: { key: `review-item:${id}` }, include: { observations: { orderBy: { observedAt: "desc" }, take: 20 } } }),
    brand && !["unknown", "unbranded"].includes(brand.toLowerCase()) && itemType ? prisma.item.findMany({
      where: { id: { not: id }, status: "Sold", brand, itemType, salePrice: { not: null } },
      orderBy: { dateSold: "desc" }, take: 8, select: { id: true, sku: true, brand: true, itemType: true, size: true, salePrice: true, dateSold: true, platformSold: true },
    }) : Promise.resolve([]),
  ]);
  return NextResponse.json({ past, comparables: (market?.observations ?? []).map(row => {
    let interest = null, interestKind = null;
    try { const raw = JSON.parse(row.rawJson ?? "{}"); interest = raw.interest ?? null; interestKind = raw.interestKind ?? null; } catch { /* Unknown stays unknown. */ }
    return { id: row.id, title: row.title, url: row.url, kind: row.kind, price: row.price, observedAt: row.observedAt, interest, interestKind };
  }) });
}
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  let input;
  try { input = comparableInput(await request.json()); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  await prisma.$transaction(async tx => {
    const market = await tx.marketItem.upsert({ where: { key: `review-item:${id}` },
      create: { key: `review-item:${id}`, label: `Inventory ${item.sku}`, brand: item.brand, itemType: item.itemType, isTracked: false }, update: {} });
    const data = { marketItemId: market.id, provider: `review:${input.marketplace}`, kind: input.kind, title: input.title,
      url: input.url, price: input.price, currency: "USD", sourceNote: "Listing details confirmed by the operator", rawJson: JSON.stringify({ interest: input.interest, interestKind: input.interestKind }), observedAt: new Date() };
    await tx.marketObservation.upsert({ where: { dedupKey: `review:${id}:${input.marketplace}:${input.listingId}` }, create: { ...data, dedupKey: `review:${id}:${input.marketplace}:${input.listingId}` }, update: data });
  });
  return NextResponse.json({ ok: true });
}
