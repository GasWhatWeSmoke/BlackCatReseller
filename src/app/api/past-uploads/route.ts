import { NextRequest,NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loadUploadHistory,parseHistoryQuery } from "@/lib/pastUploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request:NextRequest) {
  let query;try{query=parseHistoryQuery(request.nextUrl.searchParams);}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Invalid history filters.'},{status:400});}
  try{return NextResponse.json(await loadUploadHistory(prisma,query));}
  catch{return NextResponse.json({error:'History could not be loaded. Refresh to try again.'},{status:503});}
}
