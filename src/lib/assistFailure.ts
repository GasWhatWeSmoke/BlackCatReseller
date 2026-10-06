// How an auto-upload failure counts toward stopping the run.
//
// The Ready page's circuit breaker exists to catch NIFTY being broken — a UI change, a
// dead session — not a run of items that each stumbled on their own listing details. On
// 2026-09-05 five items in a row failed on "Style [ebay]" / "Category [poshmark]", the
// breaker declared Nifty broken, and 29 items that would have posted were skipped.
//
// Three kinds of failure, from the worker's ASSIST_DONE reason:
//   human    — a person is needed in the Nifty window (a security check, a fresh login).
//              Stops the run at once: retrying only hammers the check.
//   systemic — the worker never reached a usable form, or the browser/worker itself
//              failed. Counts toward the operator's abort-after-N setting.
//   item     — the form was reached and filled but this item's own details left a
//              required field empty. Gets three times the allowance before stopping.
export type AssistFailureKind = "human" | "systemic" | "item";

const HUMAN = /security-check|human-check|logged-out|log in to Nifty/i;
const SYSTEMIC = new RegExp(
  [
    "form-not-ready", "no-finalize-button", "off-nifty", "timed out before finishing",
    "window was closed", "profile is in use", "could not open the browser",
    "Playwright not installed", "Could not start the worker", "unexpected worker error",
    "worker exited", "already using the Nifty browser", "Worker Python not found",
  ].join("|"),
  "i",
);

export function classifyAssistFailure(error: string | null | undefined): AssistFailureKind {
  const e = error ?? "";
  if (HUMAN.test(e)) return "human";
  if (SYSTEMIC.test(e)) return "systemic";
  return "item";
}

export type BreakerTrip = "human" | "systemic" | "items" | null;
export interface BreakerState { systemic: number; item: number }
export const BREAKER_START: BreakerState = { systemic: 0, item: 0 };

/** Fold one failure into the breaker. `abortAfter` is the operator's setting (0 = off).
 * A success resets the caller's state to BREAKER_START. */
export function breakerAfterFailure(
  prev: BreakerState, kind: AssistFailureKind, abortAfter: number,
): { state: BreakerState; trip: BreakerTrip } {
  if (kind === "human") return { state: prev, trip: "human" };
  const state = kind === "systemic"
    ? { systemic: prev.systemic + 1, item: prev.item }
    : { systemic: prev.systemic, item: prev.item + 1 };
  if (abortAfter > 0) {
    if (state.systemic >= abortAfter) return { state, trip: "systemic" };
    if (state.item >= abortAfter * 3) return { state, trip: "items" };
  }
  return { state, trip: null };
}

/** The toast shown when the run stops early. */
export function breakerMessage(trip: Exclude<BreakerTrip, null>, state: BreakerState): string {
  switch (trip) {
    case "human":
      return "Run paused: the Nifty window is asking for a person (a security check, or a fresh " +
        "login). Complete it in that window, then use “Retry failed” — the remaining items were " +
        "skipped and nothing was posted twice.";
    case "systemic":
      return `Run aborted: ${state.systemic} uploads in a row never reached Nifty's form — Nifty ` +
        "itself looks broken (UI change or logged-out session), not your items. Fix that, then " +
        "use “Retry failed”.";
    case "items":
      return `Run stopped: ${state.item} items in a row failed on their own listing details ` +
        "(each item's Failed note says what Nifty still wanted). Fix those, then use “Retry failed”.";
  }
}
