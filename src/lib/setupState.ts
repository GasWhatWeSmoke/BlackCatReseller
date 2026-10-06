import type { PrismaClient } from '@prisma/client';
import type { AppSettingsData } from './types.ts';
import { buildSetupSteps, setupProgress, blockingSteps, type SetupFacts } from './setupSteps.ts';

export type SetupRequest = { acknowledge: 'ebay-policy'; value: boolean } | { dismissed: boolean };
export function setupRequest(input: unknown): SetupRequest {
  const value = input as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Choose a valid setup action.');
  if (Object.keys(value).length === 1 && typeof value.dismissed === 'boolean') return { dismissed: value.dismissed };
  if (Object.keys(value).length === 2 && value.acknowledge === 'ebay-policy' && typeof value.value === 'boolean') return { acknowledge: 'ebay-policy', value: value.value };
  throw Error('Choose a valid setup action.');
}
export function setupChoicePatch(current: Pick<AppSettingsData, 'setupAcknowledged'>, request: SetupRequest): Partial<AppSettingsData> {
  if ('dismissed' in request) return { setupGuideDismissed: request.dismissed };
  const previous = current.setupAcknowledged ?? [];
  if (!Array.isArray(previous) || previous.some(value => typeof value !== 'string')) throw Error('Saved setup choices could not be read.');
  return { setupAcknowledged: request.value ? [...new Set([...previous, request.acknowledge])] : previous.filter(value => value !== request.acknowledge) };
}
export function hasLinkedSetupAccount(settings: Pick<AppSettingsData, 'publish'>, accounts: { marketplace: string; loggedIn: boolean; awaitingConfirmation: boolean; loginInProgress: boolean }[]) {
  const enabled = new Set([
    settings.publish?.ebayBrowser?.enabled ? 'ebay' : null, settings.publish?.depop?.enabled ? 'depop' : null,
    settings.publish?.poshmark?.enabled ? 'poshmark' : null, settings.publish?.etsy?.enabled ? 'etsy' : null, settings.publish?.mercari?.enabled ? 'mercari' : null,
  ].filter(Boolean));
  return accounts.some(account => enabled.has(account.marketplace) && account.loggedIn && !account.awaitingConfirmation && !account.loginInProgress);
}
export async function readSetupSnapshot(db: Pick<PrismaClient, '$transaction'>, settings: Pick<AppSettingsData, 'setupAcknowledged' | 'setupGuideDismissed'>,
  observed: Omit<SetupFacts, 'acknowledged' | 'itemCount' | 'readyCount' | 'uploadedCount'>) {
  const counts = await db.$transaction(async tx => {
    const [itemCount, readyCount, uploadedCount] = await Promise.all([tx.item.count(),
      tx.item.count({ where: { status: { in: ['Ready', 'Ready for Nifty'] } } }),
      tx.item.count({ where: { marketplaceListings: { some: { status: 'published' } } } })]);
    return { itemCount, readyCount, uploadedCount };
  });
  if (settings.setupAcknowledged !== undefined && (!Array.isArray(settings.setupAcknowledged) || settings.setupAcknowledged.some(value => typeof value !== 'string'))) throw Error('Saved setup choices could not be read.');
  const steps = buildSetupSteps({ ...observed, ...counts, acknowledged: settings.setupAcknowledged ?? [] });
  return { steps, progress: setupProgress(steps), blocking: blockingSteps(steps).map(step => step.id), dismissed: settings.setupGuideDismissed === true };
}
