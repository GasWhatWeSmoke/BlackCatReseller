import { ITEM_STATUSES } from './types.ts';

export type ArchiveAction = 'archive' | 'restore';
export interface ArchiveSelection { id: number; sku: string; createdAt: string; updatedAt: string; status: string }
export interface ArchiveOutcome { kind: 'saved' | 'blocked' | 'unknown'; message: string; item?: ArchiveSelection }
export interface ArchiveResult extends ArchiveOutcome { id: number; sku: string }
export interface ArchiveReceipt { at: string; action: ArchiveAction; selection: ArchiveSelection[]; results: ArchiveResult[]; complete: boolean }
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function archiveSelection(value: unknown): ArchiveSelection {
  const row = value as ArchiveSelection | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.sku !== 'string' || !row.sku || row.sku.length > 128 ||
      !date(row.createdAt) || !date(row.updatedAt) || !ITEM_STATUSES.some(status => status === row.status))
    throw Error('Refresh the selected items before changing their archive state.');
  return { id: row.id, sku: row.sku, createdAt: row.createdAt, updatedAt: row.updatedAt, status: row.status };
}

export function archiveCommand(value: unknown): { action: ArchiveAction; selection: ArchiveSelection } {
  const command = value as { action: ArchiveAction; selection: unknown } | null;
  if (!command || !['archive', 'restore'].includes(command.action) || Object.keys(command).some(key => !['action', 'selection'].includes(key)))
    throw Error('Choose Archive or Restore to Review.');
  return { action: command.action, selection: archiveSelection(command.selection) };
}

export function archiveSavedItem(body: unknown, expected: ArchiveSelection, action: ArchiveAction): ArchiveSelection | null {
  const reply = body as { previousUpdatedAt?: unknown; item?: Record<string, unknown> } | null;
  try {
    const item = archiveSelection(reply?.item);
    if (reply?.previousUpdatedAt !== expected.updatedAt || item.id !== expected.id || item.sku !== expected.sku ||
        item.createdAt !== expected.createdAt || Date.parse(item.updatedAt) <= Date.parse(expected.updatedAt) ||
        item.status !== (action === 'archive' ? 'Archived' : 'Photographed') ||
        action === 'restore' && reply?.item?.readyFolderPath !== null) return null;
    return item;
  } catch { return null; }
}

export function parseArchiveReceipt(value: unknown): ArchiveReceipt {
  const receipt = value as ArchiveReceipt | null;
  if (!receipt || !date(receipt.at) || !['archive', 'restore'].includes(receipt.action) || typeof receipt.complete !== 'boolean' ||
      !Array.isArray(receipt.selection) || !receipt.selection.length || receipt.selection.length > 100 ||
      !Array.isArray(receipt.results) || receipt.results.length > receipt.selection.length) throw Error('Invalid archive report.');
  const selection = receipt.selection.map(archiveSelection);
  if (new Set(selection.map(item => item.id)).size !== selection.length) throw Error('Invalid archive selection.');
  const results = receipt.results.map((row, index) => {
    const selected = selection[index];
    if (!row || row.id !== selected.id || row.sku !== selected.sku || !['saved', 'blocked', 'unknown'].includes(row.kind) ||
        typeof row.message !== 'string' || row.message.length > 2000) throw Error('Invalid archive result.');
    let item: ArchiveSelection | undefined;
    if (row.kind === 'saved') {
      item = archiveSelection(row.item);
      if (item.id !== selected.id || item.sku !== selected.sku || item.createdAt !== selected.createdAt ||
          item.status !== (receipt.action === 'archive' ? 'Archived' : 'Photographed') ||
          Date.parse(item.updatedAt) <= Date.parse(selected.updatedAt)) throw Error('Unconfirmed archive result.');
    }
    return { id: row.id, sku: row.sku, kind: row.kind, message: row.message, ...(item ? { item } : {}) };
  });
  if (results.some((row, index) => row.kind === 'unknown' && index !== results.length - 1)) throw Error('Invalid archive stop point.');
  return { at: receipt.at, action: receipt.action, selection, results, complete: receipt.complete };
}

/** Persist each receipt; an uncertain result stops the batch and is never replayed. */
export async function archiveSelectedItems(selection: ArchiveSelection[], action: ArchiveAction,
  change: (item: ArchiveSelection, action: ArchiveAction) => Promise<ArchiveOutcome>,
  options: { stopped: () => boolean; progress: (results: ArchiveResult[]) => void }) {
  if (!selection.length || selection.length > 100 || new Set(selection.map(item => item.id)).size !== selection.length)
    throw Error('Select between 1 and 100 distinct items.');
  const items = selection.map(item => archiveCommand({ action, selection: item }).selection), results: ArchiveResult[] = [];
  for (const item of items) {
    if (options.stopped()) break;
    let outcome: ArchiveOutcome;
    try { outcome = await change(item, action); }
    catch { outcome = { kind: 'unknown', message: 'The response was lost. Refresh Inventory and check this item before trying again.' }; }
    try {
      const checked = parseArchiveReceipt({ at: new Date().toISOString(), action, selection: [item], results: [{ ...outcome, id: item.id, sku: item.sku }], complete: true });
      outcome = checked.results[0];
    } catch { outcome = { kind: 'unknown', message: 'The result could not be confirmed. Check this item in Inventory.' }; }
    results.push({ ...outcome, id: item.id, sku: item.sku });
    options.progress([...results]);
    if (outcome.kind === 'unknown') break;
  }
  return results;
}
