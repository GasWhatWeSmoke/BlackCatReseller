import type { readDashboardStats } from './dashboardData.ts';
type CurrentDashboardStats = Awaited<ReturnType<typeof readDashboardStats>>;
export type DashboardStats = Omit<CurrentDashboardStats, 'stockValue'> & { stockValue?: CurrentDashboardStats['stockValue'] };
export interface DashboardCollision { id: number; sku: string; existingItemId: number | null; photoCount: number | null; error: string | null }
export interface DashboardProblem { id: number; type: string; sku: string | null; message: string | null; createdAt: string }
export interface DashboardPage { total: number; page: number; pages: number; pageSize: number }
export type CollisionPage = DashboardPage & { collisions: DashboardCollision[] };
export type ProblemPage = DashboardPage & { problems: DashboardProblem[] };
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (value: unknown) => count(value) && Number(value) > 0;
const nullableString = (value: unknown) => value === null || typeof value === 'string';
export function dashboardStatsView(value: unknown): DashboardStats {
  const data = value as DashboardStats;
  if (!data || !data.statusCounts || typeof data.statusCounts !== 'object' || Array.isArray(data.statusCounts) || !Object.values(data.statusCounts).every(count)
    || ![data.problemsOpen, data.collisionsOpen, data.readyCount, data.listedCount, data.draftCount, data.soldCount, data.needsInfo, data.totalItems].every(count)
    || !(data.incomingCount === null || count(data.incomingCount)) || !nullableString(data.incomingError)
    || (data.incomingCount === null) !== (typeof data.incomingError === 'string')
    || !data.lifetimeSales || ![data.lifetimeSales.itemSales, data.lifetimeSales.shippingReceived, data.lifetimeSales.totalEarned].every(Number.isFinite)
    || ![data.lifetimeSales.itemsSold, data.lifetimeSales.missingSalePrices, data.lifetimeSales.missingShipping].every(count)
    || data.lifetimeSales.missingSalePrices > data.lifetimeSales.itemsSold || data.lifetimeSales.missingShipping > data.lifetimeSales.itemsSold
    || Object.values(data.statusCounts).reduce((sum, count) => sum + count, 0) !== data.totalItems) throw Error('Dashboard totals are incomplete. Refresh to try again.');
  if (data.stockValue !== undefined) {
    const value = data.stockValue;
    const activeItems = Object.entries(data.statusCounts).filter(([status]) => !['Sold','Archived','Removed'].includes(status)).reduce((sum,[,count])=>sum+count,0);
    if (!value || value.activeItems !== activeItems || [value.cost,value.asking].some(part => !part ||
        ![part.recorded,part.missing].every(count) || part.recorded + part.missing !== activeItems ||
        (part.knownTotal === null) !== (part.recorded === 0 && activeItems > 0) ||
        part.knownTotal !== null && (typeof part.knownTotal !== 'number' || !Number.isFinite(part.knownTotal) || part.knownTotal < 0 || part.recorded === 0 && part.knownTotal !== 0)))
      throw Error('Stock values are incomplete. Refresh to try again.');
  }
  return data;
}
function pageView(data: DashboardPage, rows: unknown[], size: number) {
  return data && count(data.total) && id(data.page) && id(data.pages) && data.pageSize === size && data.pages === Math.max(1, Math.ceil(data.total / size)) && data.page <= data.pages
    && Array.isArray(rows) && rows.length === Math.min(size, Math.max(0, data.total - (data.page - 1) * size));
}
export function collisionPageView(value: unknown): CollisionPage {
  const data = value as CollisionPage;
  if (!data || !pageView(data, data.collisions, 25) || data.collisions.some(row => !row || !id(row.id) || typeof row.sku !== 'string' || !(row.existingItemId === null || id(row.existingItemId))
    || !(row.error === null ? id(row.photoCount) : typeof row.error === 'string' && row.photoCount === null)) || new Set(data.collisions.map(row => row.id)).size !== data.collisions.length) throw Error('Photo groups are incomplete. Refresh to try again.');
  return data;
}
export function problemPageView(value: unknown): ProblemPage {
  const data = value as ProblemPage;
  if (!data || !pageView(data, data.problems, 50) || data.problems.some(row => !row || !id(row.id) || typeof row.type !== 'string' || !nullableString(row.sku) || !nullableString(row.message) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(data.problems.map(row => row.id)).size !== data.problems.length) throw Error('Open problems are incomplete. Refresh to try again.');
  return data;
}
export function dismissalResult(value: unknown, requestedId: number | null) {
  const data = value as { ok: boolean; requestedId: number | null; scope: string; resolved: number };
  if (!data || data.ok !== true || data.requestedId !== requestedId || data.scope !== (requestedId === null ? 'all' : 'single') || !count(data.resolved) || (requestedId !== null && data.resolved > 1)) throw Error('Problem dismissal could not be confirmed. Refresh the current problems before trying again.');
  return data;
}
