import { ITEM_STATUSES } from './types.ts';

export const MONEY_FIELDS = ["listedPrice", "itemCost", "salePrice", "marketplaceFees", "shippingCost", "shippingCharged"] as const;

/** Send the saved values alongside an edit so a stale screen cannot silently
 * replace later changes. Photo-only updatedAt changes do not conflict with text. */
export function withExpectedItemValues(before: Record<string, unknown>, changes: Record<string, unknown>) {
  const expectedValues: Record<string, unknown> = {};
  for (const field of Object.keys(changes)) {
    if (field === "expectedValues") continue;
    const stored = field === "shipped" ? "shippedAt" : field;
    expectedValues[stored] = before[stored] ?? null;
  }
  if (typeof before.status === "string") expectedValues.status = before.status;
  // A restored/replaced inventory row can reuse an ID and the same field values.
  // Creation identity is stable across ordinary photo/text updates.
  if (before.createdAt instanceof Date) expectedValues.createdAt = before.createdAt.toISOString();
  else if (typeof before.createdAt === "string") expectedValues.createdAt = before.createdAt;
  return { ...changes, expectedValues };
}

export function expectedItemValuesError(value: unknown, allowed: readonly string[]): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected saved item values must be an object.";
  for (const [field, expected] of Object.entries(value)) {
    if (!allowed.includes(field) || (expected !== null && !["string", "number", "boolean"].includes(typeof expected)) ||
        typeof expected === "number" && !Number.isFinite(expected)) return "Expected saved item values contain an invalid field or value.";
  }
  return null;
}

export function conflictingItemFields(before: Record<string, unknown>, expected: unknown): string[] {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return [];
  return Object.entries(expected).filter(([field, value]) => {
    const current = before[field] instanceof Date ? before[field].toISOString() : before[field] ?? null;
    return current !== value;
  }).map(([field]) => field);
}

export function itemEditError(body: unknown, status?: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected item changes.";
  const patch = body as Record<string, unknown>;
  if ('status' in patch && (typeof patch.status !== 'string' || !ITEM_STATUSES.some(value => value === patch.status)))
    return 'Choose a supported inventory status.';
  for (const key of MONEY_FIELDS) {
    const value = patch[key];
    if (!(key in patch) || value === null || value === "") continue;
    if ((typeof value !== "number" && typeof value !== "string") || !String(value).trim() || !Number.isFinite(Number(value)) || Number(value) < 0) {
      return `${key}: enter a finite amount of zero or more.`;
    }
  }
  if ("shipped" in patch && typeof patch.shipped !== "boolean") return "Shipping status must be true or false.";
  if (status === "Sold" && "status" in patch && patch.status !== "Sold") return "Use Returns to confirm the refund and item receipt before changing a sold item's inventory status.";
  if (patch.shipped === true && (status !== "Sold" || ("status" in patch && patch.status !== "Sold"))) return "Only sold items can be marked shipped.";
  return null;
}

export interface FieldEvidence {
  value?: unknown; status?: "verified" | "inferred" | "uncertain" | "confirmed";
  sources?: string[]; rawOcr?: string; note?: string;
  previous?: { value?: unknown; status?: string; sources?: string[]; rawOcr?: string; note?: string };
}
export function parseEvidence(raw: unknown): Record<string, FieldEvidence> {
  try { const value = typeof raw === "string" ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function evidenceForValue(evidence: FieldEvidence | undefined, value: unknown): FieldEvidence | null {
  if (!evidence) return null;
  if (String(evidence.value ?? "").trim() === String(value ?? "").trim()) return evidence;
  return { value, status: "confirmed", sources: ["operator"], note: "Your edit; save to confirm this value." };
}

const EVIDENCE_FIELDS = new Set(["brand", "size", "itemType", "category", "department", "color", "pattern", "model", "styleNumber", "material", "fit", "style", "keyDetails", "condition"]);
export function editedEvidence(before: Record<string, unknown>, changes: Record<string, unknown>): string | undefined {
  const evidence = parseEvidence(before.evidenceJson);
  let changed = false;
  for (const key of EVIDENCE_FIELDS) {
    if (!(key in changes) || changes[key] === before[key]) continue;
    const old = evidence[key];
    const { previous: _previous, ...original } = old ?? {};
    evidence[key] = { value: changes[key], status: "confirmed", sources: ["operator"],
      note: "Confirmed by you.", ...(old ? { previous: old.previous ?? original } : {}) };
    changed = true;
  }
  return changed ? JSON.stringify(evidence) : undefined;
}
