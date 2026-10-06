export const APP_URL = "http://127.0.0.1:41999/browser-link";
export const HOMES = {
  depop: "https://www.depop.com/products/create/",
  ebay: "https://www.ebay.com/sh/ovw",
  etsy: "https://www.etsy.com/your/shops/me/dashboard",
  poshmark: "https://poshmark.com/create-listing",
};

export function trustedSender(sender) {
  return sender?.frameId === 0 && sender?.url === APP_URL && sender?.tab?.url === APP_URL;
}

export function marketplaceForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    return ({ "www.depop.com": "depop", "www.ebay.com": "ebay", "www.etsy.com": "etsy",
      "poshmark.com": "poshmark", "www.poshmark.com": "poshmark" })[url.hostname] ?? null;
  } catch { return null; }
}

export function safeUrl(value) {
  const url = new URL(value);
  const draft = url.hostname === "www.ebay.com" && url.pathname === "/lstng" && /^\d+$/.test(url.searchParams.get("draftId") ?? "")
    ? `?draftId=${url.searchParams.get("draftId")}` : "";
  return `${url.origin}${url.pathname}${draft}`;
}
