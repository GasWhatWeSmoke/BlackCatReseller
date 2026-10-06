// Error classification (§45.21) + retry pacing (§45.20).
//
// The queue never decides what an error MEANS — adapters throw classified
// PublishErrors for conditions they recognize, and anything unclassified lands
// here. The default for an unknown error is retryable-with-a-cap rather than
// requires_review: a transient network blip must not park 300 items for manual
// triage, and the attempt cap keeps a genuinely broken item from looping.

import { PublishError, type PublishErrorClass } from "./types.ts";

/** Substrings that mark an error as safe to retry (transient world problems). */
const RETRYABLE = [
  "timeout", "timed out", "econnreset", "econnrefused", "enotfound", "eai_again",
  "socket hang up", "network", "fetch failed", "aborted",
  "429", "rate limit", "too many requests",
  "500", "502", "503", "504", "service unavailable", "internal server error",
];

/** Substrings that mark an error as needing a human (§45.21: never retried). */
const NEEDS_REVIEW = [
  "invalid category", "category is not valid", "missing required", "required field",
  "invalid size", "unsupported condition", "condition is not valid",
  "title", "policy", "not authorized", "unauthorized", "invalid_grant",
  "invalid_scope", "invalid price", "aspect", "item specifics",
];

export function classifyError(err: unknown): { message: string; errorClass: PublishErrorClass } {
  if (err instanceof PublishError) return { message: err.message, errorClass: err.errorClass };
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (NEEDS_REVIEW.some((s) => lower.includes(s))) return { message, errorClass: "requires_review" };
  if (RETRYABLE.some((s) => lower.includes(s))) return { message, errorClass: "retryable" };
  return { message, errorClass: "retryable" };
}

/**
 * Exponential backoff with a ceiling: 30s, 60s, 120s, 240s... capped at 10min.
 * attempt is 1-based (the attempt that just failed).
 */
export function backoffMs(attempt: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 600_000);
}
