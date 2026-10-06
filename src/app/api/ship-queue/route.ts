import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readShippingCount } from '@/lib/shippingStatus';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recorded Sold inventory awaiting fulfillment, for the Sales navigation badge.
export async function GET() {
  try {
    return NextResponse.json(await readShippingCount(prisma));
  } catch {
    return NextResponse.json({ error: 'The fulfillment count could not be refreshed. Try again.' }, { status: 503 });
  }
}
