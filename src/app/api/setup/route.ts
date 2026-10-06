import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { getRequiredSettings, updateSettings } from '@/lib/settings';
import { setupWorkerReadiness } from '@/lib/workerRuntime';
import { managedVisionStatus } from '@/lib/visionServer';
import { browserAccountStatus } from '@/lib/publish/browserAccounts';
import { hasLinkedSetupAccount, readSetupSnapshot, setupRequest, setupChoicePatch } from '@/lib/setupState';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function exists(file: string, directory: boolean) {
  try { const stat = fs.statSync(file); return directory ? stat.isDirectory() : stat.isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function secondaryDisplay(dataRoot: string) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataRoot, 'crawler-display.json'), 'utf8'));
    if (typeof value?.secondary !== 'boolean') throw Error('Display report is incomplete.');
    return value.secondary;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function GET() {
  try {
    const settings = await getRequiredSettings();
    const [worker, vision] = await Promise.all([setupWorkerReadiness(settings), managedVisionStatus(!!settings.visionEnabled)]);
    const accounts = (['ebay', 'depop', 'poshmark', 'etsy', 'mercari'] as const).map(marketplace => browserAccountStatus(settings, marketplace));
    return NextResponse.json(await readSetupSnapshot(prisma, settings, {
      incomingPathSet: !!settings.incomingPath, incomingPathExists: !!settings.incomingPath && exists(settings.incomingPath, true), incomingPath: settings.incomingPath,
      workerInstalled: worker.ready, hasMarketplaceAccount: hasLinkedSetupAccount(settings, accounts),
      hasSecondaryDisplay: secondaryDisplay(settings.dataRoot), visionEnabled: !!settings.visionEnabled,
      visionInstalled: settings.visionEnabled ? vision.serverReady : vision.runtimeAvailable && vision.modelAvailable,
    }));
  } catch { return NextResponse.json({ error: 'Setup information could not be refreshed. Check the saved settings and local files, then re-check.' }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  let choice;
  try { choice = setupRequest(await request.json()); }
  catch { return NextResponse.json({ error: 'Choose a valid setup action.' }, { status: 400 }); }
  try {
    await updateSettings(current => setupChoicePatch(current, choice));
    return NextResponse.json({ ok: true, request: choice });
  } catch { return NextResponse.json({ error: 'Your setup choice could not be confirmed. Re-check the saved state before trying again.' }, { status: 503 }); }
}
