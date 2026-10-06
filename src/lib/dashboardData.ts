import fs from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import type { AppSettingsData } from './types.ts';
import { activeProblemsWhere, problemMeta } from './problemMeta.ts';
import { dashboardSales, recordedStockValue } from './dashboardSales.ts';
import { readAutoRun } from './publish/autoRun.ts';
import { readyMarketplaceCandidatesWhere } from './publish/applicable.ts';

type Store = Pick<PrismaClient, '$transaction'>;
export function dashboardPage(value: string | null) {
  if (value === null) return 1;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('Invalid page.');
  return Number(value);
}
function pagination(total: number, requested: number, pageSize: number) {
  if (!Number.isSafeInteger(requested) || requested < 1) throw Error('Invalid page.');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return { total, page: Math.min(requested, pages), pages, pageSize };
}
export async function readDashboardStats(db: Store, settings: Pick<AppSettingsData, 'incomingPath' | 'publish'>) {
  // A missing/unreadable folder is unknown, not an empty intake queue.
  let incomingCount: number | null = null;
  try { incomingCount = (await fs.readdir(settings.incomingPath, { withFileTypes: true })).filter(entry => entry.isFile() && /\.jpe?g$/i.test(entry.name)).length; }
  catch { /* Other inventory totals remain available. */ }
  const platforms = readAutoRun(settings.publish?.autoRun).marketplaces;
  const activeStock = { status: { notIn: ['Sold', 'Archived', 'Removed'] } };
  const validMoney = { gte: 0, lte: Number.MAX_SAFE_INTEGER / 100 };
  const result = await db.$transaction(async tx => {
    const [byStatus, problemsOpen, collisionsOpen, readyCount, listedCount, soldItems, stockCost, stockAsking] = await Promise.all([
      tx.item.groupBy({ by: ['status'], _count: { _all: true } }),
      tx.problemLog.count({ where: activeProblemsWhere }), tx.collision.count({ where: { status: 'pending' } }),
      tx.item.count({ where: readyMarketplaceCandidatesWhere(platforms) }),
      tx.item.count({ where: { status: { notIn: ['Sold', 'Archived', 'Removed'] }, marketplaceListings: { some: { status: 'published' } } } }),
      tx.item.findMany({ where: { status: 'Sold' }, select: { salePrice: true, shippingCharged: true } }),
      tx.item.aggregate({ where: { ...activeStock, itemCost: validMoney }, _count: { _all: true }, _sum: { itemCost: true } }),
      tx.item.aggregate({ where: { ...activeStock, listedPrice: validMoney }, _count: { _all: true }, _sum: { listedPrice: true } }),
    ]);
    const statusCounts = Object.fromEntries(byStatus.map(row => [row.status, row._count._all]));
    const activeItems = byStatus.filter(row => !activeStock.status.notIn.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
    return { statusCounts, problemsOpen, collisionsOpen, readyCount, listedCount, draftCount: 0,
      soldCount: statusCounts.Sold ?? 0, lifetimeSales: dashboardSales(soldItems), needsInfo: statusCounts['Needs Info'] ?? 0,
      totalItems: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
      stockValue: { activeItems, cost: recordedStockValue(activeItems, stockCost._count._all, stockCost._sum.itemCost),
        asking: recordedStockValue(activeItems, stockAsking._count._all, stockAsking._sum.listedPrice) } };
  });
  return { ...result, incomingCount, incomingError: incomingCount === null ? 'Pending photos could not be counted. Check the saved Incoming folder and refresh.' : null };
}
export async function readDashboardCollisions(db: Store, requested = 1) {
  return db.$transaction(async tx => {
    const meta = pagination(await tx.collision.count({ where: { status: 'pending' } }), requested, 25);
    const rows = await tx.collision.findMany({ where: { status: 'pending' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (meta.page - 1) * meta.pageSize, take: meta.pageSize,
      select: { id: true, sku: true, existingItemId: true, incomingPhotosJson: true } });
    const collisions = rows.map(({ incomingPhotosJson, ...row }) => {
      try {
        const photos: unknown = JSON.parse(incomingPhotosJson);
        if (!Array.isArray(photos) || photos.length === 0 || photos.some(photo => !photo || typeof photo.storedPath !== 'string' || !photo.storedPath.trim())) throw Error('Invalid photo group');
        return { ...row, photoCount: photos.length, error: null };
      } catch { return { ...row, photoCount: null, error: 'Photo details could not be read. This group is kept; resolve its saved photo data before applying a change.' }; }
    });
    return { ...meta, collisions };
  });
}
export async function readDashboardProblems(db: Store, requested = 1) {
  return db.$transaction(async tx => {
    const groups = await tx.problemLog.groupBy({ by: ['type'], where: activeProblemsWhere, _count: { _all: true } });
    const meta = pagination(groups.reduce((sum, row) => sum + row._count._all, 0), requested, 50);
    const problems: { id: number; type: string; sku: string | null; message: string | null; createdAt: Date }[] = [];
    let skip = (meta.page - 1) * meta.pageSize;
    // Page across severity tiers, so a large warning backlog cannot bury failures.
    for (const severity of ['critical', 'warning', 'info'] as const) {
      const matching = groups.filter(row => problemMeta(row.type).severity === severity);
      const count = matching.reduce((sum, row) => sum + row._count._all, 0);
      if (skip >= count) { skip -= count; continue; }
      problems.push(...await tx.problemLog.findMany({ where: { resolved: false, type: { in: matching.map(row => row.type) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: meta.pageSize - problems.length,
        select: { id: true, type: true, sku: true, message: true, createdAt: true } }));
      skip = 0;
      if (problems.length === meta.pageSize) break;
    }
    return { ...meta, problems };
  });
}
export async function dismissDashboardProblems(db: Store, input: unknown) {
  const body = input as { all?: unknown; id?: unknown } | null;
  const all = body?.all === true;
  if (!body || (all && body.id !== undefined) || (!all && (body.all !== undefined || !Number.isSafeInteger(body.id) || Number(body.id) < 1))) throw Error('Choose a valid problem to dismiss.');
  const requestedId = all ? null : Number(body.id);
  const result = await db.$transaction(tx => tx.problemLog.updateMany({ where: { ...activeProblemsWhere, ...(requestedId === null ? {} : { id: requestedId }) }, data: { resolved: true } }));
  return { ok: true as const, requestedId, scope: all ? 'all' : 'single', resolved: result.count };
}
