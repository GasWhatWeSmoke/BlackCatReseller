import { listingIdentity } from "./attempts.ts";
import { normalizeSaleFinancials, type SaleFinancials } from "./saleFinancials.ts";

export const SALES_MARKETPLACES = ["depop", "poshmark", "ebay", "etsy", "mercari"] as const;
export type SalesMarketplace = typeof SALES_MARKETPLACES[number];
export interface SaleObservation {
  marketplace: SalesMarketplace;
  receiptId: string;
  reference: string;
  listingId: string;
  listingUrl: string;
  classification: "confirmed_sale" | "requires_review" | "not_sale";
  financials?: SaleFinancials;
}
export interface SalesReport {
  ok: boolean;
  complete: boolean;
  observations: SaleObservation[];
  confirmedReceiptIds: string[];
  reason?: string;
}

export function validReceiptId(marketplace: SalesMarketplace, value: unknown): value is string {
  return typeof value === "string" && (marketplace === "ebay" ? /^\d{2}-\d{5}-\d{5}$/ : marketplace === "poshmark" ? /^[a-f0-9]{24}$/ : marketplace === "mercari" ? /^(?:m\d{9,15}|\d{1,24})$/ : /^\d{1,24}$/).test(value);
}

export function normalizeSaleObservation(marketplace: SalesMarketplace, value: unknown): SaleObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const receiptId = row.receiptId ?? row.orderId;
  const identity = typeof row.listingUrl === "string" ? listingIdentity(marketplace, row.listingUrl) : null;
  if (row.marketplace !== marketplace || !validReceiptId(marketplace, receiptId) || !identity || identity.id !== row.listingId ||
      !["confirmed_sale", "requires_review", "not_sale"].includes(String(row.classification))) return null;
  const reference = marketplace === "depop" ? receiptId : typeof row.reference === "string" ? row.reference
    : validReceiptId("poshmark", row.lineId) ? `${receiptId}/${row.lineId}` : "";
  if (!reference || reference.length > 100 || (marketplace === "poshmark" && !new RegExp(`^${receiptId}/[a-f0-9]{24}$`).test(reference))) return null;
  if (["ebay", "etsy", "mercari"].includes(marketplace) && reference !== `${receiptId}/${identity.id}`) return null;
  const financials = row.classification === "confirmed_sale" ? normalizeSaleFinancials(row.financials) : undefined;
  return { marketplace, receiptId, reference, listingId: identity.id, listingUrl: identity.url,
    ...(financials ? { financials } : {}),
    classification: row.classification as SaleObservation["classification"] };
}

export function parseSalesReport(output: string, marketplace: SalesMarketplace): SalesReport | null {
  if (!SALES_MARKETPLACES.includes(marketplace)) return null;
  const last = [...output.matchAll(new RegExp(`^${marketplace.toUpperCase()}_SALES_DONE (.+)$`, "gm"))].at(-1)?.[1];
  if (!last) return null;
  try {
    const value = JSON.parse(last);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.ok === false) return { ok: false, complete: false, observations: [], confirmedReceiptIds: [],
      reason: typeof value.error === "string" ? value.error.slice(0, 2000) : "Marketplace sales could not be read." };
    if (value.ok !== true || typeof value.complete !== "boolean" || !Array.isArray(value.observations) || value.observations.length > 10000) return null;
    const observations: SaleObservation[] = [];
    const seen = new Set<string>();
    for (const raw of value.observations) {
      const observation = normalizeSaleObservation(marketplace, raw);
      if (!observation) return null;
      const key = `${observation.reference}:${observation.listingId}`;
      if (seen.has(key)) return null;
      seen.add(key); observations.push(observation);
    }
    let confirmedReceiptIds: string[];
    if (marketplace !== "poshmark") {
      if (!Array.isArray(value.confirmedReceiptIds) || !Array.isArray(value.checkedReceiptIds) || !Array.isArray(value.receiptIds) ||
          value.receiptIds.length > 10000 || !value.receiptIds.every((id: unknown) => validReceiptId(marketplace, id)) ||
          value.checkedReceiptIds.some((id: unknown) => !value.receiptIds.includes(id)) ||
          value.confirmedReceiptIds.some((id: unknown) => !value.checkedReceiptIds.includes(id)) ||
          observations.some((row) => !value.checkedReceiptIds.includes(row.receiptId))) return null;
      confirmedReceiptIds = [...new Set<string>(value.confirmedReceiptIds)];
    } else confirmedReceiptIds = [...new Set(observations.map((row) => row.receiptId))].filter((id) =>
      observations.filter((row) => row.receiptId === id).every((row) => row.classification === "confirmed_sale"));
    for (const id of confirmedReceiptIds) {
      const receipt = observations.filter((row) => row.receiptId === id);
      if (!receipt.length || receipt.some((row) => row.classification !== "confirmed_sale")) return null;
    }
    return { ok: true, complete: value.complete, observations, confirmedReceiptIds,
      ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 2000) } : {}) };
  } catch { return null; }
}
