import { listingIdentity } from "./publish/attempts.ts";
import { BROWSER_MARKETPLACES } from "./publish/platforms.ts";
export function researchQuery(item: { brand?: string | null; model?: string | null; itemType?: string | null; size?: string | null }) {
  return [item.brand && !["unknown", "unbranded"].includes(item.brand.toLowerCase()) ? item.brand : null,
    item.model, item.itemType, item.size].filter(Boolean).join(" ").slice(0, 180);
}
export function researchLinks(query: string) {
  const search = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`;
  return { sold: `${search}&LH_Sold=1&LH_Complete=1`, active: search, research: "https://www.ebay.com/sh/research" };
}
export function comparableInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter comparable listing details.");
  const body = value as Record<string, unknown>;
  const match = BROWSER_MARKETPLACES.map(marketplace => ({ marketplace, identity: typeof body.url === "string" ? listingIdentity(marketplace, body.url) : null })).find(row => row.identity);
  if (!match?.identity) throw new Error("Use an exact eBay, Depop, Etsy, Poshmark, or Mercari listing URL.");
  if (body.kind !== "sold" && body.kind !== "active") throw new Error("Identify this as a sold price or an asking price.");
  if (typeof body.price !== "number" || !Number.isFinite(body.price) || body.price <= 0 || body.price > 1_000_000) throw new Error("Enter the actual price shown in USD.");
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 500) throw new Error("Enter the comparable listing's title.");
  if (body.interest != null && (typeof body.interest !== "number" || !Number.isSafeInteger(body.interest) || body.interest < 0)) throw new Error("Interest must be a visible whole-number count, or left blank.");
  if (body.interest != null && body.interestKind !== "likes" && body.interestKind !== "watchers") throw new Error("Identify the visible interest count as likes or watchers.");
  return { marketplace: match.marketplace, url: match.identity.url, listingId: match.identity.id, kind: body.kind,
    price: body.price, title: body.title.trim(), interest: body.interest == null ? null : body.interest,
    interestKind: body.interest == null ? null : body.interestKind as "likes" | "watchers" };
}
