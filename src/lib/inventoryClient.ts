import { inventoryQueryString, type InventoryPage, type InventoryQuery } from "./inventoryQuery.ts";
import { bulkDeleteReceiptMatches, parseItemDeleteSelection, type ItemDeleteExpectation } from './itemDeleteSelection.ts';
import { bulkEditReceiptMatches, type BulkEditChanges, type BulkEditOutcome, type BulkEditSelection } from './bulkItemEdit.ts';
import { archiveCommand, archiveSavedItem, type ArchiveAction, type ArchiveOutcome, type ArchiveSelection } from './bulkArchive.ts';

export interface InventoryDeleteResult {
  ok: boolean; deleted: number; soldKept?: number; failed?: { id: number; error?: string }[];
  cleanupWarnings?: { id?: number; warnings?: string[] }[];
}
export interface InventoryOperations {
  read: (query: InventoryQuery, signal: AbortSignal) => Promise<InventoryPage>;
  remove: (ids: number[], expected: ItemDeleteExpectation[]) => Promise<InventoryDeleteResult>;
  create: (sku: string) => Promise<number>;
  edit?: (item: BulkEditSelection, changes: BulkEditChanges) => Promise<BulkEditOutcome>;
  archive?: (item: ArchiveSelection, action: ArchiveAction) => Promise<ArchiveOutcome>;
}
export const browserInventoryOperations: InventoryOperations = {
  archive: async (item, action) => {
    const command = archiveCommand({ action, selection: item }), controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/api/items/${command.selection.id}`, { method: 'PATCH', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bulkArchive: command }) });
      const body = await response.json().catch(() => null);
      if ([400, 404, 409, 422].includes(response.status) && typeof body?.error === 'string') return { kind: 'blocked', message: body.error };
      const saved = response.ok ? archiveSavedItem(body, command.selection, action) : null;
      if (!saved) return { kind: 'unknown', message: 'The archive result could not be confirmed. Refresh Inventory before trying again.' };
      return { kind: 'saved', item: saved, message: action === 'archive' ? 'Archived; photos and history kept.' : 'Restored to Review; approval is required again.' };
    } finally { clearTimeout(timeout); }
  },
  edit: async (item, changes) => {
    const response = await fetch(`/api/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...changes, bulkEdit: item }) });
    const body = await response.json().catch(() => null);
    if ([400, 404, 409, 422].includes(response.status) && typeof body?.error === 'string') return { kind: 'blocked', message: body.error };
    if (!response.ok || !bulkEditReceiptMatches(body, item, changes)) return { kind: 'unknown', message: 'Save could not be confirmed. Refresh the item before another edit.' };
    return { kind: 'saved', message: 'Saved and returned to Review.' };
  },
  read: async (query, signal) => {
    const response = await fetch(`/api/items?view=inventory&${inventoryQueryString(query)}`, { signal, cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total < 0
      || !Number.isSafeInteger(body.page) || body.page < 1 || !Number.isSafeInteger(body.pages) || body.pages < body.page
      || !Number.isSafeInteger(body.pageSize) || body.pageSize < 1 || body.pageSize > 100 || body.items.length > body.pageSize)
      throw new Error(body?.error || "Inventory results could not be confirmed. Retry loading the page.");
    return body;
  },
  remove: async (ids, expected) => {
    const expectedItems = parseItemDeleteSelection(ids, expected);
    const response = await fetch("/api/items/bulk-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, expectedItems }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !bulkDeleteReceiptMatches(body, expectedItems)) throw new Error(body?.error || "Deletion could not be confirmed. Refresh inventory before retrying.");
    return body;
  },
  create: async sku => {
    const response = await fetch("/api/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sku }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Number.isSafeInteger(body?.item?.id) || body.item.id <= 0) throw new Error(body?.error || "The new item could not be confirmed.");
    return body.item.id;
  },
};
