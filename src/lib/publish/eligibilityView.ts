import type { EligibleItem, EligibilityPage, EligibilityQuery } from './uiTypes.ts';
import type { AutoRunConfig, AutoScanCoverage } from './autoRun.ts';
import { AUTO_MARKETPLACES } from './autoRun.ts';
export interface QueueAutoState { config: AutoRunConfig; state: string; needsAttention: number; error: string | null; runId: number | null; attentionCoverage?: AutoScanCoverage | null }
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown) => value === null || typeof value === 'string';
const issues = (value: unknown) => Array.isArray(value) && value.every(issue => issue && typeof issue.field === 'string' && typeof issue.message === 'string');
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');
export function parseEligibilityQuery(params: URLSearchParams): EligibilityQuery {
  const rawPage = params.get('page') ?? '1', rawSize = params.get('pageSize') ?? '100';
  const q = (params.get('q') ?? '').trim();
  const marketplaces = params.has('marketplaces') ? (params.get('marketplaces') || '').split(',').filter(Boolean) : [...AUTO_MARKETPLACES];
  if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)) || Number(rawPage) < 1 || Number(rawPage) > 1_000_000 ||
    !['25', '50', '100'].includes(rawSize) || q.length > 200 || marketplaces.some(name => !AUTO_MARKETPLACES.includes(name as typeof AUTO_MARKETPLACES[number])))
    throw Error('Choose a valid queue page, search and marketplace selection.');
  return { page: Number(rawPage), pageSize: Number(rawSize), q, marketplaces: [...new Set(marketplaces)].sort() };
}
export function eligibilityQueryString(query: EligibilityQuery) {
  return new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize), q: query.q, marketplaces: query.marketplaces.join(',') }).toString();
}

export function eligibilityView(input: unknown): EligibilityPage {
  const data = input as EligibilityPage;
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.awaitingReview)
    || data.items.some(row => !row || !count(row.id) || row.id < 1 || typeof row.sku !== 'string' || typeof row.brand !== 'string'
      || !text(row.itemType) || !text(row.size) || typeof row.ready !== 'boolean' || !count(row.photoCount) || !(row.price === null || typeof row.price === 'number' && Number.isFinite(row.price))
      || !issues(row.issues) || !strings(row.publishedOn) || !strings(row.applicableOn) || !row.platformIssues || typeof row.platformIssues !== 'object' || Array.isArray(row.platformIssues)
      || Object.values(row.platformIssues).some(value => !issues(value))
      || row.ready && row.applicableOn.some(marketplace => !row.publishedOn.includes(marketplace) && !Object.hasOwn(row.platformIssues, marketplace))
      || row.platformPrices && (typeof row.platformPrices !== 'object' || Array.isArray(row.platformPrices) || Object.values(row.platformPrices).some(price => typeof price !== 'number' || !Number.isFinite(price))))
    || data.awaitingReview.some(row => !row || !count(row.id) || row.id < 1 || typeof row.sku !== 'string' || !text(row.brand) || !text(row.itemType) || typeof row.status !== 'string' || !count(row.photoCount))
    || new Set([...data.items, ...data.awaitingReview].map(row => row.id)).size !== data.items.length + data.awaitingReview.length)
    throw Error('Marketplace preflight returned incomplete information. Refresh before starting a batch.');
  const page = data.pagination, totals = data.counts;
  if (!page || !totals || ![totals.approved, totals.awaitingReview, totals.withListings, page.total, page.page, page.pages, page.pageSize].every(count) ||
    ![25, 50, 100].includes(page.pageSize) || page.page < 1 || page.pages !== Math.max(1, Math.ceil(page.total / page.pageSize)) || page.page > page.pages ||
    typeof page.q !== 'string' || page.q.length > 200 || !strings(page.marketplaces) || new Set(page.marketplaces).size !== page.marketplaces.length ||
    page.marketplaces.some(name => !AUTO_MARKETPLACES.includes(name as typeof AUTO_MARKETPLACES[number])) ||
    data.items.length !== Math.min(page.pageSize, page.total - (page.page - 1) * page.pageSize) ||
    data.awaitingReview.length !== Math.min(6, totals.awaitingReview) || totals.approved < page.total || totals.withListings > totals.approved)
    throw Error('Queue totals or page details could not be confirmed. Refresh before selecting items.');
  return data;
}
export function selectedPlatformWarnings(item: EligibleItem, selected: { id: string; name: string }[]) {
  if (!item.ready) return [];
  return selected.filter(platform => item.applicableOn?.includes(platform.id) && !item.publishedOn.includes(platform.id))
    .flatMap(platform => (item.platformIssues[platform.id] ?? []).map(issue => ({ marketplace: platform.id, name: platform.name, ...issue })));
}
export function queueAutoState(input: unknown): QueueAutoState {
  const data = input as QueueAutoState;
  if (!data || typeof data.config?.enabled !== 'boolean' || !strings(data.config.marketplaces) || typeof data.state !== 'string'
    || !count(data.needsAttention) || !(data.error === null || typeof data.error === 'string') || !(data.runId === null || count(data.runId)))
    throw Error('Could not verify Auto Run settings. Refresh the queue.');
  const coverage = data.attentionCoverage;
  if (coverage !== undefined && coverage !== null && (!count(coverage.checked) || !count(coverage.total) || coverage.checked > coverage.total ||
    typeof coverage.complete !== 'boolean' || coverage.complete !== (coverage.checked === coverage.total) || data.needsAttention > coverage.checked))
    throw Error('Auto Run check coverage is incomplete. Refresh before changing automatic publishing.');
  return data;
}
