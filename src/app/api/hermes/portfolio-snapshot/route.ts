import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSettingsWithHealth } from '@/lib/settings';
import { readPortfolioSnapshot, unavailablePortfolioSnapshot } from '@/lib/portfolioSnapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Existing read-only, path-free aggregate snapshot; local helpers own the query logic.
export async function GET() {
  try {
    return NextResponse.json(await readPortfolioSnapshot(prisma, await getSettingsWithHealth()));
  } catch (error) {
    console.error('[hermes/portfolio-snapshot] snapshot unavailable', error);
    return NextResponse.json(unavailablePortfolioSnapshot(), { status: 503 });
  }
}