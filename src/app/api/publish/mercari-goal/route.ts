import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSettings, updateSettings } from "@/lib/settings";
import { mercariGoal, validateMercariGoalPatch } from "@/lib/publish/mercariGoal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function soldItems() {
  return prisma.item.findMany({ where: { status: "Sold" }, orderBy: { sku: "asc" },
    select: { id: true, sku: true, status: true, niftyStatus: true, platformSold: true,
      marketplaceListings: { select: { marketplace: true, status: true } } } });
}

export async function GET() {
  const [settings, items] = await Promise.all([getSettings(), soldItems()]);
  return NextResponse.json(mercariGoal(settings.publish?.mercariListingLimit, items));
}

export async function PATCH(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const [settings, items] = await Promise.all([getSettings(), soldItems()]);
  let limit;
  try { limit = validateMercariGoalPatch(body, items); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
  await updateSettings(current => ({ publish: { ...current.publish, mercariListingLimit: limit } }));
  return NextResponse.json(mercariGoal(limit, items));
}
