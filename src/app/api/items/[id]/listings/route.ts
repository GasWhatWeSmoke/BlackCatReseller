import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: 'Invalid item.' }, { status: 400 });
  const item = await prisma.item.findUnique({ where: { id }, select: {
    id: true, sku: true, updatedAt: true,
    marketplaceListings: { select: { id: true, itemId: true, marketplace: true, status: true,
      externalListingId: true, externalUrl: true, attemptCount: true, updatedAt: true } },
    publishJobs: { where: { status: { in: ['queued', 'publishing', 'retrying'] } }, select: { id: true } },
  } });
  if (!item) return NextResponse.json({ error: 'Item not found.' }, { status: 404 });
  return NextResponse.json({ itemId: item.id, busy: item.publishJobs.length > 0,
    listings: item.marketplaceListings.map(row => ({ ...row, sku: item.sku, itemUpdatedAt: item.updatedAt })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
