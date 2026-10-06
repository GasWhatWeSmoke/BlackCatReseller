import type { PrismaClient } from '@prisma/client';
import type { AppSettingsData } from '../types.ts';
import type { MarketplaceAdapter } from './types.ts';
import { buildCanonicalListing } from './canonical.ts';
import { applyRelistPrice } from './relistPricing.ts';
import { publishBlockReason } from './attempts.ts';
import { applicableTo } from './applicable.ts';
import { AUTO_MARKETPLACES, selectAutoBatch, type AutoBatch, type AutoScanCoverage } from './autoRun.ts';

type Validator = Pick<MarketplaceAdapter, 'availability' | 'validate'>;
export interface AutoScanResult { batch: AutoBatch | null; needsAttention: number; coverage: AutoScanCoverage; cancelled?: boolean }

/** Keep only the initial IDs in memory; recheck current rows before file preflight.
 * A selected batch still goes through reservation and worker-side validation. */
export async function scanAutoRunCandidates(db: Pick<PrismaClient, 'item'>, settings: AppSettingsData, targets: string[],
  adapterFor: (marketplace: string) => Validator | undefined | null,
  options: { shouldContinue?: () => Promise<boolean>; onProgress?: (result: AutoScanResult) => void } = {}): Promise<AutoScanResult> {
  if (!targets.length || new Set(targets).size !== targets.length || targets.some(target => !AUTO_MARKETPLACES.includes(target as typeof AUTO_MARKETPLACES[number])))
    throw Error('Choose supported marketplaces before checking Auto Run items.');
  const where = { status: { in: ['Ready', 'Ready for Nifty'] }, niftyStatus: { notIn: ['Draft', 'Published', 'Uploading'] },
    OR: targets.map(marketplace => ({ ...(marketplace === 'etsy' ? { trueVintage: true } : {}),
      publishJobs: { none: { marketplace } }, marketplaceListings: { none: { marketplace, status: { notIn: ['ended', 'not_published'] } } } })) };
  const ids = await db.item.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
  let checked = 0, needsAttention = 0, batch: AutoBatch | null = null;
  const candidates: { id: number; marketplaces: string[] }[] = [];
  const result = (): AutoScanResult => ({ batch: batch ? { itemIds: [...batch.itemIds], marketplaces: [...batch.marketplaces] } : null,
    needsAttention, coverage: { checked, total: ids.length, complete: checked === ids.length } });
  options.onProgress?.(result());
  for (let offset = 0; offset < ids.length; offset += 100) {
    if (options.shouldContinue && !await options.shouldContinue()) return { ...result(), batch: null, cancelled: true };
    const page = ids.slice(offset, offset + 100);
    const rows = await db.item.findMany({ where: { ...where, id: { in: page.map(row => row.id) } },
      include: { photos: { orderBy: { sortOrder: 'asc' } }, marketplaceListings: true, publishJobs: { select: { marketplace: true } } }, orderBy: { id: 'asc' } });
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const candidate of page) {
      checked++;
      const item = byId.get(candidate.id);
      if (!item) continue; // Removed, sold, unapproved or reserved since the ID snapshot.
      const canonical = buildCanonicalListing(item, settings);
      const marketplaces = targets.filter(marketplace => {
        if (!applicableTo(item, marketplace) || item.publishJobs.some(job => job.marketplace === marketplace)) return false;
        const previous = item.marketplaceListings.find(listing => listing.marketplace === marketplace) ?? null;
        if (publishBlockReason(previous)) return false;
        const adapter = adapterFor(marketplace);
        if (!canonical.listing || !adapter?.availability(settings).configured) return false;
        try { return !adapter.validate(applyRelistPrice(canonical.listing, previous, settings.publish?.relistPricing), settings).length; }
        catch { return false; }
      });
      if (!marketplaces.length) needsAttention++;
      else {
        candidates.push({ id: item.id, marketplaces });
        batch = selectAutoBatch(candidates);
      }
      if (batch?.itemIds.length === 25) { const value = result(); options.onProgress?.(value); return value; }
    }
    options.onProgress?.(result());
    // A checked smaller batch can start without waiting for unrelated later items.
    if (batch) return result();
  }
  return result();
}
