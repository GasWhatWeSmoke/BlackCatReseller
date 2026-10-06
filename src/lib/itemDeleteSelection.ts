export interface ItemDeleteExpectation { id: number; sku: string; createdAt: string; updatedAt: string }
const invalid = () => new Error('Reload the selected items and confirm deletion again.');
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function parseItemDeleteExpectation(value: unknown): ItemDeleteExpectation {
  const row = value as ItemDeleteExpectation;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.sku !== 'string' || !row.sku || row.sku.length > 128
    || !validDate(row.createdAt) || !validDate(row.updatedAt)) throw invalid();
  return { id: row.id, sku: row.sku, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function itemDeleteExpectation(row: { id: number; sku: string; createdAt: string | Date; updatedAt: string | Date }): ItemDeleteExpectation {
  return parseItemDeleteExpectation({ ...row, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt });
}

export function parseItemDeleteSelection(ids: unknown, expected: unknown): ItemDeleteExpectation[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length || !Array.isArray(expected) || expected.length !== ids.length) throw invalid();
  const rows = expected.map(parseItemDeleteExpectation);
  if (rows.some((row, index) => row.id !== ids[index])) throw invalid();
  return rows;
}

export function itemDeleteReceiptMatches(value: unknown, expected: ItemDeleteExpectation): boolean {
  const result = value as ItemDeleteExpectation & { ok: boolean };
  return !!result && result.ok === true && result.id === expected.id && result.sku === expected.sku
    && result.createdAt === expected.createdAt && result.updatedAt === expected.updatedAt;
}

export function bulkDeleteReceiptMatches(value: unknown, expected: ItemDeleteExpectation[]): boolean {
  const result = value as { ok: boolean; expectedItems: unknown; deleted: number; soldKept: number; deletedIds: number[];
    soldKeptIds: number[]; failed: { id: number; error?: string }[]; cleanupWarnings: { id: number; warnings: string[] }[] };
  if (!result || result.ok !== true || JSON.stringify(result.expectedItems) !== JSON.stringify(expected)
    || !Array.isArray(result.deletedIds) || !Array.isArray(result.soldKeptIds) || !Array.isArray(result.failed)
    || !Array.isArray(result.cleanupWarnings) || result.failed.some(row => !row || !Number.isSafeInteger(row.id) || typeof row.error !== 'string')
    || result.deleted !== result.deletedIds.length || result.soldKept !== result.soldKeptIds.length) return false;
  const ids = [...result.deletedIds, ...result.soldKeptIds, ...result.failed.map(row => row.id)];
  return ids.length === expected.length && new Set(ids).size === ids.length && ids.every(id => expected.some(row => row.id === id))
    && result.cleanupWarnings.every(row => row && result.deletedIds.includes(row.id) && Array.isArray(row.warnings) && row.warnings.every(message => typeof message === 'string'));
}
