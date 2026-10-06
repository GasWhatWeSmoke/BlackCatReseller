import type { MarketplaceAdapter } from "../../types.ts";
import { PublishError } from "../../types.ts";
import { prisma } from "../../../db.ts";
import { workerPythonExists } from "../../../worker.ts";
import { claimBrowser, releaseBrowser, browserBusyMessage } from "../../../browserCoordinator.ts";
import { checkDirectUploadOverlap } from "../../listingGuards.ts";
import { runBrowserWorker } from "../../browserWorker.ts";
import { listingIdentity } from "../../attempts.ts";
import { mercariValidate, mercariPublicationError } from "./mapping.ts";
import { mercariPostingBlock } from "../../mercariGoal.ts";

export const mercariAdapter: MarketplaceAdapter = {
  id: "mercari", name: "Mercari", implemented: true,
  availability(settings) {
    const blocked = mercariPostingBlock(settings.publish);
    if (blocked) return { configured: false, reason: blocked };
    if (!settings.publish?.mercari?.enabled) return { configured: false, reason: "Enable Mercari in Crosslisting > Accounts & monitoring" };
    if (!workerPythonExists(settings)) return { configured: false, reason: "Worker Python is not installed" };
    if (!/^\d{5}$/.test(settings.mercariShipFrom?.zip ?? "")) return { configured: false, reason: "Set your Mercari ship-from ZIP in Settings > Shipping" };
    return { configured: true, reason: null };
  },
  validate: mercariValidate,
  async publish(listing, settings) {
    const blocked = mercariPostingBlock(settings.publish);
    if (blocked) throw new PublishError(blocked, "requires_review", true);
    if (!claimBrowser(`mercari post ${listing.sku}`)) throw new PublishError(browserBusyMessage(), "retryable", true);
    try {
      const overlap = await checkDirectUploadOverlap(prisma, listing.itemId, settings.publish?.allowNiftyOverlap);
      if (overlap) throw new PublishError(overlap, "requires_review", true);
      const { done } = await runBrowserWorker(settings, listing, { marketplace: "mercari", mode: settings.publish?.mercari?.autoPost === false ? "fill" : "post" });
      const identity = done?.outcome === "posted" && done.url ? listingIdentity("mercari", done.url) : null;
      if (identity) return { ok: true, externalListingId: identity.id, externalUrl: identity.url, publishedTitle: listing.title, publishedPrice: listing.price };
      throw mercariPublicationError(done);
    } finally { releaseBrowser(); }
  },
};
