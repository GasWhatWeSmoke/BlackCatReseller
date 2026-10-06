import { SALES_MARKETPLACES, type SalesMarketplace } from "./salesProtocol.ts";
import type { processSalesPass } from "./salesPass.ts";
import { saleCheckMinutes, DEFAULT_SALE_CHECK_MINUTES } from "./saleMonitorSettings.ts";

export const SALE_CHECK_INTERVAL_MS = DEFAULT_SALE_CHECK_MINUTES * 60 * 1000;
export interface PlatformScanStatus {
  state: string;
  lastCheckedAt: string | null;
  reason: string | null;
  limitation: string | null;
  recorded?: number;
  unmatched?: number;
  review?: number;
}
export interface SaleMonitorStatus {
  active: boolean;
  currentPlatform: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  waitingForBrowser: boolean;
  platforms: Record<string, PlatformScanStatus>;
}
interface Dependencies {
  enabled: () => Promise<boolean>;
  frequency?: () => Promise<{ intervalMinutes?: number; checksPerDay?: number | null }>;
  targets: () => Promise<string[]>;
  manualTargets?: () => Promise<string[]>;
  scan: (marketplace: SalesMarketplace, shouldContinue: () => Promise<boolean>) => ReturnType<typeof processSalesPass>;
  remove: (shouldContinue: () => Promise<boolean>, recover: boolean) => Promise<{ busy: boolean; paused?: boolean }>;
  now?: () => number;
}

/** One serial cycle, independently testable from startup timers and HTTP. */
export function createSaleMonitor(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const platform = (state: string, limitation: string | null = null): PlatformScanStatus => ({ state, lastCheckedAt: null, reason: null, limitation });
  const status: SaleMonitorStatus = { active: false, currentPlatform: null, lastStartedAt: null, lastFinishedAt: null,
    nextCheckAt: null, lastError: null, waitingForBrowser: false, platforms: {
      depop: platform("not_checked"),
      poshmark: platform("not_checked", "End-to-end sale and removal verification is pending for this marketplace."),
      ebay: platform("not_checked", "End-to-end sale and removal verification is pending for this marketplace."),
      etsy: platform("not_checked", "End-to-end sale and removal verification is pending for this marketplace."),
      mercari: platform("not_checked", "End-to-end sale and removal verification is pending for this marketplace."),
    } };
  let recovered = false;
  const snapshot = (): SaleMonitorStatus => ({ ...status, platforms: Object.fromEntries(Object.entries(status.platforms).map(([key, value]) => [key, { ...value }])) });
  const intervalMs = async () => {
    const frequency = await deps.frequency?.();
    return saleCheckMinutes(frequency?.intervalMinutes, frequency?.checksPerDay) * 60_000;
  };
  async function schedule() {
    status.nextCheckAt = await deps.enabled() && status.lastFinishedAt
      ? new Date(Date.parse(status.lastFinishedAt) + await intervalMs()).toISOString() : null;
  }
  async function reschedule() {
    if (!status.active) await schedule();
  }

  async function execute(force = false, manual = false): Promise<boolean> {
    const enabled = manual ? async () => true : deps.enabled;
    if (status.active) return false;
    status.active = true;
    let started = false;
    try {
      if (!await enabled()) { status.nextCheckAt = null; return false; }
      const remove = async () => {
        if (!await enabled()) return false;
        const result = await deps.remove(enabled, !recovered);
        if (!result.busy && !result.paused) recovered = true;
        status.waitingForBrowser = result.busy;
        return !result.busy && !result.paused;
      };
      if (!force) await schedule();
      if (!force && status.nextCheckAt && now() < Date.parse(status.nextCheckAt)) {
        // Sale discovery keeps its configured cadence. Pending removals get a
        // chance on every service tick, without rereading any marketplace order.
        await remove();
        return false;
      }
      started = true;
      status.lastStartedAt = new Date(now()).toISOString();
      status.nextCheckAt = null; status.lastError = null; status.waitingForBrowser = false;
      for (const scan of Object.values(status.platforms)) {
        scan.state = "not_checked"; scan.reason = null;
        scan.recorded = 0; scan.unmatched = 0; scan.review = 0;
      }
      const targets = new Set(await (manual && deps.manualTargets ? deps.manualTargets() : deps.targets()));
      // Drain already-known removals before spending time reading more receipts.
      if (!await remove()) return true;
      for (const marketplace of SALES_MARKETPLACES) {
        if (!await enabled()) break;
        const scan = status.platforms[marketplace];
        scan.recorded = 0; scan.unmatched = 0; scan.review = 0;
        if (!targets.has(marketplace)) { scan.state = "waiting"; scan.reason = "No direct listings to watch."; continue; }
        status.currentPlatform = marketplace; scan.state = "checking"; scan.reason = null;
        try {
          const result = await deps.scan(marketplace, enabled);
          scan.recorded = "recorded" in result ? result.recorded ?? 0 : 0;
          scan.unmatched = "unmatched" in result ? result.unmatched ?? 0 : 0;
          scan.review = "review" in result ? result.review ?? 0 : 0;
          scan.state = result.state === "checked" && scan.limitation ? "limited" : result.state;
          scan.reason = "reason" in result ? result.reason ?? null : null;
          if (["checked", "partial"].includes(result.state)) scan.lastCheckedAt = new Date(now()).toISOString();
          if (result.state === "busy") { status.waitingForBrowser = true; break; }
          if (result.state === "paused") break;
        } catch (error) {
          scan.state = "failed";
          scan.reason = error instanceof Error ? error.message : String(error);
        }
        // A newly confirmed sale takes priority over scanning the next platform.
        if (!await remove()) break;
      }
      return true;
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (started) {
        status.lastFinishedAt = new Date(now()).toISOString();
        try { await schedule(); }
        catch (error) { status.nextCheckAt = null; status.lastError = error instanceof Error ? error.message : String(error); }
      }
      status.currentPlatform = null; status.active = false;
    }
  }
  let activeTick: Promise<boolean> | null = null;
  let manualCheck: Promise<SaleMonitorStatus> | null = null;
  function tick(force = false, manual = false): Promise<boolean> {
    if (activeTick) return Promise.resolve(false);
    activeTick = execute(force, manual).finally(() => { activeTick = null; });
    return activeTick;
  }
  // A manual sync waits for the existing cycle and then performs its own full
  // check. Concurrent clicks share that check instead of overlapping browsers.
  function checkNow(): Promise<SaleMonitorStatus> {
    if (manualCheck) return manualCheck;
    manualCheck = (async () => {
      while (activeTick) await activeTick;
      await tick(true, true);
      return snapshot();
    })().finally(() => { manualCheck = null; });
    return manualCheck;
  }
  return { snapshot, tick, checkNow, reschedule };
}
