import type { ReviewIdentity } from './reviewQueueRead.ts';
import { reviewKey, type ReviewCheckpoint, type ReviewItem } from './reviewCheckpoint.ts';

const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identity = (row: Pick<ReviewIdentity, 'id' | 'createdAt' | 'updatedAt'>) => row && Number.isSafeInteger(row.id) && row.id > 0 && validDate(row.createdAt) && validDate(row.updatedAt);
export function reviewIndexView(value: unknown): ReviewIdentity[] {
  const body = value as { items: ReviewIdentity[]; total: number };
  if (!body || !Array.isArray(body.items) || body.total !== body.items.length
    || body.items.some(row => !identity(row) || typeof row.sku !== 'string' || typeof row.flagged !== 'boolean' || typeof row.hasAiError !== 'boolean')
    || new Set(body.items.map(row => row.id)).size !== body.items.length) throw Error('The complete review queue could not be verified. Retry loading Review.');
  return body.items;
}
type Signature = Pick<ReviewIdentity, 'id' | 'createdAt' | 'updatedAt'> & { signature: string };
export function reviewBatchView<T extends { id: number }>(value: unknown, ids: number[]): T[] {
  const body = value as { items: T[]; requestedIds: number[] };
  if (!body || !Array.isArray(body.items) || JSON.stringify(body.requestedIds) !== JSON.stringify(ids)
    || body.items.some(row => !row || !ids.includes(row.id)) || new Set(body.items.map(row => row.id)).size !== body.items.length)
    throw Error('Review details did not match the requested items. Retry loading Review.');
  return body.items;
}
async function read(view: string, signal: AbortSignal, ids?: number[]) {
  const params = new URLSearchParams({ view }); if (ids) params.set('ids', ids.join(','));
  const response = await fetch('/api/items?' + params, { signal, cache: 'no-store' });
  if (!response.ok) throw Error('Review could not load. Your drafts are safe; try again.');
  return response.json();
}
export async function fetchReviewIndex(signal: AbortSignal) { return reviewIndexView(await read('review-index', signal)); }
export async function fetchReviewSignatures(ids: number[], signal: AbortSignal) {
  const items = reviewBatchView<Signature>(await read('review-signatures', signal, ids), ids);
  if (items.some(row => !identity(row) || typeof row.signature !== 'string' || !/^[a-f0-9]{64}$/.test(row.signature)))
    throw Error('Saved review signatures could not be verified.');
  return items;
}
export async function fetchReviewDetail(expected: ReviewIdentity, signal: AbortSignal): Promise<ReviewItem> {
  const rows = reviewBatchView<ReviewItem>(await read('review-details', signal, [expected.id]), [expected.id]), item = rows[0];
  if (!item || item.createdAt !== expected.createdAt || !validDate(item.updatedAt) || !Array.isArray(item.photos)
    || !Array.isArray(item.marketplaceListings) || typeof item.sku !== 'string' || typeof item.brand !== 'string'
    || !['Photographed', 'Needs Info'].includes(item.status))
    throw Error('This item changed or is no longer waiting for review. Reload the queue; your drafts are kept.');
  return item;
}

/** Only reviewed, unchanged, draft-free items may leave individual review. All other phases remain visible. */
export async function filterReviewQueue(index: ReviewIdentity[], checkpoints: ReviewCheckpoint[], dirty: Set<string>,
  readSignatures: (ids: number[]) => Promise<Signature[]>, focus: number | null = null) {
  const byKey = new Map(checkpoints.map(row => [row.key, row]));
  const candidates = index.filter(item => { const checkpoint = byKey.get(reviewKey(item));
    return item.id !== focus && checkpoint?.phase === 'reviewed' && checkpoint.itemVersion === item.updatedAt
      && !dirty.has(`${item.id}:${item.createdAt}`); });
  const hidden = new Set<number>(); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, Math.ceil(candidates.length / 50)) }, async () => {
    while (cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + 50); cursor += 50;
      const fresh = new Map((await readSignatures(batch.map(row => row.id))).map(row => [row.id, row]));
      for (const item of batch) {
        const row = fresh.get(item.id), checkpoint = byKey.get(reviewKey(item))!;
        if (row?.createdAt === item.createdAt && row.updatedAt === item.updatedAt && row.signature === checkpoint.signature) hidden.add(item.id);
      }
    }
  }));
  return index.filter(item => !hidden.has(item.id));
}
