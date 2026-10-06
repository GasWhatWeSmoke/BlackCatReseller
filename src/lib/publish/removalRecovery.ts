import type { PrismaClient } from '@prisma/client';
import { listingIdentity } from './attempts.ts';

export interface RemovalReview {
  id: number; itemId: number; sku: string; marketplace: string; status: string;
  externalListingId: string; externalUrl: string; attemptCount: number;
  updatedAt: string; itemUpdatedAt: string;
}
export type RemovalReviewAction = 'retry_removal' | 'confirm_manual_removal';
export class RemovalReviewError extends Error {}
const reviewable = ['published', 'unknown', 'delist_pending', 'delist_unknown', 'delist_failed'];
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validRemovalReview(value: unknown): value is RemovalReview {
  const row = value as RemovalReview;
  return !!row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isSafeInteger(row.itemId) && row.itemId > 0 &&
    typeof row.sku === 'string' && !!row.sku && typeof row.marketplace === 'string' && reviewable.includes(row.status) &&
    Number.isSafeInteger(row.attemptCount) && row.attemptCount >= 0 && date(row.updatedAt) && date(row.itemUpdatedAt) &&
    typeof row.externalListingId === 'string' && !!row.externalListingId && typeof row.externalUrl === 'string' &&
    listingIdentity(row.marketplace, row.externalUrl)?.id === row.externalListingId;
}

/** Explicit operator review, never a substitute for an automatic availability receipt. */
export async function reviewRemoval(db: Pick<PrismaClient, '$transaction'>, input: {
  action: RemovalReviewAction; confirmed: boolean; listing: RemovalReview;
}) {
  if (!input || !['retry_removal', 'confirm_manual_removal'].includes(input.action) || input.confirmed !== true || !validRemovalReview(input.listing))
    throw new RemovalReviewError('Confirm the exact item and marketplace listing before resolving its removal.');
  const expected = input.listing;
  return db.$transaction(async tx => {
    const row = await tx.marketplaceListing.findUnique({ where: { id: expected.id }, include: { item: true } });
    if (!row || row.item.status !== 'Sold' || row.itemId !== expected.itemId || row.item.sku !== expected.sku ||
      row.item.updatedAt.toISOString() !== expected.itemUpdatedAt || row.updatedAt.toISOString() !== expected.updatedAt ||
      row.marketplace !== expected.marketplace || row.status !== expected.status || row.attemptCount !== expected.attemptCount ||
      row.externalListingId !== expected.externalListingId || row.externalUrl !== expected.externalUrl || !reviewable.includes(row.status))
      throw new RemovalReviewError('This item or listing changed. Refresh and review it again; nothing was changed.');
    if (input.action === 'retry_removal' && row.status !== 'delist_failed')
      throw new RemovalReviewError('Only a reviewed failed removal can receive a new retry.');
    if (await tx.publishJob.count({ where: { itemId: row.itemId, status: { in: ['queued', 'publishing', 'retrying'] } } }))
      throw new RemovalReviewError('This item has an active publishing job. Finish or cancel it before resolving removal.');
    const manual = input.action === 'confirm_manual_removal';
    const note = manual
      ? 'Owner confirmed this exact listing was manually removed or made unavailable. No automated removal verification is claimed.'
      : 'Owner reviewed the failure and requested another guarded removal pass. Availability must be verified by the worker.';
    const now = new Date();
    const changed = await tx.marketplaceListing.updateMany({ where: { id: row.id, updatedAt: row.updatedAt, status: row.status, attemptCount: row.attemptCount },
      data: manual ? { status: 'ended', endedAt: now, lastError: null }
        : { status: 'delist_pending', endedAt: null, attemptCount: 0, lastAttemptAt: null, lastError: null } });
    if (changed.count !== 1) throw new RemovalReviewError('The listing changed before saving. Refresh before another action.');
    await tx.problemLog.create({ data: { type: manual ? 'MANUAL_LISTING_REMOVAL_CONFIRMED' : 'LISTING_REMOVAL_RETRY_REVIEWED',
      sku: row.item.sku, resolved: true, message: JSON.stringify({ note, listingId: row.id, marketplace: row.marketplace,
        externalListingId: row.externalListingId, externalUrl: row.externalUrl, previousStatus: row.status,
        previousAttempts: row.attemptCount, previousError: row.lastError, reviewedAt: now.toISOString() }) } });
    return { ok: true as const, listingId: row.id, action: input.action, status: manual ? 'ended' as const : 'delist_pending' as const };
  });
}
