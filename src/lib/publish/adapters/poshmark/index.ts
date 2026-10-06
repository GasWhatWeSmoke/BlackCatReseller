import type { MarketplaceAdapter } from "../../types.ts";
import { PublishError } from "../../types.ts";
import { prisma } from "../../../db.ts";
import { workerPythonExists } from "../../../worker.ts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "../../../browserCoordinator.ts";
import { browserAccountStatus } from "../../browserAccounts.ts";
import { runBrowserWorker } from "../../browserWorker.ts";
import { checkDirectUploadOverlap } from "../../listingGuards.ts";
import { listingIdentity } from "../../attempts.ts";
import { poshmarkPublicationError, poshmarkValidate, poshmarkPrice } from "./mapping.ts";

export const poshmarkAdapter: MarketplaceAdapter = {
  id: "poshmark", name: "Poshmark", implemented: true,
  availability(settings) {
    if (!settings.publish?.poshmark?.enabled) return { configured: false, reason: "Enable Poshmark direct posting in Settings > Marketplace accounts" };
    if (!workerPythonExists(settings)) return { configured: false, reason: "Worker Python is not installed" };
    if (!browserAccountStatus(settings, "poshmark").loggedIn) return { configured: false, reason: "Link Poshmark in Settings > Marketplace accounts" };
    return { configured: true, reason: null };
  },
  validate: poshmarkValidate,
  async publish(listing, settings) {
    if (!claimBrowser(`poshmark post ${listing.sku}`)) throw new PublishError(browserBusyMessage(), "retryable", true);
    try {
      const overlap = await checkDirectUploadOverlap(prisma, listing.itemId, settings.publish?.allowNiftyOverlap);
      if (overlap) throw new PublishError(overlap, "requires_review", true);
      const mode = settings.publish?.poshmark?.autoPost === false ? "fill" : "post";
      const { done } = await runBrowserWorker(settings, listing, { marketplace: "poshmark", mode });
      const identity = done?.outcome === "posted" && done.url ? listingIdentity("poshmark", done.url) : null;
      if (identity) return { ok: true, externalListingId: identity.id, externalUrl: identity.url, publishedPrice: poshmarkPrice(listing.price) ?? undefined };
      throw poshmarkPublicationError(done);
    } finally { releaseBrowser(); }
  },
};
