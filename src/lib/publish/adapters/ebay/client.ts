// eBay HTTP client (§45.13, §45.23) — the only file that talks to eBay.
//
// Entirely OFFICIAL surfaces: OAuth2 (user consent + refresh), the Sell
// Inventory API, the Taxonomy API, and Trading API UploadSiteHostedPictures for
// getting local photo files onto eBay Picture Services (the Inventory API only
// accepts hosted image URLs, and EPS is eBay's own host for exactly this).
// No scraping, no session reuse, no automation of ebay.com pages.
//
// Credentials: the developer keyset + a REVOCABLE OAuth refresh token, stored in
// app settings like every other per-machine credential-adjacent value. Raw eBay
// account passwords are never seen, asked for, or stored. Tokens are never
// logged (§45.22).

import fs from "node:fs/promises";
import path from "node:path";
import type { EbayPublishConfig } from "../../../types.ts";
import { PublishError } from "../../types.ts";

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
];

export function ebayHosts(env: EbayPublishConfig["env"]) {
  const sandbox = env !== "production";
  return {
    api: sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com",
    auth: sandbox ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com",
    itemBase: sandbox ? "https://sandbox.ebay.com/itm/" : "https://www.ebay.com/itm/",
  };
}

/** The one-time consent URL the operator opens in their own browser. */
export function consentUrl(cfg: EbayPublishConfig): string {
  const h = ebayHosts(cfg.env);
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.ruName,
    response_type: "code",
    scope: EBAY_SCOPES.join(" "),
  });
  return `${h.auth}/oauth2/authorize?${q}`;
}

function basicAuth(cfg: EbayPublishConfig): string {
  return "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
}

async function tokenRequest(cfg: EbayPublishConfig, body: URLSearchParams): Promise<Record<string, unknown>> {
  const h = ebayHosts(cfg.env);
  const res = await fetch(`${h.api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basicAuth(cfg), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc = String(json.error_description ?? json.error ?? `HTTP ${res.status}`);
    // invalid_grant = expired/revoked consent — a human has to re-authorize.
    throw new PublishError(`eBay token: ${desc}`, desc.includes("invalid_grant") ? "requires_review" : "retryable");
  }
  return json;
}

/** Exchange the pasted consent code for a refresh token (one-time setup). */
export async function exchangeConsentCode(cfg: EbayPublishConfig, code: string): Promise<{ refreshToken: string; refreshTokenExpiresAt: string }> {
  const json = await tokenRequest(cfg, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.ruName,
  }));
  const seconds = Number(json.refresh_token_expires_in ?? 0);
  return {
    refreshToken: String(json.refresh_token ?? ""),
    refreshTokenExpiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
  };
}

// Access tokens live ~2 hours; cache per keyset+env, refreshed 60s early.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAccessToken(cfg: EbayPublishConfig): Promise<string> {
  if (!cfg.refreshToken) throw new PublishError("eBay is not authorized yet — run the Connect flow in Publish settings", "requires_review");
  const key = `${cfg.env}:${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const json = await tokenRequest(cfg, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    scope: EBAY_SCOPES.join(" "),
  }));
  const token = String(json.access_token ?? "");
  tokenCache.set(key, { token, expiresAt: Date.now() + Number(json.expires_in ?? 7200) * 1000 });
  return token;
}

/** REST call against the Sell/Commerce APIs with classified failures. */
export async function ebayApi(
  cfg: EbayPublishConfig,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const token = await getAccessToken(cfg);
  const h = ebayHosts(cfg.env);
  const res = await fetch(`${h.api}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const errors = json.errors as { message?: string; longMessage?: string; errorId?: number }[] | undefined;
    const msg = errors?.map((e) => e.longMessage || e.message).filter(Boolean).join("; ")
      || `HTTP ${res.status} on ${apiPath}`;
    if (res.status === 429 || res.status >= 500) throw new PublishError(`eBay: ${msg}`, "retryable");
    if (res.status === 401) {
      tokenCache.delete(`${cfg.env}:${cfg.clientId}`); // stale token — refresh next call
      throw new PublishError(`eBay: ${msg}`, "retryable");
    }
    // 400/403/404/409: the request itself is wrong for this item — a human call.
    throw new PublishError(`eBay: ${msg}`, "requires_review");
  }
  return { status: res.status, json, headers: res.headers };
}

// -- Taxonomy: title/type -> leaf category ---------------------------------

const categoryCache = new Map<string, string>();

export async function suggestCategoryId(cfg: EbayPublishConfig, query: string): Promise<string> {
  const key = `${cfg.env}:${query.toLowerCase()}`;
  const hit = categoryCache.get(key);
  if (hit) return hit;
  const { json } = await ebayApi(
    cfg, "GET",
    `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`,
  );
  const suggestions = json.categorySuggestions as
    | { category?: { categoryId?: string }; categoryTreeNodeLevel?: number }[]
    | undefined;
  const id = suggestions?.[0]?.category?.categoryId;
  if (!id) throw new PublishError(`eBay: no category suggestion for "${query}" — set the item type`, "requires_review");
  categoryCache.set(key, id);
  return id;
}

// -- eBay Picture Services upload (Trading API) ----------------------------

const IMG_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};

/**
 * Upload one local photo file to EPS; returns the hosted URL the Inventory API
 * needs. Multipart per the Trading API contract: an XML part then the binary.
 */
export async function uploadPictureToEPS(cfg: EbayPublishConfig, filePath: string): Promise<string> {
  const token = await getAccessToken(cfg);
  const h = ebayHosts(cfg.env);
  const data = await fs.readFile(filePath);
  const name = path.basename(filePath);
  const mime = IMG_MIME[path.extname(name).toLowerCase()] ?? "image/jpeg";
  const boundary = `----blackcat${Date.now().toString(36)}`;
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<PictureName>${name.replace(/[<>&]/g, "")}</PictureName>` +
    `</UploadSiteHostedPicturesRequest>`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\n` +
      `Content-Type: text/xml;charset=utf-8\r\n\r\n${xml}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`${h.api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new PublishError(`eBay picture upload: HTTP ${res.status}`, "retryable");
  const ack = /<Ack>([^<]+)<\/Ack>/.exec(text)?.[1];
  const url = /<FullURL>([^<]+)<\/FullURL>/.exec(text)?.[1];
  if ((ack === "Success" || ack === "Warning") && url) {
    // EPS URLs come back XML-escaped.
    return url.replace(/&amp;/g, "&");
  }
  const err = /<LongMessage>([^<]+)<\/LongMessage>/.exec(text)?.[1]
    ?? /<ShortMessage>([^<]+)<\/ShortMessage>/.exec(text)?.[1]
    ?? "unrecognized response";
  throw new PublishError(`eBay picture upload (${name}): ${err}`, "retryable");
}
