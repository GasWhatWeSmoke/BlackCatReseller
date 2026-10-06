import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getRequiredSettings } from '@/lib/settings';
import { ADAPTERS } from '@/lib/publish/adapters/registry';
import { readPublishEligibility } from '@/lib/publish/eligibility';
import { parseEligibilityQuery } from '@/lib/publish/eligibilityView';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  let query;
  try { query = parseEligibilityQuery(request.nextUrl.searchParams); }
  catch { return NextResponse.json({ error: 'Choose a valid queue page, search and marketplace selection.' }, { status: 400 }); }
  try { return NextResponse.json(await readPublishEligibility(prisma, await getRequiredSettings(), ADAPTERS, query)); }
  catch { return NextResponse.json({ error: 'Marketplace preflight could not be refreshed. Check saved settings and try again.' }, { status: 503 }); }
}
