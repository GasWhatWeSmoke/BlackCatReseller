import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { readVocabulary, saveVocabularyEntry } from '@/lib/vocabularyStore';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return NextResponse.json(await readVocabulary(prisma)); }
  catch { return NextResponse.json({ error: 'Dropdown suggestions are unavailable. You can keep typing your own values.' }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  const input = await request.json().catch(() => null);
  try { return NextResponse.json(await saveVocabularyEntry(prisma, input)); }
  catch (error) {
    const invalid = error instanceof Error && error.message === 'Choose a valid suggestion field and value.';
    return NextResponse.json({ error: invalid ? error.message : 'The suggestion update could not be confirmed.' }, { status: invalid ? 400 : 503 });
  }
}
