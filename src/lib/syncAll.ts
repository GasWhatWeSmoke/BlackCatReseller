import type { SaleMonitorStatus } from "./publish/saleMonitor.ts";
import { MARKETPLACE_NAMES } from "./publish/platforms.ts";

export async function syncAll(deps: {
  scan: () => Promise<SaleMonitorStatus>;
  backlog: () => Promise<number>;
  saveSummary: (at: string, summary: string) => Promise<void>;
}) {
  const warnings: string[] = [];
  let marketplaces: SaleMonitorStatus | null = null;
  try { marketplaces = await deps.scan(); }
  catch (error) { warnings.push(`Marketplace check: ${error instanceof Error ? error.message : String(error)}`); }
  const checked: string[] = [];
  let directSold = 0, unlinkedReceipts = 0;
  if (marketplaces) {
    if (marketplaces.lastError) warnings.push(marketplaces.lastError);
    if (marketplaces.waitingForBrowser) warnings.push("Marketplace browser is busy; sync again after the current task");
    for (const [market, state] of Object.entries(marketplaces.platforms)) {
      const name = MARKETPLACE_NAMES[market as keyof typeof MARKETPLACE_NAMES] ?? market;
      directSold += state.recorded ?? 0;
      unlinkedReceipts += state.unmatched ?? 0;
      if (["checked", "limited"].includes(state.state)) checked.push(name);
      else if (state.state !== "waiting") warnings.push(`${name}: ${state.reason ?? state.state}`);
    }
    if (!checked.length && !warnings.length) warnings.push("No marketplace accounts were checked");
  }
  let pendingRemovals: number | null = null;
  try { pendingRemovals = await deps.backlog(); }
  catch { warnings.push("Could not verify the removal backlog"); }
  if (pendingRemovals) warnings.push(`${pendingRemovals} other listing(s) still need removal`);
  const sold = directSold;
  const summary = [
    `${checked.length ? checked.join(", ") : "No marketplaces"} checked`, `${sold} new sale(s)`,
    ...(unlinkedReceipts ? [`${unlinkedReceipts} older or unlinked receipt(s) not applied directly`] : []),
    ...warnings,
  ].join(" · ");
  const at = new Date().toISOString();
  await deps.saveSummary(at, summary);
  return { ok: warnings.length === 0, ...(warnings.length ? { error: warnings.join("; ") } : {}),
    at, summary, sold, checkedPlatforms: checked, directSold, unlinkedReceipts, marketplaces, pendingRemovals, warnings };
}
