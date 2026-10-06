// The five marketplace routes use native browser workers. The official eBay API
// adapter stays unregistered and its authorization route is retired. Browser
// account sessions supply posting access; no marketplace API credentials are required.

import type { AppSettingsData } from "../../types.ts";
import type { MarketplaceAdapter } from "../types.ts";
import { depopAdapter } from "./depop/index.ts";
import { poshmarkAdapter } from "./poshmark/index.ts";
import { etsyAdapter } from "./etsy/index.ts";
import { ebayBrowserAdapter } from "./ebay-browser/index.ts";
import { mercariAdapter } from "./mercari/index.ts";

export const ADAPTERS: MarketplaceAdapter[] = [
  depopAdapter,
  ebayBrowserAdapter,
  etsyAdapter,
  poshmarkAdapter,
  mercariAdapter,
];

export function getAdapter(id: string): MarketplaceAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

/** Marketplaces a run may target right now, with reasons for the rest. */
export function availableMarketplaces(settings: AppSettingsData) {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    implemented: a.implemented,
    ...a.availability(settings),
  }));
}
