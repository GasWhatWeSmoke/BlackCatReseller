import { NextRequest, NextResponse } from "next/server";
import { getRequiredSettings, updateSettings } from "@/lib/settings";
import type { EbayPublishConfig, PublishSettings } from "@/lib/types";
import { availableMarketplaces } from "@/lib/publish/adapters/registry";
import { unlistedBrands } from "@/lib/publish/unlistedBrands";
import { checkMarketplaceExpectation, MarketplacePreferencesConflict } from '@/lib/marketplaceDrafts';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Marketplace connection settings (§45.17, §45.23). Secrets are WRITE-ONLY over
// this API: reads report presence, never values, so a screenshot of the Publish
// page can never leak a keyset and the browser never holds the secret.
function redact(publish: PublishSettings | undefined) {
  const ebay = publish?.ebay;
  return {
    ebay: ebay
      ? {
          enabled: ebay.enabled,
          env: ebay.env,
          clientId: ebay.clientId ?? "",
          hasClientSecret: !!ebay.clientSecret,
          ruName: ebay.ruName ?? "",
          authorized: !!ebay.refreshToken,
          refreshTokenExpiresAt: ebay.refreshTokenExpiresAt ?? null,
          fulfillmentPolicyId: ebay.fulfillmentPolicyId ?? "",
          paymentPolicyId: ebay.paymentPolicyId ?? "",
          returnPolicyId: ebay.returnPolicyId ?? "",
          merchantLocationKey: ebay.merchantLocationKey ?? "",
        }
      : null,
    depop: publish?.depop
      ? { enabled: publish.depop.enabled, autoPost: publish.depop.autoPost ?? true, unlistedBrands: publish.depop.unlistedBrands ?? [], boostListings: publish.depop.boostListings ?? false }
      : { enabled: false, autoPost: true, unlistedBrands: [], boostListings: false },
    poshmark: { enabled: publish?.poshmark?.enabled ?? false, autoPost: publish?.poshmark?.autoPost ?? true },
    mercari: { enabled: publish?.mercari?.enabled ?? false, autoPost: publish?.mercari?.autoPost ?? true,
      unlistedBrands: publish?.mercari?.unlistedBrands ?? [],
      unisexDepartment: publish?.mercari?.unisexDepartment ?? "Women", shippingMode: publish?.mercari?.shippingMode ?? "buyer_label" },
    etsy: { enabled: publish?.etsy?.enabled ?? false, autoPost: publish?.etsy?.autoPost ?? true,
      shippingProfileName: publish?.etsy?.shippingProfileName ?? "", autoRenew: publish?.etsy?.autoRenew ?? false },
    ebayBrowser: { enabled: publish?.ebayBrowser?.enabled ?? false, autoPost: publish?.ebayBrowser?.autoPost ?? true,
      generalAdRate: publish?.ebayBrowser?.generalAdRate ?? null,
      shippingPolicyName: publish?.ebayBrowser?.shippingPolicyName ?? "", returnPolicyName: publish?.ebayBrowser?.returnPolicyName ?? "", paymentPolicyName: publish?.ebayBrowser?.paymentPolicyName ?? "" },
    pacingSeconds: publish?.pacingSeconds ?? 8,
    maxAttempts: publish?.maxAttempts ?? 4,
    relistPricing: publish?.relistPricing ?? "reviewed",
    allowNiftyOverlap: publish?.allowNiftyOverlap ?? false,
  };
}

export async function GET() {
  try {
    const settings = await getRequiredSettings();
    return NextResponse.json({ workspace: settings.dataRoot, publish: redact(settings.publish), marketplaces: availableMarketplaces(settings) });
  } catch {
    return NextResponse.json({error:'Saved posting settings could not be loaded. Retry before changing marketplace preferences.'},{status:503});
  }
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Expected a settings object" }, { status: 400 });
  try {
  const saved = await updateSettings(settings => {
  checkMarketplaceExpectation(settings.dataRoot, redact(settings.publish), body);
  const current: PublishSettings = settings.publish ?? {};
  const next: PublishSettings = { ...current };
  const approvedBrands: Partial<Record<"depop" | "mercari", string[]>> = {};
  try {
    for (const market of ["depop", "mercari"] as const) {
      if (body[market] && typeof body[market] === "object") {
        approvedBrands[market] = unlistedBrands(body[market] as Record<string, unknown>, current[market]?.unlistedBrands);
      }
    }
  } catch (error) {
    throw new PublishSettingsInputError((error as Error).message);
  }

  if (body.ebay && typeof body.ebay === "object") {
    const patch = body.ebay as Partial<EbayPublishConfig>;
    const prev = current.ebay;
    const env = patch.env === "production" ? "production" : patch.env === "sandbox" ? "sandbox" : prev?.env ?? "sandbox";
    next.ebay = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : prev?.enabled ?? false,
      env,
      clientId: typeof patch.clientId === "string" ? patch.clientId.trim() : prev?.clientId ?? "",
      // Secret is write-only: an empty/absent value KEEPS the stored one.
      clientSecret: typeof patch.clientSecret === "string" && patch.clientSecret.trim()
        ? patch.clientSecret.trim() : prev?.clientSecret ?? "",
      ruName: typeof patch.ruName === "string" ? patch.ruName.trim() : prev?.ruName ?? "",
      refreshToken: prev?.refreshToken,             // only the OAuth route writes these
      refreshTokenExpiresAt: prev?.refreshTokenExpiresAt,
      fulfillmentPolicyId: typeof patch.fulfillmentPolicyId === "string" ? patch.fulfillmentPolicyId.trim() : prev?.fulfillmentPolicyId,
      paymentPolicyId: typeof patch.paymentPolicyId === "string" ? patch.paymentPolicyId.trim() : prev?.paymentPolicyId,
      returnPolicyId: typeof patch.returnPolicyId === "string" ? patch.returnPolicyId.trim() : prev?.returnPolicyId,
      merchantLocationKey: typeof patch.merchantLocationKey === "string" ? patch.merchantLocationKey.trim() : prev?.merchantLocationKey,
    };
    // A keyset change invalidates the old authorization — matching token first.
    if (prev && (next.ebay.clientId !== prev.clientId || next.ebay.env !== prev.env)) {
      next.ebay.refreshToken = undefined;
      next.ebay.refreshTokenExpiresAt = undefined;
    }
  }
  if (body.depop && typeof body.depop === "object") {
    const patch = body.depop as { enabled?: unknown; autoPost?: unknown; boostListings?: unknown };
    if ("boostListings" in patch && typeof patch.boostListings !== "boolean") throw new PublishSettingsInputError("Depop boost setting must be true or false");
    next.depop = {
      unlistedBrands: approvedBrands.depop,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.depop?.enabled ?? false,
      autoPost: typeof patch.autoPost === "boolean" ? patch.autoPost : current.depop?.autoPost ?? true,
      boostListings: typeof patch.boostListings === "boolean" ? patch.boostListings : current.depop?.boostListings ?? false,
    };
  }
  if (body.poshmark && typeof body.poshmark === "object") {
    const patch = body.poshmark as { enabled?: unknown; autoPost?: unknown };
    next.poshmark = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.poshmark?.enabled ?? false,
      autoPost: typeof patch.autoPost === "boolean" ? patch.autoPost : current.poshmark?.autoPost ?? true,
    };
  }
  if (body.mercari && typeof body.mercari === "object") {
    const patch = body.mercari as Record<string, unknown>;
    if ("unisexDepartment" in patch && !["Men", "Women"].includes(String(patch.unisexDepartment))) throw new PublishSettingsInputError("Mercari unisex department must be Men or Women");
    if ("shippingMode" in patch && !["buyer_label", "ship_on_own"].includes(String(patch.shippingMode))) throw new PublishSettingsInputError("Choose a supported Mercari shipping mode");
    next.mercari = {
      unlistedBrands: approvedBrands.mercari,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.mercari?.enabled ?? false,
      autoPost: typeof patch.autoPost === "boolean" ? patch.autoPost : current.mercari?.autoPost ?? true,
      unisexDepartment: (patch.unisexDepartment as "Men" | "Women" | undefined) ?? current.mercari?.unisexDepartment ?? "Women",
      shippingMode: (patch.shippingMode as "buyer_label" | "ship_on_own" | undefined) ?? current.mercari?.shippingMode ?? "buyer_label",
    };
  }
  if (body.etsy && typeof body.etsy === "object") {
    const patch = body.etsy as { enabled?: unknown; autoPost?: unknown; shippingProfileName?: unknown; autoRenew?: unknown };
    if ("shippingProfileName" in patch && (typeof patch.shippingProfileName !== "string" || patch.shippingProfileName.trim().length > 200)) {
      throw new PublishSettingsInputError("Etsy shipping profile name must be at most 200 characters");
    }
    next.etsy = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.etsy?.enabled ?? false,
      autoPost: typeof patch.autoPost === "boolean" ? patch.autoPost : current.etsy?.autoPost ?? true,
      shippingProfileName: typeof patch.shippingProfileName === "string" ? patch.shippingProfileName.trim() : current.etsy?.shippingProfileName ?? "",
      autoRenew: typeof patch.autoRenew === "boolean" ? patch.autoRenew : current.etsy?.autoRenew ?? false,
    };
  }
  if (body.ebayBrowser && typeof body.ebayBrowser === "object") {
    const patch = body.ebayBrowser as Record<string, unknown>;
    const rate = "generalAdRate" in patch ? patch.generalAdRate : current.ebayBrowser?.generalAdRate ?? null;
    if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 2 || rate > 100 || Math.abs(rate * 10 - Math.round(rate * 10)) > 0.000001)) {
      throw new PublishSettingsInputError("Choose a fixed eBay ad rate from 2% to 100%, with at most one decimal, or turn promotion off.");
    }
    const names: Record<string, string> = {};
    for (const key of ["shippingPolicyName", "returnPolicyName", "paymentPolicyName"] as const) {
      if (key in patch && (typeof patch[key] !== "string" || (patch[key] as string).trim().length > 200)) throw new PublishSettingsInputError("eBay policy names must be at most 200 characters");
      names[key] = typeof patch[key] === "string" ? (patch[key] as string).trim() : current.ebayBrowser?.[key] ?? "";
    }
    next.ebayBrowser = { ...names, generalAdRate: rate,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.ebayBrowser?.enabled ?? false,
      autoPost: typeof patch.autoPost === "boolean" ? patch.autoPost : current.ebayBrowser?.autoPost ?? true };
  }
  if ("pacingSeconds" in body) {
    const v = Number(body.pacingSeconds);
    if (!Number.isFinite(v) || v < 2 || v > 300) {
      throw new PublishSettingsInputError("pacingSeconds must be 2–300");
    }
    next.pacingSeconds = Math.round(v);
  }
  if ("maxAttempts" in body) {
    const v = Number(body.maxAttempts);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      throw new PublishSettingsInputError("maxAttempts must be 1–10");
    }
    next.maxAttempts = v;
  }
  if ("allowNiftyOverlap" in body) next.allowNiftyOverlap = body.allowNiftyOverlap === true;
  if ("relistPricing" in body) {
    if (body.relistPricing !== "reviewed" && body.relistPricing !== "preserve_marketplace") {
      throw new PublishSettingsInputError("Choose reviewed or preserved marketplace prices for relisting.");
    }
    next.relistPricing = body.relistPricing;
  }

    return { publish: next };
  });
  return NextResponse.json({ workspace: saved.dataRoot, publish: redact(saved.publish), marketplaces: availableMarketplaces(saved) });
  } catch (error) {
    if (error instanceof MarketplacePreferencesConflict) return NextResponse.json({ error:error.message }, { status:409 });
    if (error instanceof PublishSettingsInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

class PublishSettingsInputError extends Error {}
