import type { PublishSettings } from "../types.ts";
import { uploadHistorySummary } from "../pastUploads.ts";

export const MERCARI_SALE_GOAL = 5;
export interface MercariSaleItem {
  id: number; sku: string; status: string; niftyStatus: string; platformSold: string | null;
  marketplaceListings: { marketplace: string; status: string }[];
}

export function mercariGoal(limit: PublishSettings["mercariListingLimit"], items: MercariSaleItem[]) {
  const sales = items.filter(item => item.status === "Sold" && uploadHistorySummary(item).soldPlatforms.includes("Mercari"))
    .map(item => ({ id: item.id, sku: item.sku, confirmed: limit?.confirmedSaleSkus.includes(item.sku) ?? false }));
  const completed = new Set(sales.filter(item => item.confirmed).map(item => item.sku)).size;
  return { tracking: !!limit, blocked: limit?.blocked ?? false, target: MERCARI_SALE_GOAL, completed,
    remaining: Math.max(0, MERCARI_SALE_GOAL - completed), sales };
}

export function validateMercariGoalPatch(body: unknown, items: MercariSaleItem[]): PublishSettings["mercariListingLimit"] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Mercari goal settings.");
  const patch = body as Record<string, unknown>;
  if (typeof patch.blocked !== "boolean" || !Array.isArray(patch.confirmedSaleSkus) ||
      patch.confirmedSaleSkus.some(sku => typeof sku !== "string")) throw new Error("Choose completed Mercari sales and the posting restriction status.");
  const confirmedSaleSkus = [...new Set(patch.confirmedSaleSkus as string[])];
  const available = new Set(mercariGoal(undefined, items).sales.map(item => item.sku));
  if (confirmedSaleSkus.some(sku => !available.has(sku))) throw new Error("Only items currently recorded as sold on Mercari can count. Refresh the sales list.");
  if (!patch.blocked && confirmedSaleSkus.length < MERCARI_SALE_GOAL) throw new Error("Confirm five completed Mercari sales before lifting this posting restriction.");
  return { blocked: patch.blocked, confirmedSaleSkus };
}

export function mercariPostingBlock(publish: PublishSettings | undefined): string | null {
  return publish?.mercariListingLimit?.blocked
    ? "Mercari uploads are paused for the five-sale goal. Confirm completed sales and the lifted restriction in Settings > Mercari. Existing listings are still monitored."
    : null;
}
