import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { dashboardPage, readDashboardProblems, dismissDashboardProblems } from '@/lib/dashboardData';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  let page: number;
  try { page = dashboardPage(request.nextUrl.searchParams.get('page')); }
  catch { return NextResponse.json({ error: 'Invalid problems page.' }, { status: 400 }); }
  try { return NextResponse.json(await readDashboardProblems(prisma, page)); }
  catch { return NextResponse.json({ error: 'Open problems could not be refreshed. Try again.' }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  try { return NextResponse.json(await dismissDashboardProblems(prisma, body)); }
  catch (error) {
    if (error instanceof Error && error.message === 'Choose a valid problem to dismiss.') return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: false, error: 'Problem dismissal could not be confirmed. Refresh the current problems before trying again.' }, { status: 503 });
  }
}
