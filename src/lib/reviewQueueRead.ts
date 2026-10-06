import type { PrismaClient } from '@prisma/client';
import { directUploadState, republicationBlockReason } from './publish/listingGuards.ts';
import { reviewSignature, type ReviewItem } from './reviewCheckpoint.ts';

export function reviewIds(value: string | null): number[] {
  const parts = value?.split(',') ?? [];
  if (!parts.length || parts.length > 50 || parts.some(part => !/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part))))
    throw Error('Choose at most 50 valid review items.');
  return [...new Set(parts.map(Number))];
}

export async function readReviewIndex(db: Pick<PrismaClient, 'item'>) {
  const rows = await db.item.findMany({ where: { status: { in: ['Photographed', 'Needs Info'] } },
    orderBy: [{ sku: 'asc' }, { id: 'asc' }], select: { id: true, sku: true, createdAt: true, updatedAt: true, flagged: true, aiError: true } });
  return { items: rows.map(({ aiError, ...row }) => ({ ...row, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), hasAiError: !!aiError })), total: rows.length };
}
export type ReviewIdentity = Awaited<ReturnType<typeof readReviewIndex>>['items'][number];

/** Reuse the exact content hash used by individual review; photo changes need not change Item.updatedAt. */
export async function readReviewSignatures(db: Pick<PrismaClient, '$transaction'>, ids: number[]) {
  const requestedIds = reviewIds(ids.join(','));
  const rows = await db.$transaction(tx => tx.item.findMany({ where: { id: { in: requestedIds } },
    include: { photos: { orderBy: { sortOrder: 'asc' } }, ...directUploadState } }));
  const items = await Promise.all(rows.map(async row => ({ id: row.id, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), signature: await reviewSignature(row as unknown as ReviewItem) })));
  return { items, requestedIds };
}

export async function readReviewDetails(db: Pick<PrismaClient, '$transaction'>, ids: number[]) {
  const requestedIds = reviewIds(ids.join(','));
  const rows = await db.$transaction(tx => tx.item.findMany({ where: { id: { in: requestedIds } },
    include: { photos: { orderBy: { sortOrder: 'asc' } }, ...directUploadState } }));
  return { items: rows.map(({ publishJobs, ...row }) => ({ ...row, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), republicationBlockReason: republicationBlockReason({ ...row, publishJobs }) })), requestedIds };
}
