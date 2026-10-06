import { NextRequest,NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { applyBrandCleanup,BrandCleanupInputError,previewBrandCleanup } from '@/lib/brandCleanup';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:NextRequest){
  try{return NextResponse.json(await previewBrandCleanup(prisma,Number(request.nextUrl.searchParams.get('page')||1),Number(request.nextUrl.searchParams.get('suggestionPage')||1)));}
  catch(error){return NextResponse.json({error:error instanceof BrandCleanupInputError?error.message:'Brand spellings could not be loaded. Check again before applying changes.'},{status:error instanceof BrandCleanupInputError?400:503});}
}
export async function POST(request:NextRequest){
  const body=await request.json().catch(()=>null);
  try{return NextResponse.json(await applyBrandCleanup(prisma,body?.changes));}
  catch(error){return NextResponse.json({error:error instanceof BrandCleanupInputError?error.message:'The cleanup could not be confirmed. Check a fresh preview before trying again.'},{status:error instanceof BrandCleanupInputError?400:503});}
}
