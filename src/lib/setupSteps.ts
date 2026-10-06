// The first-run checklist: what a brand-new install still needs before it can list
// anything, in the order it needs it.
//
// Written as a pure function over OBSERVED state rather than a page of prose, because a
// static "getting started" document goes stale and cannot tell you which step you are
// actually stuck on. Every step here is either detected from the machine (does the folder
// exist, is the worker installed, is there a marketplace connection) or explicitly acknowledged by
// the operator for the ones nothing local can see — an eBay shipping policy lives in
// someone else's account.
//
// Two rules the wording follows:
//   * A step says what to DO, not what is wrong. "Connect marketplaces" beats "no session".
//   * `blocking` means listing genuinely cannot work without it. Optional steps
//     (local AI) are marked and never gate anything, because the whole app works
//     without a GPU and a tester should not think it is broken.

export type StepState = "done" | "todo";

export interface SetupStep {
  id: string;
  title: string;
  /** One or two sentences: what to do and why it matters. */
  detail: string;
  state: StepState;
  /** Where in the app to go and do it. */
  href?: string;
  /** Label for the link. */
  action?: string;
  /** Listing cannot work until this is done. */
  blocking: boolean;
  /**
   * Not part of "am I set up" at all — the app is complete without it.
   *
   * This is a STRUCTURAL property, not a state. Deriving it from the state instead
   * ("optional-todo") made the denominator move: installing the GPU model changed the
   * checklist from 7 steps to 8, so progress went BACKWARDS for doing extra work.
   */
  optional?: boolean;
  /** Nothing local can observe this — the operator ticks it off themselves. */
  manual?: boolean;
  /** Extra live context ("103 items imported"). */
  note?: string;
}

/** Everything the checklist can observe about the machine. */
export interface SetupFacts {
  incomingPathSet: boolean;
  incomingPathExists: boolean;
  incomingPath: string;
  workerInstalled: boolean;
  hasMarketplaceAccount: boolean;
  hasSecondaryDisplay: boolean;
  visionEnabled: boolean;
  visionInstalled: boolean;
  itemCount: number;
  readyCount: number;
  uploadedCount: number;
  /** Step ids the operator has ticked off by hand. */
  acknowledged: string[];
}

export function buildSetupSteps(f: SetupFacts): SetupStep[] {
  const ack = new Set(f.acknowledged ?? []);
  const steps: SetupStep[] = [];

  steps.push({
    id: "worker",
    title: "Install the photo worker",
    detail:
      "Use Install photo worker below in a supported desktop build, or run “Setup Black Cat Agent.cmd” beside the executable. " +
      "Setup downloads a private Python, photo tools and browser files. Finish it before processing photos or connecting accounts.",
    state: f.workerInstalled ? "done" : "todo",
    blocking: true,
    manual: true,
    note: f.workerInstalled ? "Photo tools verified. Check a real photo batch next." : "Not verified yet — finish or repair worker setup, then re-check.",
  });

  steps.push({
    id: "folders",
    title: "Point the app at your photo folder",
    detail:
      "Review Settings → Folders; the default paths are suitable for starting. Dashboard → Upload folder copies JPEGs from your " +
      "source folder into Incoming. Keep camera originals separately: Incoming is a working queue, not your only photo backup.",
    state: f.incomingPathSet && f.incomingPathExists ? "done" : "todo",
    href: "/settings",
    action: "Open Settings",
    blocking: true,
    note: !f.incomingPathSet
      ? "Not set."
      : f.incomingPathExists
        ? f.incomingPath
        : `${f.incomingPath} — that folder does not exist yet.`,
  });

  steps.push({
    id: "marketplace-accounts",
    title: "Connect your marketplaces",
    detail: "Open Settings, choose your selling platforms, and connect their browser accounts. Black Cat posts through your own signed-in browser.",
    state: f.hasMarketplaceAccount ? "done" : "todo",
    href: "/settings#marketplaces", action: "Connect accounts", blocking: true,
    note: f.hasMarketplaceAccount ? "An enabled marketplace has a locally confirmed account link. Posting checks the browser session again." : "Link at least one enabled marketplace account in Settings.",
  });
  steps.push({
    id: "second-monitor", title: "Connect your second monitor",
    detail: "Black Cat opens marketplace windows on your second monitor, at normal size, while leaving your primary workspace alone.",
    state: f.hasSecondaryDisplay ? "done" : "todo", href: "/settings", action: "Open Settings", blocking: true,
    note: f.hasSecondaryDisplay ? "The last display report detected a second monitor. Browser tasks check placement again before opening." : "Browser tasks wait until a second monitor is connected.",
  });

  steps.push({
    id: "ebay-policy",
    title: "Create an eBay shipping policy that covers garment weights",
    detail:
      "If using eBay, create suitable shipping, return and payment policies in your selling account, then select them in Settings. " +
      "Check garment weights and destinations. Skip this step when you are not using eBay; it stays in this first-listing checklist.",
    state: ack.has("ebay-policy") ? "done" : "todo",
    blocking: false,
    manual: true,
    note: "Tick this once you have made one — the app cannot see your eBay account.",
  });

  steps.push({
    id: "vision",
    title: "Turn on local AI identification (optional)",
    detail:
      "Fills in brand, size, colour, pattern and item type from the photos so you are " +
      "correcting rather than typing. It needs a compatible NVIDIA GPU and separately installed model/runtime files. " +
      "Leave it off if unavailable, enter details manually, and review all suggestions against your photos.",
    state: f.visionEnabled && f.visionInstalled ? "done" : "todo",
    href: "/settings",
    action: "Open Settings",
    blocking: false,
    optional: true,
    note: !f.visionInstalled
      ? "Not installed — skip it if you have no NVIDIA GPU."
      : f.visionEnabled ? "Local runtime ready and AI enabled. Review every suggestion against the photos." : "Local runtime and model files found; AI is switched off.",
  });

  steps.push({
    id: "first-batch",
    title: "Photograph and import your first batch",
    detail:
      "Take at least three garment photos, then a SKU marker as the LAST photo of that item. " +
      "The marker closes its photo group. Choose Upload folder on Dashboard or drop the JPEGs there; " +
      "use Process them now only for photos already waiting in Incoming.",
    state: f.itemCount > 0 ? "done" : "todo",
    href: "/",
    action: "Open the Dashboard",
    blocking: false,
    note: f.itemCount > 0 ? `${f.itemCount} item(s) imported.` : "Nothing imported yet.",
  });

  steps.push({
    id: "first-listing",
    title: "Review and crosslist your first piece",
    detail: "Review the photos, details, and price. Approved pieces appear in Crosslisting, where you choose marketplaces and start a run or enable Auto Run.",
    state: f.uploadedCount > 0 ? "done" : "todo",
    href: "/review",
    action: "Open Review",
    blocking: false,
    note: f.uploadedCount > 0
      ? `${f.uploadedCount} item(s) listed.`
      : f.readyCount > 0 ? `${f.readyCount} item(s) ready to upload.` : "Nothing uploaded yet.",
  });

  return steps;
}

/** Progress across the steps that are not optional. */
export function setupProgress(steps: SetupStep[]): { done: number; total: number; complete: boolean } {
  const counted = steps.filter((s) => !s.optional);
  const done = counted.filter((s) => s.state === "done").length;
  return { done, total: counted.length, complete: done === counted.length };
}

/** The steps that genuinely stop the app being usable. Drives the dashboard banner. */
export function blockingSteps(steps: SetupStep[]): SetupStep[] {
  return steps.filter((s) => s.blocking && s.state !== "done");
}
