import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getRequiredSettings } from '@/lib/settings';
import { parseEarningsQuery,readEarningsPage } from '@/lib/earningsPage';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request) {
  let query;
  try {query=parseEarningsQuery(new URL(request.url).searchParams);}
  catch(error){return NextResponse.json({error:(error as Error).message},{status:400});}
  try {return NextResponse.json(await readEarningsPage(prisma,await getRequiredSettings(),query));}
  catch {return NextResponse.json({error:'Saved earnings information could not be read. Refresh before relying on these figures.'},{status:503});}
}
