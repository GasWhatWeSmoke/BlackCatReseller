// What the listing on Nifty says vs. what Black Cat would send today.
//
// Every draft/publish CREATES a Nifty listing and then freezes: `niftyTitle` and
// `lastUploadPrice` record what went up, and nothing since has been able to change the
// live copy. So editing a brand, fixing a typo or repricing an item made the DATABASE
// right and left the LISTING wrong, with no screen that showed the gap. Yesterday's
// brand canonicalization alone put 20 of 103 live listings out of date.
//
// Pure functions, no I/O — the caller supplies the stored row and the copy that
// buildExportCopy() produced for it, and gets back a per-field comparison.
import type { ExportCopy } from "./listingCopy.ts";

/** The stored side of the comparison: what Black Cat believes is live on Nifty. */
export interface LiveSnapshot {
  niftyTitle: string | null;
  niftyDescription: string | null;
  /** The price the live listing was uploaded/pushed with. */
  lastUploadPrice: number | null;
  /** Falls back to lastUploadPrice when an item predates the upload audit. */
  listedPrice: number | null;
}

export type DriftField = "title" | "price" | "description";

export interface FieldDrift {
  field: DriftField;
  /** What Nifty shows, as far as we know. Null = never recorded. */
  live: string | null;
  /** What a push would send. */
  next: string | null;
  changed: boolean;
  /** True when nothing was ever recorded for this field, so "changed" is unknowable. */
  unknown: boolean;
}

export interface ListingDrift {
  fields: FieldDrift[];
  /** Fields that would actually change on Nifty. */
  changedFields: DriftField[];
  /** Fields whose live value was never recorded — a push would set the baseline. */
  unknownFields: DriftField[];
  /** True when at least one field would change. */
  hasDrift: boolean;
}

/** Money comparison to the cent — 34.99 and 34.990000000000002 are the same price. */
export function samePrice(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.round(a * 100) === Math.round(b * 100);
}

export const money = (v: number | null | undefined): string | null =>
  v == null ? null : `$${v.toFixed(2)}`;

// Nifty's own editor reflows whitespace, and our builder's line breaks are not
// meaningful to a buyer. Comparing raw strings reported drift on every single item
// forever, which is the fastest way to make a drift column worthless.
const normalizeText = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim();

export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeText(a) === normalizeText(b);
}

/**
 * Compare the live listing against the copy a push would send.
 *
 * `descriptionKnown` is deliberately separate from a null check: `niftyDescription`
 * was added after these listings went up, so "null" means "never recorded", NOT
 * "the listing has no description". Reporting that as a change would tell the
 * operator to re-push all 103 items on day one for no reason.
 */
export function computeDrift(live: LiveSnapshot, next: ExportCopy, nextPrice: number | null): ListingDrift {
  const livePrice = live.lastUploadPrice ?? live.listedPrice;
  const fields: FieldDrift[] = [
    {
      field: "title",
      live: live.niftyTitle,
      next: next.title,
      changed: live.niftyTitle != null && !sameText(live.niftyTitle, next.title),
      unknown: live.niftyTitle == null,
    },
    {
      field: "price",
      live: money(livePrice),
      next: money(nextPrice),
      changed: livePrice != null && nextPrice != null && !samePrice(livePrice, nextPrice),
      unknown: livePrice == null || nextPrice == null,
    },
    {
      field: "description",
      live: live.niftyDescription,
      next: next.description,
      changed: live.niftyDescription != null && !sameText(live.niftyDescription, next.description),
      unknown: live.niftyDescription == null,
    },
  ];
  const changedFields = fields.filter((f) => f.changed).map((f) => f.field);
  return {
    fields,
    changedFields,
    unknownFields: fields.filter((f) => f.unknown).map((f) => f.field),
    hasDrift: changedFields.length > 0,
  };
}

/**
 * Word-level diff for the title, so the operator sees WHAT changed rather than two
 * strings to compare by eye. Longest-common-subsequence over words — titles are
 * short (80 chars) so the quadratic table is trivially cheap.
 */
export type DiffOp = { type: "same" | "add" | "remove"; text: string };

export function diffWords(before: string, after: string): DiffOp[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i].toLowerCase() === b[j].toLowerCase()
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += ` ${text}`;
    else ops.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      // Casing-only changes ("mortal combat" -> "Mortal Kombat" keeps "Mens") are
      // shown as the NEW spelling, since that is what will be on Nifty.
      push("same", b[j]); i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("remove", a[i]); i++;
    } else {
      push("add", b[j]); j++;
    }
  }
  while (i < a.length) { push("remove", a[i]); i++; }
  while (j < b.length) { push("add", b[j]); j++; }
  return ops;
}

/**
 * A push is only worth offering when something would actually change. This also
 * guards the button: pushing an identical title/price/description would walk a
 * browser through Nifty for nothing.
 */
export function pushWorthwhile(drift: ListingDrift): boolean {
  return drift.hasDrift;
}
