import type { MarketplaceAdapter } from "../../types.ts";
import { PublishError } from "../../types.ts";
import { prisma } from "../../../db.ts";
import { workerPythonExists } from "../../../worker.ts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "../../../browserCoordinator.ts";
import { checkDirectUploadOverlap } from "../../listingGuards.ts";
import { runBrowserWorker } from "../../browserWorker.ts";
import { listingIdentity } from "../../attempts.ts";
import { ebayBrowserValidate, ebayBrowserError, ebayTitle } from "./mapping.ts";

export const ebayBrowserAdapter: MarketplaceAdapter = {
  id: "ebay", name: "eBay", implemented: true,
  availability(settings) {
    if (!settings.publish?.ebayBrowser?.enabled) return { configured: false, reason: "Enable eBay browser posting in Settings > Marketplace accounts" };
    if (!workerPythonExists(settings)) return { configured: false, reason: "Worker Python is not installed" };
    return { configured: true, reason: null };
  },
  validate: ebayBrowserValidate,
  async publish(listing, settings) {
    if (!claimBrowser(`ebay post ${listing.sku}`)) throw new PublishError(browserBusyMessage(), "retryable", true);
    try {
      const overlap = await checkDirectUploadOverlap(prisma, listing.itemId, settings.publish?.allowNiftyOverlap);
      if (overlap) throw new PublishError(overlap, "requires_review", true);
      const { done } = await runBrowserWorker(settings, { ...listing, title: ebayTitle(listing.title) }, { marketplace: "ebay", mode: settings.publish?.ebayBrowser?.autoPost === false ? "fill" : "post" });
      const identity = done?.outcome === "posted" && done.url ? listingIdentity("ebay", done.url) : null;
      if (identity) return { ok: true, externalListingId: identity.id, externalUrl: identity.url, publishedTitle: ebayTitle(listing.title), publishedPrice: listing.price };
      throw ebayBrowserError(done);
    } finally { releaseBrowser(); }
  },
};
