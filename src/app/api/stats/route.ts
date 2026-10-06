import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getRequiredSettings } from '@/lib/settings';
import { readDashboardStats } from '@/lib/dashboardData';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return NextResponse.json(await readDashboardStats(prisma, await getRequiredSettings())); }
  catch { return NextResponse.json({ error: 'Dashboard totals could not be refreshed. Try again when the local data is available.' }, { status: 503 }); }
}
