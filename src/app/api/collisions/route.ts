import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { dashboardPage, readDashboardCollisions } from '@/lib/dashboardData';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  let page: number;
  try { page = dashboardPage(request.nextUrl.searchParams.get('page')); }
  catch { return NextResponse.json({ error: 'Invalid photo-group page.' }, { status: 400 }); }
  try { return NextResponse.json(await readDashboardCollisions(prisma, page)); }
  catch { return NextResponse.json({ error: 'Photo groups could not be refreshed. Your unresolved groups are still saved.' }, { status: 503 }); }
}
