// Depop-side constants and validation (§45.4) — pure, unit-tested.
//
// The FIELD BUILDING lives in the Python worker (post_depop.build_depop_fields,
// tested in worker/tests/test_depop_logic.py) because that is where the values
// meet the form. This file owns what the QUEUE must know before a browser ever
// opens: Depop's hard limits and which items are not worth launching for.

import type { CanonicalListing, ValidationIssue } from "../../types.ts";
import { PublishError } from "../../types.ts";
import { parseBrowserReport, type BrowserReport } from "../../browserProtocol.ts";

/** Depop allows at most 8 photos on a listing. More is not an error — the worker
 *  posts the first 8 (cover first) and SAYS SO in the result — but zero is. */
export const DEPOP_MAX_PHOTOS = 8;
/** Depop descriptions cap at 1000 characters (the worker trims to fit; the title
 *  line and hashtags always survive the trim). */
export const DEPOP_DESC_MAX = 1000;

/** Mirrors DEPOP_CONDITION in post_depop.py — the conditions posting understands. */
export const DEPOP_CONDITIONS = new Set([
  "New with tags", "New without tags", "Like new", "Good", "Fair", "Pre-owned",
]);

/** The worker's final report line: DEPOP_DONE {json}. */
export type DepopDone = BrowserReport;

export function depopPublicationError(done: DepopDone | null): PublishError {
  const reason = done?.reason ?? done?.message ?? "The Depop worker ended without reporting a result";
  const notSubmitted = done?.outcome === "failed" && done.submissionStarted === false;
  const addressServiceUnavailable = notSubmitted && !done?.url &&
    reason === "Depop saved shipping addresses are temporarily unavailable";
  const needsReview = !notSubmitted || (!addressServiceUnavailable && /not-logged-in|log ?in|rejected|control\(s\) not found|no Post button|form has changed|no matching|missing|not confirmed|known department|verified mapping|ambiguous matching|shipping address|expected USPS|already contains photos/i.test(reason));
  return new PublishError(reason, needsReview ? "requires_review" : "retryable", notSubmitted);
}

/** Parse the LAST DEPOP_DONE line out of the worker's stdout (progress lines
 *  precede it; a crash after a report must not resurrect an older one). */
export function parseDepopDone(buf: string): DepopDone | null {
  return parseBrowserReport(buf, "DEPOP_DONE");
}

export function depopValidate(l: CanonicalListing): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (l.quantity !== 1) issues.push({ field: "quantity", message: "Depop multi-unit posting still needs native form verification" });
  if (!DEPOP_CONDITIONS.has(l.condition)) {
    issues.push({ field: "condition", message: `condition "${l.condition}" has no Depop mapping` });
  }
  if (l.price < 1) {
    issues.push({ field: "price", message: "Depop needs a price of at least $1" });
  }
  if (l.photos.length === 0) {
    issues.push({ field: "photos", message: "no photos — Depop requires at least one" });
  }
  return issues;
}
