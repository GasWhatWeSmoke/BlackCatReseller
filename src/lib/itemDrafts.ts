export type DraftValue = string | number | boolean | null;
export type DraftValues = Record<string, DraftValue>;
export type DraftScope = "review" | "editor" | "pricing" | "earnings";
export interface DraftItem { id: number; createdAt: string; status: string; [field: string]: unknown }
export interface ItemDraft {
  version: 1; key: string; revision: string; savedAt: number;
  baseline: DraftValues; changes: DraftValues;
}

export const DRAFT_FIELDS = new Set([
  "brand", "size", "itemType", "category", "color", "pattern", "listedPrice", "itemCost", "weightOz", "whenMade", "notes",
  "department", "material", "style", "secondaryColor", "condition", "etsyEligible", "trueVintage", "inseam", "fit",
  "description", "customTitle", "model", "styleNumber", "tertiaryColor", "closure", "neckline", "lining", "graphics",
  "keyDetails", "aesthetic", "chestIn", "lengthIn", "sleeveIn", "shoulderIn", "waistIn", "hipIn", "riseIn",
]);
const scalar = (value: unknown): value is DraftValue => value === null || typeof value === "boolean"
  || typeof value === "string" && value.length <= 100_000 || typeof value === "number" && Number.isFinite(value);

export function draftKey(scope: DraftScope, item: Pick<DraftItem, "id" | "createdAt">): string {
  if (!Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)))
    throw new Error("The item's identity could not be confirmed for draft recovery.");
  return `${scope}:${item.id}:${item.createdAt}`;
}

export function parseDraft(value: unknown, key: string): ItemDraft | null {
  if (value == null) return null;
  const d = value as ItemDraft;
  if (d.version !== 1 || d.key !== key || typeof d.revision !== "string" || !Number.isFinite(d.savedAt)
    || !d.baseline || !d.changes || Array.isArray(d.baseline) || Array.isArray(d.changes)
    || typeof d.baseline !== "object" || typeof d.changes !== "object") throw new Error("This local draft could not be read. It has been kept for recovery.");
  for (const [field, entry] of Object.entries(d.changes)) {
    if (!DRAFT_FIELDS.has(field) || !scalar(entry) || !Object.hasOwn(d.baseline, field) || !scalar(d.baseline[field]))
      throw new Error("This local draft contains unsupported values. It has been kept for recovery.");
  }
  for (const [field, entry] of Object.entries(d.baseline)) {
    if ((field !== "status" && !DRAFT_FIELDS.has(field)) || !scalar(entry)) throw new Error("This draft's original values could not be verified.");
  }
  if (typeof d.baseline.status !== "string") throw new Error("This local draft has no saved status to compare.");
  return d;
}

export function changeDraft(key: string, item: DraftItem, draft: ItemDraft | null, changes: DraftValues): ItemDraft {
  const baseline = { ...(draft && Object.keys(draft.changes).length ? draft.baseline : { status: item.status }) };
  const edits = { ...draft?.changes };
  for (const [field, value] of Object.entries(changes)) {
    if (!DRAFT_FIELDS.has(field) || !scalar(value)) throw new Error(`Cannot keep a draft for ${field}.`);
    if (!Object.hasOwn(baseline, field)) {
      const before = item[field] ?? null;
      if (!scalar(before)) throw new Error(`Cannot compare the saved ${field} value.`);
      baseline[field] = before;
    }
    edits[field] = value;
  }
  return { version: 1, key, baseline, changes: edits, revision: draft?.revision ?? "", savedAt: Date.now() };
}

export function draftConflicts(item: DraftItem, draft: ItemDraft | null): string[] {
  if (!draft || !Object.keys(draft.changes).length) return [];
  return Object.keys(draft.baseline).filter(field => (item[field] ?? null) !== draft.baseline[field]
    && (field === "status" || (item[field] ?? null) !== draft.changes[field]));
}

/** Preserve the original comparison values across refresh and navigation. */
export function draftExpectedItem(item: DraftItem, draft: ItemDraft | null): Record<string, unknown> {
  if (!draft || !Object.keys(draft.changes).length) return item;
  const expected = { ...item };
  for (const [field, value] of Object.entries(draft.baseline)) {
    expected[field] = field !== "status" && (item[field] ?? null) === draft.changes[field] ? item[field] : value;
  }
  return expected;
}

export function resolveDraftField(item: DraftItem, draft: ItemDraft, field: string, keepEdit: boolean): ItemDraft {
  if (field !== "status" && !DRAFT_FIELDS.has(field)) throw new Error("Unknown draft field.");
  const next = { ...draft, baseline: { ...draft.baseline }, changes: { ...draft.changes }, savedAt: Date.now() };
  const value = item[field] ?? null;
  if (!scalar(value)) throw new Error("The saved value could not be compared.");
  next.baseline[field] = value;
  if (!keepEdit && field !== "status") delete next.changes[field];
  return next;
}

export class LocalDraftConflict extends Error {
  latest: ItemDraft | null;
  constructor(latest: ItemDraft | null) { super("Another window changed this local draft. Choose which edits to keep."); this.latest = latest; }
}

let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("blackcat-item-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onerror = () => reject(new Error("Local draft storage is unavailable. Keep this window open until you save to inventory."));
    request.onblocked = () => reject(new Error("Close older Black Cat windows to enable local draft recovery."));
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); connection = undefined; }; resolve(db); };
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}

// Review checkpoints share this local store without changing the SQLite schema.
export const localDraftDatabase = database;

export async function readItemDraft(key: string): Promise<ItemDraft | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
    request.onsuccess = () => { try { resolve(parseDraft(request.result, key)); } catch (error) { reject(error); } };
    request.onerror = () => reject(new Error("The local draft could not be read."));
  });
}

export function draftIdentity(key: string, scope: DraftScope): { id: number; createdAt: string } {
  const prefix = `${scope}:`;
  if (!key.startsWith(prefix)) throw new Error("This draft belongs to another editor.");
  const rest = key.slice(prefix.length), separator = rest.indexOf(":");
  const identity = { id: Number(rest.slice(0, separator)), createdAt: rest.slice(separator + 1) };
  if (draftKey(scope, identity) !== key) throw new Error("This draft's item identity could not be read.");
  return identity;
}

/** Include unfinished prices even after their items leave the unpriced filter. */
export async function listItemDrafts(scope: DraftScope): Promise<ItemDraft[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const found: ItemDraft[] = [];
    const request = db.transaction("drafts", "readonly").objectStore("drafts")
      .openCursor(IDBKeyRange.bound(`${scope}:`, `${scope}:\uffff`));
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) { resolve(found); return; }
        const key = String(cursor.key); draftIdentity(key, scope);
        const draft = parseDraft(cursor.value, key);
        if (draft && Object.keys(draft.changes).length) found.push(draft);
        cursor.continue();
      } catch (error) { reject(error); }
    };
    request.onerror = () => reject(new Error("Unfinished local drafts could not be loaded."));
  });
}

/** Read/compare/write is one browser transaction, including across app windows. */
export async function writeItemDraft(key: string, value: ItemDraft | null, expectedRevision: string | null): Promise<ItemDraft | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" });
    const store = tx.objectStore("drafts");
    let next: ItemDraft | null = null, failure: unknown;
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        const current = parseDraft(request.result, key);
        if ((current?.revision ?? null) !== expectedRevision) throw new LocalDraftConflict(current);
        next = value ? { ...value, key, revision: crypto.randomUUID(), savedAt: Date.now() } : null;
        if (next) { parseDraft(next, key); store.put(next); } else store.delete(key);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(failure ?? new Error("Your draft could not be kept on this device. Keep this window open until you save to inventory."));
    tx.onerror = () => { /* onabort supplies the final result */ };
  });
}
