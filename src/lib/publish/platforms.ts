export const BROWSER_MARKETPLACES = ["depop", "ebay", "etsy", "poshmark", "mercari"] as const;
export type BrowserMarketplace = typeof BROWSER_MARKETPLACES[number];

export const MARKETPLACE_NAMES: Record<BrowserMarketplace, string> = {
  depop: "Depop", ebay: "eBay", etsy: "Etsy", poshmark: "Poshmark", mercari: "Mercari",
};

export function isBrowserMarketplace(value: string): value is BrowserMarketplace {
  return BROWSER_MARKETPLACES.some((marketplace) => marketplace === value);
}
