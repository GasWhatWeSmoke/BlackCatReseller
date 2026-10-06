import type { PrismaClient } from '@prisma/client';
import { parseManualSale, currentManualSale, manualSalePlatform, MANUAL_SALE_FIELD } from './manualSale.ts';
import { queueSoldItemRemovals } from './publish/saleProtection.ts';
import { isBrowserMarketplace } from './publish/platforms.ts';
import { inventoryState } from './inventoryState.ts';

class SaleConflict extends Error {}
export async function recordManualSale(db: Pick<PrismaClient, '$transaction'>, id: number, input: unknown) {
  let command;
  try { command = parseManualSale(input); if (command.selection.id !== id) throw Error('The selected item does not match this sale.'); }
  catch (error) { return { status: 422, body: { error: error instanceof Error ? error.message : 'Invalid sale.' } }; }
  const encoded = JSON.stringify(command), selection = command.selection;
  try {
    return await db.$transaction(async tx => {
      const item = await tx.item.findUnique({ where: { id }, include: { marketplaceListings: true } });
      if (!item || item.createdAt.toISOString() !== selection.createdAt || item.sku !== selection.sku)
        throw new SaleConflict('The original item could not be confirmed. Reload before recording a sale.');
      const logs = await tx.syncLog.findMany({ where: { itemId: id, field: { in: [MANUAL_SALE_FIELD, 'order_review'] } }, orderBy: { id: 'desc' } });
      const existing = logs.find(row => {
        try { return row.field === MANUAL_SALE_FIELD && JSON.parse(row.newValue ?? 'null')?.operationId === command.operationId; } catch { return false; }
      });
      if (existing) {
        if (existing.newValue !== encoded) throw new SaleConflict('This sale confirmation was already used with different details. Refresh Sales.');
        // A lost reply can be reconciled without changing later corrections or re-selling a returned item.
        return { status: 200, body: { item: { ...item, displayStatus: inventoryState(item) }, manualSale: currentManualSale(item, logs),
          saleReceipt: { operationId: command.operationId, outcome: 'already_recorded', current: currentManualSale(item, logs)?.operationId === command.operationId } } };
      }
      if (item.updatedAt.toISOString() !== selection.updatedAt || item.status !== selection.status)
        throw new SaleConflict('This item changed after you opened the sale form. Reload and review it before confirming.');
      if (['Sold', 'Archived', 'Removed'].includes(item.status) || item.salePrice !== null || item.dateSold !== null || item.platformSold !== null)
        throw new SaleConflict('This item already has sale history or is archived. Review its saved state before recording a sale.');
      const now = new Date(), soldAt = new Date(command.soldAt);
      if (soldAt.getTime() > now.getTime() + 300_000 || item.relistedAt && soldAt < item.relistedAt)
        throw new SaleConflict('Use the date of this sale, after any relisting and no later than today.');
      if (item.marketplaceListings.some(row => row.status === 'sold')) throw new SaleConflict('A marketplace already recorded a sale. Refresh Sales to review it.');
      const source = isBrowserMarketplace(command.source) ? item.marketplaceListings.find(row => row.marketplace === command.source && !['ended', 'not_published'].includes(row.status)) : undefined;
      if (source ? !command.sourceListing || source.id !== command.sourceListing.id || source.updatedAt.toISOString() !== command.sourceListing.updatedAt ||
          source.externalListingId !== command.sourceListing.externalListingId || source.externalUrl !== command.sourceListing.externalUrl : command.sourceListing !== null)
        throw new SaleConflict('The marketplace listing changed. Reload the item and verify which listing sold.');
      if (source && !['published', 'unknown', 'delist_pending', 'delist_unknown', 'delist_failed'].includes(source.status))
        throw new SaleConflict('This listing has an action in progress. Wait for its result and review the sale again.');
      const platform = manualSalePlatform(command.source);
      const saved = await tx.item.updateMany({ where: { id, updatedAt: item.updatedAt }, data: {
        status: 'Sold', platformSold: platform, dateSold: soldAt, relistedAt: null,
        salePrice: command.salePriceCents / 100, marketplaceFees: command.feeCents / 100, feesEstimated: false,
        shippingCharged: command.shippingChargedCents / 100,
        shippingCost: command.shippingCostCents === null ? null : command.shippingCostCents / 100,
        shippingEstimated: command.shippingCostCents === null, earningsReady: true,
        shippedAt: command.completed ? now : null, updatedAt: new Date(Math.max(now.getTime(), item.updatedAt.getTime() + 1)),
      } });
      if (saved.count !== 1) throw new SaleConflict('This item changed during confirmation. Refresh Sales before trying again.');
      if (source) await tx.marketplaceListing.update({ where: { id: source.id }, data: { status: 'sold', endedAt: now, lastError: null } });
      const removals = await queueSoldItemRemovals(tx, id, source?.id ?? null, platform, now);
      const log = await tx.syncLog.create({ data: { itemId: id, sku: item.sku, field: MANUAL_SALE_FIELD, action: 'recorded', source: 'manual',
        oldValue: JSON.stringify({ status: item.status, updatedAt: item.updatedAt }), newValue: encoded,
        note: 'Sale and fulfillment method confirmed by the operator. Other linked listings require verified removal.' } });
      if (removals.unresolved.length) await tx.problemLog.create({ data: { type: 'DIRECT_DELIST_IDENTITY_MISSING', sku: item.sku,
        message: `Manual sale on ${platform}; ${removals.unresolved.length} listing(s) need identity verification before removal.` } });
      const after = await tx.item.findUniqueOrThrow({ where: { id }, include: { marketplaceListings: true } });
      return { status: 200, body: { item: { ...after, displayStatus: inventoryState(after) }, manualSale: currentManualSale(after, [log]),
        saleReceipt: { operationId: command.operationId, outcome: 'recorded', current: true }, ...removals } };
    });
  } catch (error) {
    if (error instanceof SaleConflict || error && typeof error === 'object' && 'code' in error && error.code === 'P2034')
      return { status: 409, body: { error: error instanceof SaleConflict ? error.message : 'The item changed during confirmation. Refresh Sales before trying again.' } };
    return { status: 500, body: { error: 'The sale result could not be confirmed. Refresh the item before another attempt.' } };
  }
}

export async function readManualSale(db: Pick<PrismaClient, 'syncLog'>, item: Parameters<typeof currentManualSale>[0]) {
  if (item.status !== 'Sold') return null;
  return currentManualSale(item, await db.syncLog.findMany({ where: { itemId: item.id, field: { in: [MANUAL_SALE_FIELD, 'order_review'] } }, orderBy: { id: 'desc' } }));
}
