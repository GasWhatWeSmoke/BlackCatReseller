import type { PrismaClient } from "@prisma/client";

type Store = Pick<PrismaClient, "$transaction">;

/** Caller holds the incoming-operation reservation through any item deletion
 * and this metadata transaction. Actionable work outlives its history entry. */
export async function clearBatchHistory(store: Store, batchId?: number) {
  if (batchId !== undefined && (!Number.isSafeInteger(batchId) || batchId < 1)) {
    throw new Error("Invalid batch ID");
  }
  return store.$transaction(async tx => {
    if (batchId !== undefined && !await tx.batch.findUnique({ where: { id: batchId }, select: { id: true } })) {
      return { ok: false as const, error: "Batch not found." };
    }
    const scope = batchId === undefined ? { batchId: { not: null } } : { batchId };
    const pendingGroupsKept = await tx.collision.count({ where: { ...scope, status: "pending" } });
    const openIssuesKept = await tx.problemLog.count({ where: { ...scope, resolved: false } });
    // Collision.batchId deliberately has no FK; detach it explicitly, including
    // old dangling IDs during all-history cleanup. Keep its photo references.
    await tx.collision.updateMany({ where: scope, data: { batchId: null } });
    await tx.problemLog.updateMany({ where: { ...scope, resolved: false }, data: { batchId: null } });
    await tx.problemLog.deleteMany({ where: { ...scope, resolved: true } });
    const removed = await tx.batch.deleteMany({ where: batchId === undefined ? {} : { id: batchId } });
    return { ok: true as const, batchesDeleted: removed.count, pendingGroupsKept, openIssuesKept };
  });
}
