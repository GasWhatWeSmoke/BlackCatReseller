import { archiveSelection, type ArchiveSelection } from './bulkArchive.ts';
import { isBrowserMarketplace, MARKETPLACE_NAMES, type BrowserMarketplace } from './publish/platforms.ts';

export const MANUAL_SALE_FIELD = 'manual_sale';
export type ManualSaleSource = BrowserMarketplace | 'in_person' | 'off_platform';
export interface ManualSaleCommand {
  operationId: string;
  selection: ArchiveSelection;
  source: ManualSaleSource;
  fulfillment: 'shipping' | 'pickup';
  completed: boolean;
  soldAt: string;
  salePriceCents: number;
  feeCents: number;
  shippingChargedCents: number;
  shippingCostCents: number | null;
  reference: string;
  sourceListing: { id: number; updatedAt: string; externalListingId: string | null; externalUrl: string | null } | null;
}
export const manualSalePlatform = (source: ManualSaleSource) => source === 'in_person' ? 'In person' : source === 'off_platform' ? 'Off-platform' : MARKETPLACE_NAMES[source];
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const cents = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100_000_000;
export function parseManualSale(value: unknown): ManualSaleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Review the sale details before confirming.');
  const v = value as ManualSaleCommand;
  const keys = ['operationId', 'selection', 'source', 'fulfillment', 'completed', 'soldAt', 'salePriceCents', 'feeCents', 'shippingChargedCents', 'shippingCostCents', 'reference', 'sourceListing'];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key)) ||
      typeof v.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(v.operationId) ||
      typeof v.source !== 'string' || !(isBrowserMarketplace(v.source) || ['in_person', 'off_platform'].includes(v.source)) ||
      !['shipping', 'pickup'].includes(v.fulfillment) || typeof v.completed !== 'boolean' || !iso(v.soldAt) ||
      ![v.salePriceCents, v.feeCents, v.shippingChargedCents].every(cents) || !(v.shippingCostCents === null || cents(v.shippingCostCents)) ||
      typeof v.reference !== 'string' || v.reference !== v.reference.trim() || !v.reference || v.reference.length > 200)
    throw Error('Enter a sale date, reference and valid USD amounts. Fees must be entered explicitly, including zero.');
  if (v.fulfillment === 'pickup' && (v.shippingChargedCents !== 0 || v.shippingCostCents !== 0)) throw Error('Pickup has no shipping income or postage.');
  if (v.source === 'in_person' && v.fulfillment !== 'pickup') throw Error('Use Off-platform for a sale that needs shipping.');
  const source = v.sourceListing;
  if (source !== null && (!source || Object.keys(source).sort().join() !== 'externalListingId,externalUrl,id,updatedAt' ||
      !Number.isSafeInteger(source.id) || source.id < 1 || !iso(source.updatedAt) ||
      ![source.externalListingId, source.externalUrl].every(x => x === null || typeof x === 'string') || !isBrowserMarketplace(v.source)))
    throw Error('The sold listing could not be identified. Reload this item.');
  return { operationId: v.operationId, selection: archiveSelection(v.selection), source: v.source, fulfillment: v.fulfillment,
    completed: v.completed, soldAt: v.soldAt, salePriceCents: v.salePriceCents, feeCents: v.feeCents,
    shippingChargedCents: v.shippingChargedCents, shippingCostCents: v.shippingCostCents, reference: v.reference,
    sourceListing: source ? { id: source.id, updatedAt: source.updatedAt, externalListingId: source.externalListingId, externalUrl: source.externalUrl } : null };
}

export interface ManualSaleInfo { operationId: string; fulfillment: 'shipping' | 'pickup'; reference: string }
/** A returned sale must never lend its pickup label to a later browser-detected sale. */
export function currentManualSale(item: { id: number; status: string; createdAt: Date | string; dateSold: Date | string | null; platformSold: string | null },
  logs: { id: number; itemId: number | null; field: string; action: string; newValue: string | null }[]): ManualSaleInfo | null {
  if (item.status !== 'Sold') return null;
  const date = (v: Date | string | null) => v instanceof Date ? v.toISOString() : v;
  for (const row of [...logs].sort((a, b) => b.id - a.id)) {
    if (row.itemId !== item.id) continue;
    if (row.field === 'order_review' && row.action === 'returned') return null;
    if (row.field !== MANUAL_SALE_FIELD || row.action !== 'recorded') continue;
    try {
      const command = parseManualSale(JSON.parse(row.newValue ?? 'null'));
      return command.selection.id === item.id && command.selection.createdAt === date(item.createdAt) &&
        command.soldAt === date(item.dateSold) && manualSalePlatform(command.source) === item.platformSold
        ? { operationId: command.operationId, fulfillment: command.fulfillment, reference: command.reference } : null;
    } catch { return null; }
  }
  return null;
}

export function saleMoneyCents(value: string, label: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw Error(`${label}: enter a USD amount, using 0 for none.`);
  const result = Math.round(Number(value) * 100);
  if (!cents(result)) throw Error(`${label}: amount is outside the supported range.`);
  return result;
}
