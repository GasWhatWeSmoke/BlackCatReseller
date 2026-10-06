// DepopPublisher (§45.14) — the first BROWSER adapter, and the template for the
// eBay/Mercari/Poshmark ones that follow.
//
// Depop has no public listing API, so this is user-authorized assisted posting:
// the adapter spawns the Python worker (post_depop.py), which drives a visible
// Chromium on the operator's own logged-in profile — the same safety contract as
// the Nifty assist. The queue neither knows nor cares that a browser is
// involved; it sees a MarketplaceAdapter like any other.

import fs from "node:fs";
import path from "node:path";
import type { AppSettingsData } from "../../../types.ts";
import type {
  AdapterAvailability, CanonicalListing, MarketplaceAdapter, PublishSuccess, ValidationIssue,
} from "../../types.ts";
import { PublishError } from "../../types.ts";
import { workerPythonExists } from "../../../worker.ts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "../../../browserCoordinator.ts";
import { depopValidate, depopPublicationError } from "./mapping.ts";
import { runBrowserWorker } from "../../browserWorker.ts";
import { prisma } from "../../../db.ts";
import { checkDirectUploadOverlap } from "../../listingGuards.ts";
import { browserAccountStatus, browserLoginInProgress, confirmBrowserAccountLogin, startBrowserAccountLogin } from "../../browserAccounts.ts";

function loggedInMarkerExists(settings: AppSettingsData): boolean {
  try {
    return fs.existsSync(path.join(settings.dataRoot, "depop-login-ok.json"));
  } catch {
    return false;
  }
}

export function depopLoginInProgress(): boolean {
  return browserLoginInProgress("depop");
}

export function depopLoginAwaitingConfirmation(settings: AppSettingsData): boolean {
  return browserAccountStatus(settings, "depop").awaitingConfirmation;
}

/** Launch one manual, non-automated login window. A second click cannot open a
 *  competing process on the same Chrome profile. */
export function launchDepopLogin(settings: AppSettingsData): boolean {
  return startBrowserAccountLogin(settings, "depop").ok;
}

/** The browser is deliberately unobserved during login. The operator confirms
 *  success after closing it; posting still verifies the session on the sell page. */
export function confirmDepopLogin(settings: AppSettingsData): { ok: boolean; error?: string } {
  return confirmBrowserAccountLogin(settings, "depop");
}

export const depopAdapter: MarketplaceAdapter = {
  id: "depop",
  name: "Depop",
  implemented: true,

  availability(settings: AppSettingsData): AdapterAvailability {
    if (!settings.publish?.depop?.enabled) return { configured: false, reason: "not enabled in Publish settings" };
    if (!workerPythonExists(settings)) return { configured: false, reason: "worker Python not installed — run Setup Black Cat Agent" };
    if (!loggedInMarkerExists(settings)) return { configured: false, reason: "not linked — use Link Depop under Crosslisting → Accounts & monitoring" };
    return { configured: true, reason: null };
  },

  validate(listing: CanonicalListing): ValidationIssue[] {
    return depopValidate(listing);
  },

  async publish(listing: CanonicalListing, settings: AppSettingsData): Promise<PublishSuccess> {
    // One automation browser at a time on this machine — same mutex as the Nifty
    // assist/edit/sync, so two Chromiums can never fight over the screen.
    if (!claimBrowser(`depop post ${listing.sku}`)) {
      throw new PublishError(browserBusyMessage(), "retryable", true);
    }
    try {
      const overlap = await checkDirectUploadOverlap(prisma, listing.itemId, settings.publish?.allowNiftyOverlap);
      if (overlap) throw new PublishError(overlap, "requires_review", true);
      const mode = settings.publish?.depop?.autoPost === false ? "fill" : "post";
      const { done } = await runBrowserWorker(settings, listing, { marketplace: "depop", mode });
      if (done?.outcome === "posted" && done.url) {
        const id = /\/products\/([^/?#]+)/.exec(done.url)?.[1] ?? done.url;
        return { ok: true, externalListingId: id, externalUrl: done.url };
      }
      throw depopPublicationError(done);
    } finally {
      releaseBrowser();
    }
  },
};
