import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppSettingsData } from '../types.ts';
import type { CanonicalListing, MarketplaceAdapter, ValidationIssue } from './types.ts';
import { buildCanonicalListing } from './canonical.ts';
import { applicableTo, missingMarketplaceWhere } from './applicable.ts';
import { SALES_MARKETPLACES } from './salesProtocol.ts';
import { publishBlockReason } from './attempts.ts';
import { applyRelistPrice } from './relistPricing.ts';
import { describePackage } from '../packageDetails.ts';
import { parseEligibilityQuery, eligibilityQueryString } from './eligibilityView.ts';
import type { EligibilityQuery } from './uiTypes.ts';

type Validator = Pick<MarketplaceAdapter, 'id' | 'validate'>;
type PreviousListing = { marketplace: string; status: string; externalListingId: string | null; price: number | null };
export function platformPreflight(listing: CanonicalListing, previous: PreviousListing[], applicable: string[], settings: AppSettingsData, validators: Validator[]) {
  const checks: Record<string, ValidationIssue[]> = {};
  for (const marketplace of applicable) {
    const prior = previous.find(row => row.marketplace === marketplace) ?? null;
    if (prior?.status === 'published') { checks[marketplace] = []; continue; }
    const blocked = publishBlockReason(prior);
    if (blocked) { checks[marketplace] = [{ field: 'listing', message: blocked }]; continue; }
    let effective;
    try { effective = applyRelistPrice(listing, prior, settings.publish?.relistPricing); }
    catch (error) { checks[marketplace] = [{ field: 'price', message: error instanceof Error ? error.message : 'Verify the saved marketplace price before relisting.' }]; continue; }
    try {
      const validator = validators.find(adapter => adapter.id === marketplace);
      if (!validator) throw Error('Validator unavailable');
      const issues = validator.validate(effective, settings);
      if (!Array.isArray(issues) || issues.some(issue => !issue || typeof issue.field !== 'string' || typeof issue.message !== 'string')) throw Error('Incomplete validation');
      checks[marketplace] = issues;
    } catch { checks[marketplace] = [{ field: 'marketplace', message: 'Platform checks are unavailable. Refresh before starting.' }]; }
  }
  return checks;
}

/** Read-only preflight. The publishing engine still rechecks current data. */
export async function readPublishEligibility(db: Pick<PrismaClient, '$transaction'>, settings: AppSettingsData, validators: Validator[], input?: EligibilityQuery) {
  const query = parseEligibilityQuery(input ? new URLSearchParams(eligibilityQueryString(input)) : new URLSearchParams());
  const approved: Prisma.ItemWhereInput = { status: { in: ['Ready', 'Ready for Nifty'] } };
  const review: Prisma.ItemWhereInput = { status: { in: ['Photographed', 'Needs Info'] }, isShell: false, niftyStatus: { notIn: ['Draft', 'Published', 'Uploading'] } };
  const where: Prisma.ItemWhereInput = { AND: [approved, missingMarketplaceWhere(query.marketplaces),
    ...(query.q ? [{ OR: [{ sku: { contains: query.q } }, { brand: { contains: query.q } }, { itemType: { contains: query.q } }] }] : [])] };
  const { awaitingReview, items, counts, pagination } = await db.$transaction(async tx => {
    const [approvedCount, reviewCount, withListings, total] = await Promise.all([
      tx.item.count({ where: approved }), tx.item.count({ where: review }),
      tx.item.count({ where: { AND: [approved, { marketplaceListings: { some: { status: 'published' } } }] } }), tx.item.count({ where }),
    ]);
    const pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
    const [awaitingReview, items] = await Promise.all([
      tx.item.findMany({ where: review, take: 6,
        select: { id: true, sku: true, brand: true, itemType: true, status: true, _count: { select: { photos: true } } }, orderBy: [{ sku: 'asc' }, { id: 'asc' }] }),
      tx.item.findMany({ where, skip: (page - 1) * query.pageSize, take: query.pageSize, include: { photos: { orderBy: { sortOrder: 'asc' } },
        marketplaceListings: { select: { marketplace: true, status: true, externalListingId: true, price: true } } }, orderBy: [{ sku: 'asc' }, { id: 'asc' }] }),
    ]);
    return { awaitingReview, items, counts: { approved: approvedCount, awaitingReview: reviewCount, withListings }, pagination: { ...query, page, pages, total } };
  });
  return { items: items.map(item => {
    const { listing, issues } = buildCanonicalListing(item, settings);
    const applicableOn = SALES_MARKETPLACES.filter(marketplace => applicableTo(item, marketplace));
    return { id: item.id, sku: item.sku, brand: item.brand, itemType: item.itemType, size: item.size, price: item.listedPrice,
      platformPrices: settings.publish?.relistPricing === 'preserve_marketplace'
        ? Object.fromEntries(item.marketplaceListings.filter(row => row.price !== null).map(row => [row.marketplace, row.price!])) : {},
      photoCount: listing?.photos.length ?? 0, ready: !!listing, applicableOn, issues,
      packageDetails: describePackage(item),
      platformIssues: listing ? platformPreflight(listing, item.marketplaceListings, applicableOn, settings, validators) : {},
      publishedOn: item.marketplaceListings.filter(row => row.status === 'published').map(row => row.marketplace) };
  }), awaitingReview: awaitingReview.map(item => ({ id: item.id, sku: item.sku, brand: item.brand, itemType: item.itemType, status: item.status, photoCount: item._count.photos })), counts, pagination };
}
