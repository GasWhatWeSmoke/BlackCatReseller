import type { MarketplaceAdapter } from "../../types.ts";
import { PublishError } from "../../types.ts";
import { prisma } from "../../../db.ts";
import { workerPythonExists } from "../../../worker.ts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "../../../browserCoordinator.ts";
import { runBrowserWorker } from "../../browserWorker.ts";
import { checkDirectUploadOverlap } from "../../listingGuards.ts";
import { listingIdentity } from "../../attempts.ts";
import { etsyValidate, etsyPublicationError } from "./mapping.ts";

export const etsyAdapter: MarketplaceAdapter = {
  id: "etsy", name: "Etsy", implemented: true,
  availability(settings) {
    if (!settings.publish?.etsy?.enabled) return { configured: false, reason: "Enable Etsy direct posting in Settings > Marketplace accounts" };
    if (!workerPythonExists(settings)) return { configured: false, reason: "Worker Python is not installed" };
    if (!settings.publish.etsy.shippingProfileName?.trim()) return { configured: false, reason: "Choose the existing Etsy shipping profile in Settings" };
    return { configured: true, reason: null };
  },
  validate: etsyValidate,
  async publish(listing, settings) {
    if (!claimBrowser(`etsy post ${listing.sku}`)) throw new PublishError(browserBusyMessage(), "retryable", true);
    try {
      const overlap = await checkDirectUploadOverlap(prisma, listing.itemId, settings.publish?.allowNiftyOverlap);
      if (overlap) throw new PublishError(overlap, "requires_review", true);
      const mode = settings.publish?.etsy?.autoPost === false ? "fill" : "post";
      const { done } = await runBrowserWorker(settings, listing, { marketplace: "etsy", mode });
      const identity = done?.outcome === "posted" && done.url ? listingIdentity("etsy", done.url) : null;
      if (identity) return { ok: true, externalListingId: identity.id, externalUrl: identity.url };
      throw etsyPublicationError(done);
    } finally { releaseBrowser(); }
  },
};
