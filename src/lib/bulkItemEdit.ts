export const BULK_EDIT_FIELDS = {
  brand: 'Brand', size: 'Size', itemType: 'Item type', category: 'Category', color: 'Color',
  department: 'Department', condition: 'Condition', listedPrice: 'Asking price',
  itemCost: 'Cost per item', weightOz: 'Package weight (oz)', notes: 'Private notes', publicNotes: 'Public notes',
} as const;
export type BulkEditField = keyof typeof BULK_EDIT_FIELDS;
export type BulkEditChanges = Partial<Record<BulkEditField, string | number | null>>;
export interface BulkEditSelection { id: number; sku: string; createdAt: string; updatedAt: string }
export interface BulkEditOutcome { kind: 'saved' | 'blocked' | 'unknown'; message: string }
export interface BulkEditResult extends BulkEditOutcome { id: number; sku: string }

export function bulkEditSelection(value: unknown): BulkEditSelection {
  const row = value as BulkEditSelection | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.sku !== 'string' || !row.sku || row.sku.length > 32 ||
    [row.createdAt, row.updatedAt].some(date => typeof date !== 'string' || !Number.isFinite(Date.parse(date))))
    throw Error('Refresh the selected items before editing them.');
  return { id: row.id, sku: row.sku, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function parseBulkEditChanges(input: unknown): BulkEditChanges {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length)
    throw Error('Choose at least one field to change.');
  const changes: BulkEditChanges = {};
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(BULK_EDIT_FIELDS, name)) throw Error('This field cannot be changed in bulk.');
    const key = name as BulkEditField;
    if (['listedPrice', 'itemCost', 'weightOz'].includes(key)) {
      if (value === null || value === '') { changes[key] = null; continue; }
      if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value)) || Number(value) < 0 ||
        key === 'weightOz' && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0))
        throw Error(`${BULK_EDIT_FIELDS[key]}: enter ${key === 'weightOz' ? 'a positive whole number' : 'a finite amount of zero or more'}.`);
      changes[key] = Number(value);
    } else {
      if (typeof value !== 'string' || value.length > (key.endsWith('Notes') || key === 'notes' ? 2000 : 200))
        throw Error(`${BULK_EDIT_FIELDS[key]}: enter a shorter text value.`);
      changes[key] = value.trim();
    }
  }
  return changes;
}

export function bulkEditReceiptMatches(body: unknown, expected: BulkEditSelection, changes: BulkEditChanges) {
  const receipt = body as { previousUpdatedAt?: unknown; item?: Record<string, unknown> } | null;
  const item = receipt?.item;
  return !!item && receipt?.previousUpdatedAt === expected.updatedAt && item.id === expected.id && item.sku === expected.sku &&
    item.createdAt === expected.createdAt && item.status === 'Photographed' && item.readyFolderPath === null &&
    typeof item.updatedAt === 'string' && Date.parse(item.updatedAt) > Date.parse(expected.updatedAt) &&
    Object.entries(changes).every(([key, value]) => item[key] ===
      (['size', 'itemType', 'category', 'color', 'condition'].includes(key) && value === '' ? null : value));
}

/** A confirmed page selection, processed once. An unknown result stops further writes. */
export async function editSelectedItems(selection: BulkEditSelection[], input: unknown,
  edit: (item: BulkEditSelection, changes: BulkEditChanges) => Promise<BulkEditOutcome>,
  options: { stopped: () => boolean; progress: (results: BulkEditResult[]) => void }) {
  if (!selection.length || selection.length > 100 || new Set(selection.map(item => item.id)).size !== selection.length)
    throw Error('Select between 1 and 100 distinct items.');
  const items = selection.map(bulkEditSelection), changes = parseBulkEditChanges(input), results: BulkEditResult[] = [];
  for (const item of items) {
    if (options.stopped()) break;
    let outcome: BulkEditOutcome;
    try { outcome = await edit(item, { ...changes }); }
    catch { outcome = { kind: 'unknown', message: 'Save response was lost. Check the saved item before another edit.' }; }
    if (!outcome || !['saved', 'blocked', 'unknown'].includes(outcome.kind) || typeof outcome.message !== 'string') outcome = { kind: 'unknown', message: 'Save could not be confirmed.' };
    results.push({ ...outcome, id: item.id, sku: item.sku });
    options.progress([...results]);
    if (outcome.kind === 'unknown') break;
  }
  return results;
}
