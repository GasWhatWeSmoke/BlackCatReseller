import { draftIdentity, type ItemDraft } from "./itemDrafts.ts";

export interface PriceConfig { style: "down" | "up" | "off"; min: number; max: number }

export function countPricingWork(items: { id: number; createdAt: string }[], drafts: ItemDraft[]): number {
  const keys = new Set(items.map(item => `${item.id}:${item.createdAt}`));
  for (const draft of drafts) {
    const item = draftIdentity(draft.key, "pricing");
    keys.add(`${item.id}:${item.createdAt}`);
  }
  return keys.size;
}

export async function recoverPricingRows<T extends { id: number; createdAt: string; sku: string }>(
  unpriced: T[], drafts: ItemDraft[], readItem: (id: number) => Promise<T | null>,
): Promise<{ rows: T[]; unavailable: { draft: ItemDraft; reason: string }[] }> {
  const rows = new Map(unpriced.map(row => [row.id, row]));
  const unavailable: { draft: ItemDraft; reason: string }[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, drafts.length) }, async () => {
    while (index < drafts.length) {
      const draft = drafts[index++];
      const identity = draftIdentity(draft.key, "pricing");
      try {
        const item = rows.get(identity.id) ?? await readItem(identity.id);
        if (!item || item.id !== identity.id || item.createdAt !== identity.createdAt)
          throw new Error("The original item is no longer available. This local price draft is kept separately.");
        rows.set(item.id, item);
      } catch (error) {
        unavailable.push({ draft, reason: error instanceof Error ? error.message : "The saved item could not be loaded. Your local price draft is kept." });
      }
    }
  }));
  return { rows: [...rows.values()].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.id - b.id), unavailable };
}

export function priceDecision(raw: string, config: PriceConfig, confirmation: string | null) {
  const text = raw.trim();
  if (!text) return { kind: "empty" as const };
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) return { kind: "invalid" as const, message: "Enter a price greater than $0 with at most two decimal places." };
  const value = Number(text);
  // Explicit decimals are the operator's price. Only a whole-number entry uses .99.
  const rounded = config.style !== "off" && !text.includes(".") && Number.isInteger(value) && value >= 1
    ? value + (config.style === "down" ? -0.01 : 0.99) : value;
  const price = Math.round(rounded * 100) / 100;
  if (!Number.isFinite(price) || !Number.isSafeInteger(Math.round(rounded * 100)) || price <= 0)
    return { kind: "invalid" as const, message: "Enter a finite price of at least $0.01." };
  const token = JSON.stringify([text, price, config.min, config.max, config.style]);
  if ((price < config.min || price > config.max) && confirmation !== token)
    return { kind: "confirm" as const, price, token };
  return { kind: "ready" as const, price };
}

export function pricingEligible(item: { status: string; niftyStatus?: string }): boolean {
  return ["Photographed", "Needs Info", "Ready", "Ready for Nifty"].includes(item.status)
    && (item.niftyStatus ?? "Not Uploaded") === "Not Uploaded";
}

export function pricingConfig(value: unknown): PriceConfig {
  const settings = value as Record<string, unknown> | null;
  if (!settings || !["down", "up", "off"].includes(String(settings.priceNinetyNine))
    || typeof settings.priceWarnMin !== "number" || !Number.isFinite(settings.priceWarnMin)
    || typeof settings.priceWarnMax !== "number" || !Number.isFinite(settings.priceWarnMax)
    || settings.priceWarnMin < 0 || settings.priceWarnMax < settings.priceWarnMin)
    throw new Error("Your pricing settings could not be verified. Reload Pricing before saving a price.");
  return { style: settings.priceNinetyNine as PriceConfig["style"], min: settings.priceWarnMin, max: settings.priceWarnMax };
}
