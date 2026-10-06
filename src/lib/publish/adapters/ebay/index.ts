// EbayPublisher (§45.13) — the first real adapter.
//
// Publish sequence (all official Sell APIs):
//   photos -> EPS URLs -> PUT inventory_item/{sku} -> offer -> publishOffer
//
// Idempotency comes from eBay's own model: the inventory item is keyed by OUR
// SKU (a re-run overwrites, never duplicates), and an offer that already exists
// for the SKU is updated in place. Only publishOffer creates something visible,
// and the queue's MarketplaceListing check stops a second publish before this
// adapter is even called.

import type { AppSettingsData } from "../../../types.ts";
import type {
  AdapterAvailability, CanonicalListing, MarketplaceAdapter, PublishSuccess, ValidationIssue,
} from "../../types.ts";
import {
  buildInventoryItemPayload, buildOfferPayload, categoryQuery, ebayValidate,
} from "./mapping.ts";
import { ebayApi, ebayHosts, suggestCategoryId, uploadPictureToEPS } from "./client.ts";

export const ebayAdapter: MarketplaceAdapter = {
  id: "ebay",
  name: "eBay",
  implemented: true,

  availability(settings: AppSettingsData): AdapterAvailability {
    const cfg = settings.publish?.ebay;
    if (!cfg?.enabled) return { configured: false, reason: "not enabled in Publish settings" };
    const missing: string[] = [];
    if (!cfg.clientId || !cfg.clientSecret || !cfg.ruName) missing.push("developer keyset (client ID / secret / RuName)");
    if (!cfg.refreshToken) missing.push("account authorization (Connect eBay)");
    if (!cfg.fulfillmentPolicyId || !cfg.paymentPolicyId || !cfg.returnPolicyId) missing.push("business policy IDs");
    if (!cfg.merchantLocationKey) missing.push("inventory location key");
    if (missing.length) return { configured: false, reason: `missing: ${missing.join(", ")}` };
    return { configured: true, reason: null };
  },

  validate(listing: CanonicalListing, settings: AppSettingsData): ValidationIssue[] {
    return ebayValidate(listing, settings.publish?.ebay);
  },

  async publish(listing: CanonicalListing, settings: AppSettingsData): Promise<PublishSuccess> {
    const cfg = settings.publish!.ebay!;

    // 1) Photos -> EPS. Sequential on purpose (§45.20): reliability over speed.
    const imageUrls: string[] = [];
    for (const photo of listing.photos) {
      imageUrls.push(await uploadPictureToEPS(cfg, photo.path));
    }

    // 2) The inventory item — SKU-keyed PUT, idempotent by construction.
    await ebayApi(
      cfg, "PUT",
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(listing.sku)}`,
      buildInventoryItemPayload(listing, imageUrls),
    );

    // 3) Category, then the offer. If an offer already exists for this SKU
    //    (an earlier attempt that failed later in the sequence), update it
    //    instead of erroring — that is what makes retries safe.
    const categoryId = await suggestCategoryId(cfg, categoryQuery(listing));
    const offerPayload = buildOfferPayload(listing, cfg, categoryId);
    let offerId: string;
    try {
      const created = await ebayApi(cfg, "POST", "/sell/inventory/v1/offer", offerPayload);
      offerId = String(created.json.offerId ?? "");
    } catch (e) {
      // "Offer entity already exists" — recover the existing offer and update it.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg)) throw e;
      const { json } = await ebayApi(
        cfg, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(listing.sku)}`,
      );
      const offers = json.offers as { offerId?: string; status?: string }[] | undefined;
      offerId = String(offers?.[0]?.offerId ?? "");
      if (!offerId) throw e;
      await ebayApi(cfg, "PUT", `/sell/inventory/v1/offer/${offerId}`, offerPayload);
    }
    if (!offerId) throw new Error("eBay: offer creation returned no offerId");

    // 4) Publish — the one step that makes a live listing.
    const published = await ebayApi(cfg, "POST", `/sell/inventory/v1/offer/${offerId}/publish`);
    const listingId = String(published.json.listingId ?? "");
    if (!listingId) throw new Error("eBay: publish returned no listingId");

    return {
      ok: true,
      externalListingId: listingId,
      externalUrl: `${ebayHosts(cfg.env).itemBase}${listingId}`,
    };
  },
};
