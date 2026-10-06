import type { PrismaClient } from '@prisma/client';
import { shippingCount } from './shipQueue.ts';

/** Recorded sales awaiting shipping or pickup handover belong in this badge. */
export async function readShippingCount(db: Pick<PrismaClient, 'item'>) {
  return shippingCount({ count: await db.item.count({ where: { status: 'Sold', shippedAt: null } }) });
}
