import { isBrowserMarketplace, type BrowserMarketplace } from "./platforms.ts";

export interface BrowserInspection {
  marketplace: BrowserMarketplace;
  tabId: number;
  url: string;
  page: { state: "seller_page" | "needs_operator"; path: string; title?: string; message?: string;
    headings?: string[]; controls?: Record<string, string | boolean | null>[] };
}

/** This is an information-only channel. It cannot enqueue browser actions or
 *  update account/listing state, and data is discarded when the app restarts. */
export function parseBrowserInspection(value: unknown): BrowserInspection | null {
  if (!value || typeof value !== "object") return null;
  const data = value as BrowserInspection;
  if (!isBrowserMarketplace(data.marketplace) || !Number.isInteger(data.tabId) || data.tabId < 0) return null;
  try {
    const url = new URL(data.url);
    const hosts = data.marketplace === "poshmark" ? ["poshmark.com", "www.poshmark.com"] : [`www.${data.marketplace}.com`];
    if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.port || url.username || url.password || url.hash) return null;
    if (url.search && !(data.marketplace === "ebay" && url.pathname === "/lstng" && /^\?draftId=\d+$/.test(url.search))) return null;
    if (data.page?.path !== url.pathname || !["seller_page", "needs_operator"].includes(data.page?.state)) return null;
    if (data.page.headings && (!Array.isArray(data.page.headings) || data.page.headings.length > 60 || data.page.headings.some((h) => typeof h !== "string" || h.length > 200))) return null;
    if (data.page.controls && (!Array.isArray(data.page.controls) || data.page.controls.length > 180 || data.page.controls.some((row) =>
      !row || typeof row !== "object" || Object.entries(row).some(([key, v]) =>
        !["tag", "type", "id", "name", "role", "label", "text", "value", "checked", "disabled"].includes(key) ||
        !(v === null || typeof v === "boolean" || (typeof v === "string" && v.length <= 300)))))) return null;
    const page: BrowserInspection["page"] = { state: data.page.state, path: data.page.path };
    for (const key of ["title", "message"] as const) {
      if (data.page[key] !== undefined) {
        if (typeof data.page[key] !== "string" || data.page[key]!.length > 500) return null;
        page[key] = data.page[key];
      }
    }
    page.headings = data.page.headings;
    page.controls = data.page.controls;
    return { marketplace: data.marketplace, tabId: data.tabId, url: data.url, page };
  } catch { return null; }
}

type Snapshot = BrowserInspection & { inspectedAt: string };
const globals = globalThis as typeof globalThis & { blackcatBrowserInspections?: Map<string, Snapshot> };
const snapshots = globals.blackcatBrowserInspections ??= new Map();
export function saveBrowserInspection(inspection: BrowserInspection): Snapshot {
  const snapshot = { ...inspection, inspectedAt: new Date().toISOString() };
  snapshots.set(inspection.marketplace, snapshot);
  return snapshot;
}
export function browserInspections(): Snapshot[] { return [...snapshots.values()]; }
export function clearBrowserInspections(): void { snapshots.clear(); }
