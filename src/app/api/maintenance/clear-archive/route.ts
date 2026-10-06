import { NextRequest,NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getRequiredSettings } from '@/lib/settings';
import { dbAbsPath,tryReserveIncomingMutation,releaseIncomingMutation } from '@/lib/worker';
import { ArchiveCleanupError,runArchiveCleanup } from '@/lib/archiveCleanup';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function POST(request:NextRequest){
  const body=await request.json().catch(()=>null);
  try{return NextResponse.json(await runArchiveCleanup({db:prisma,settings:getRequiredSettings,reserve:tryReserveIncomingMutation,release:releaseIncomingMutation,
    context:{projectRoot:process.cwd(),databasePath:dbAbsPath()}},body));}
  catch(error){return NextResponse.json({error:error instanceof ArchiveCleanupError?error.message:'Archive cleanup could not be confirmed. Check saved settings and review the remaining files before retrying.'},
    {status:error instanceof ArchiveCleanupError?error.status:503});}
}
