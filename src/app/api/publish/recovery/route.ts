import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { loadRecovery } from '@/lib/publish/recovery';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET() { return NextResponse.json(await loadRecovery(prisma)); }
