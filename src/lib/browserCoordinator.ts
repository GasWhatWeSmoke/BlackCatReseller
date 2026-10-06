// One shared browser task across publishing, account sign-in, and sale monitoring.
// Keep this process-wide claim aligned with the worker browser lease.
interface BrowserClaim { holder: string | null; note: string | null }
const claimKey = Symbol.for("blackcat.browserClaim");
const processClaims = globalThis as unknown as Record<symbol, BrowserClaim | undefined>;
const claim = processClaims[claimKey] ??= { holder: null, note: null };
// What the run holding the browser wants the operator to know right now — set while the
// worker is WAITING ON A PERSON (a security check showing in the marketplace window). The Ready
// page polls it so the wait is visible where the run was started, not only in a log.

/** Claim the browser for `what` ("upload 000042"). False when someone else holds it. */
export function claimBrowser(what: string): boolean {
  if (claim.holder) return false;
  claim.holder = what;
  return true;
}

export function releaseBrowser(): void {
  claim.holder = null;
  claim.note = null;
}

/** The holder's message for the operator, or null when nothing needs them. */
export function setBrowserNote(n: string | null): void {
  claim.note = n;
}

export function browserNote(): string | null {
  return claim.note;
}

/** What currently holds the browser, or null. Used to write a useful error message. */
export function browserHolder(): string | null {
  return claim.holder;
}

/** The message shown when a claim fails — names the run that is in the way. */
export function browserBusyMessage(): string {
  return `${claim.holder ?? "another browser task"} is already using the marketplace browser — ` +
    `wait for it to finish (or close its window) before starting another.`;
}

/** Test seam: drop any claim. Never called by application code. */
export function resetBrowserForTests(): void {
  claim.holder = null;
  claim.note = null;
}
