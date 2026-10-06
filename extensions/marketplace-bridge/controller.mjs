import { APP_URL, HOMES, marketplaceForUrl, safeUrl, trustedSender } from "./policy.mjs";
import { inspectSellerPage } from "./inspect.mjs";

export function createController(api) {
  return async (request, sender) => {
    if (!trustedSender(sender)) throw new Error("Only the local Black Cat connection page can request access.");
    if (request?.type === "ping") return { version: "0.1.1", capabilities: ["tabs", "open", "inspect"] };
    if (request?.type === "tabs") {
      const tabs = await api.tabs.query({});
      return { tabs: tabs.filter((tab) => marketplaceForUrl(tab.url)).map((tab) => ({
        id: tab.id, marketplace: marketplaceForUrl(tab.url), url: safeUrl(tab.url),
      })) };
    }
    if (!Object.hasOwn(HOMES, request?.marketplace ?? "")) throw new Error("Unknown marketplace.");
    if (request.type === "open") {
      const tab = await api.tabs.create({ url: HOMES[request.marketplace], active: true });
      return { tabId: tab.id, marketplace: request.marketplace };
    }
    if (request.type !== "inspect" || !Number.isInteger(request.tabId)) throw new Error("Unsupported browser command.");
    const tab = await api.tabs.get(request.tabId);
    if (marketplaceForUrl(tab.url) !== request.marketplace) throw new Error("That tab is no longer on the selected marketplace.");
    const results = await api.scripting.executeScript({ target: { tabId: tab.id }, func: inspectSellerPage });
    // Check again after execution in case a tab navigated while the command ran.
    const current = await api.tabs.get(tab.id);
    if (current.url !== tab.url) throw new Error("The tab changed while inspecting it. Try again after it finishes loading.");
    return { marketplace: request.marketplace, tabId: tab.id, url: safeUrl(tab.url), page: results[0]?.result };
  };
}

export { APP_URL };
