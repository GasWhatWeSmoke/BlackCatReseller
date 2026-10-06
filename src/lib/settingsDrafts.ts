import type { AppSettingsData } from './types.ts';
import { localDraftDatabase } from './itemDrafts.ts';

// Only controls saved by the general-preferences form. Never persist credentials,
// marketplace switches or background status in this browser-local draft.
export const GENERAL_SETTINGS_FIELDS = [
  'dataRoot', 'incomingPath', 'processingPath', 'readyPath', 'needsReviewPath',
  'archivePath', 'exportsPath', 'logsPath', 'backupsPath', 'pythonWorkerPath',
  'skuPrefixes', 'skuLength', 'skuRegex', 'requiredFieldsForReady', 'minListingPhotos',
  'fileStabilitySeconds', 'backupRetention', 'ocrEnabled', 'ocrPreprocess', 'ocrPostCorrect',
  'tagOcrEnabled', 'tagOcrMaxPhotos', 'tagOcrMinConfidence', 'visionEnabled', 'visionFields',
  'visionMaxPhotos', 'visionMaxTokens', 'visionTimeoutSeconds', 'feeModel', 'shippingModel',
  'priceNinetyNine', 'priceWarnMin', 'priceWarnMax', 'lensPublicUpload', 'mercariShipFrom',
  'publishAbortAfterConsecutiveFailures',
] as const satisfies readonly (keyof AppSettingsData)[];
export type GeneralSettingsField = typeof GENERAL_SETTINGS_FIELDS[number];
type Values = Partial<Pick<AppSettingsData, GeneralSettingsField>>;
type Baseline = { [K in GeneralSettingsField]?: AppSettingsData[K] | null };
export const SETTINGS_DRAFT_KEY = 'settings:general:v1';
export interface SettingsDraft {
  key: typeof SETTINGS_DRAFT_KEY; version: 1; revision: string; savedAt: number;
  workspace: string; baseline: Baseline; changes: Values;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const allowed = new Set<string>(GENERAL_SETTINGS_FIELDS);
const booleans = new Set(['ocrEnabled','ocrPreprocess','ocrPostCorrect','tagOcrEnabled','visionEnabled','lensPublicUpload']);
const numbers = new Set(['skuLength','minListingPhotos','fileStabilitySeconds','backupRetention','tagOcrMaxPhotos','tagOcrMinConfidence',
  'visionMaxPhotos','visionMaxTokens','visionTimeoutSeconds','priceWarnMin','priceWarnMax','publishAbortAfterConsecutiveFailures']);
function fieldValue(key: string, value: unknown): boolean {
  if (!jsonValue(value)) return false;
  if (booleans.has(key)) return typeof value === 'boolean';
  if (numbers.has(key)) return typeof value === 'number';
  if (['skuPrefixes','requiredFieldsForReady','visionFields'].includes(key)) return Array.isArray(value) && value.every(v => typeof v === 'string');
  if (key === 'feeModel') return !!value && !Array.isArray(value) && typeof value === 'object'
    && Object.values(value).every(v => v && typeof v === 'object' && Number.isFinite(v.feePercent) && Number.isFinite(v.fixedFee));
  if (key === 'shippingModel') { const v = value as AppSettingsData['shippingModel']; return !!v && Number.isFinite(v.default)
    && Array.isArray(v.tiers) && v.tiers.every(t => t && Number.isFinite(t.maxOz) && Number.isFinite(t.cost)); }
  if (key === 'mercariShipFrom') return !!value && typeof value === 'object'
    && ['city','zip','state','stateFull'].every(k => typeof (value as Record<string, unknown>)[k] === 'string');
  return typeof value === 'string';
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 100_000;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(entry => jsonValue(entry, depth + 1));
  return !!value && typeof value === 'object' && Object.keys(value).length <= 1000
    && Object.entries(value).every(([key, entry]) => !['__proto__', 'prototype', 'constructor'].includes(key) && jsonValue(entry, depth + 1));
}
export function generalSettingsChanges(before: AppSettingsData, after: AppSettingsData): Values {
  return Object.fromEntries(GENERAL_SETTINGS_FIELDS.filter(key => !same(before[key], after[key])).map(key => [key, after[key]]));
}
export function settingsDraft(saved: AppSettingsData, form: AppSettingsData, previous: SettingsDraft | null = null): SettingsDraft {
  const changes = generalSettingsChanges(saved, form);
  const unfinished = previous && Object.keys(previous.changes).length ? previous : null;
  const baseline = Object.fromEntries(Object.keys(changes).map(key => [key,
    unfinished && Object.hasOwn(unfinished.changes, key) ? unfinished.baseline[key as GeneralSettingsField] : saved[key as GeneralSettingsField] ?? null]));
  return { key: SETTINGS_DRAFT_KEY, version: 1, revision: previous?.revision ?? '', savedAt: Date.now(),
    workspace: unfinished?.workspace ?? saved.dataRoot, baseline, changes };
}
export function parseSettingsDraft(input: unknown): SettingsDraft | null {
  if (input == null) return null;
  const d = input as SettingsDraft;
  if (d.key !== SETTINGS_DRAFT_KEY || d.version !== 1 || typeof d.revision !== 'string' || !Number.isFinite(d.savedAt)
    || typeof d.workspace !== 'string' || !d.workspace || !d.baseline || !d.changes
    || Array.isArray(d.baseline) || Array.isArray(d.changes) || typeof d.baseline !== 'object' || typeof d.changes !== 'object'
    || !Object.entries(d.changes).every(([key, value]) => allowed.has(key) && fieldValue(key, value))
    || !Object.entries(d.baseline).every(([key, value]) => allowed.has(key) && (value === null || fieldValue(key, value)))
    || Object.keys(d.baseline).length !== Object.keys(d.changes).length
    || Object.keys(d.changes).some(key => !Object.hasOwn(d.baseline, key)))
    throw Error('The local settings draft could not be read. Its stored copy has been kept.');
  return d;
}
export function settingsDraftConflicts(saved: AppSettingsData, draft: SettingsDraft | null): string[] {
  if (!draft || !Object.keys(draft.changes).length) return [];
  const conflicts = Object.keys(draft.changes).filter(key => !same(saved[key as GeneralSettingsField], draft.baseline[key as GeneralSettingsField])
    && !same(saved[key as GeneralSettingsField], draft.changes[key as GeneralSettingsField]));
  if (draft.workspace !== saved.dataRoot && draft.changes.dataRoot !== saved.dataRoot) conflicts.push('dataRoot');
  return [...new Set(conflicts)];
}
export function recoverSettingsDraft(saved: AppSettingsData, draft: SettingsDraft | null) {
  if (!draft || (draft.workspace !== saved.dataRoot && draft.changes.dataRoot !== saved.dataRoot)) return draft;
  const keys = Object.keys(draft.changes).filter(key => !same(saved[key as GeneralSettingsField], draft.changes[key as GeneralSettingsField]));
  return { ...draft, workspace: saved.dataRoot, changes: Object.fromEntries(keys.map(key => [key, draft.changes[key as GeneralSettingsField]])),
    baseline: Object.fromEntries(keys.map(key => [key, draft.baseline[key as GeneralSettingsField]])) };
}
export function formAfterSettingsSave(submitted: AppSettingsData, current: AppSettingsData, confirmed: AppSettingsData): AppSettingsData {
  return { ...confirmed, ...generalSettingsChanges(submitted, current) };
}
export function describeSettingsValue(field: string, value: unknown): string {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.join(', ') || 'None selected';
  if (field === 'feeModel' && typeof value === 'object') return Object.entries(value as AppSettingsData['feeModel'])
    .map(([platform, fee]) => `${platform}: ${fee.feePercent}% + $${fee.fixedFee}`).join('\n') || 'No fee estimates';
  if (field === 'shippingModel' && typeof value === 'object') {
    const shipping = value as AppSettingsData['shippingModel'];
    return [...shipping.tiers.map(tier => `${tier.maxOz} oz or less: $${tier.cost}`), `Over top tier: $${shipping.default}`].join('\n');
  }
  if (field === 'mercariShipFrom' && typeof value === 'object') {
    const address = value as AppSettingsData['mercariShipFrom'];
    return `City: ${address.city || 'Not set'}\nZIP: ${address.zip || 'Not set'}\nState: ${address.state || 'Not set'}\nFull state: ${address.stateFull || 'Not set'}`;
  }
  return String(value);
}
export class SettingsDraftConflict extends Error {
  latest: SettingsDraft | null;
  constructor(latest: SettingsDraft | null) { super('Another window changed the settings draft. Choose which edits to keep before saving.'); this.latest = latest; }
}
export async function readSettingsDraft(): Promise<SettingsDraft | null> {
  const db = await localDraftDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('drafts', 'readonly').objectStore('drafts').get(SETTINGS_DRAFT_KEY);
    request.onsuccess = () => { try { resolve(parseSettingsDraft(request.result)); } catch (error) { reject(error); } };
    request.onerror = () => reject(Error('Local settings draft recovery is unavailable.'));
  });
}
export async function writeSettingsDraft(value: SettingsDraft | null, revision: string | null): Promise<SettingsDraft | null> {
  const db = await localDraftDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite', { durability: 'strict' }), store = tx.objectStore('drafts');
    let next: SettingsDraft | null = null, failure: unknown;
    const request = store.get(SETTINGS_DRAFT_KEY);
    request.onsuccess = () => {
      try {
        const current = parseSettingsDraft(request.result);
        if ((current?.revision ?? null) !== revision) throw new SettingsDraftConflict(current);
        next = value ? { ...value, revision: crypto.randomUUID(), savedAt: Date.now() } : null;
        if (next) { parseSettingsDraft(next); store.put(next); } else store.delete(SETTINGS_DRAFT_KEY);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(failure ?? Error('The settings draft could not be kept on this device. Save preferences before leaving.'));
    tx.onerror = () => { /* onabort reports the final failure */ };
  });
}
