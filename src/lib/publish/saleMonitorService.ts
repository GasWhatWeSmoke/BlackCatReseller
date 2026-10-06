import { prisma } from "../db.ts";
import { getRequiredSettings } from "../settings.ts";
import { createSaleMonitor } from "./saleMonitor.ts";
import { processSalesPass } from "./salesPass.ts";
import { processRemovalQueue } from "./removalQueue.ts";
import { SALES_MARKETPLACES } from "./salesProtocol.ts";
import { saleMonitorWindowOpen } from "./saleMonitorWindow.ts";

const monitorKey = Symbol.for("blackcat.saleMonitor");
type Service = { monitor: ReturnType<typeof createSaleMonitor>; timer: ReturnType<typeof setInterval> | null };
const services = globalThis as unknown as Record<symbol, Service | undefined>;

export function saleMonitorService() {
  let service = services[monitorKey];
  if (!service) {
    service = { timer: null, monitor: createSaleMonitor({
      enabled: async () => {
        const settings = await getRequiredSettings();
        return settings.publish?.saleMonitorEnabled === true && saleMonitorWindowOpen(settings.dataRoot);
      },
      frequency: async () => {
        const publish = (await getRequiredSettings()).publish;
        return { intervalMinutes: publish?.saleMonitorIntervalMinutes, checksPerDay: publish?.saleMonitorChecksPerDay };
      },
      targets: async () => (await prisma.marketplaceListing.findMany({ where: {
        externalListingId: { not: null }, status: { notIn: ["ended", "not_published"] },
      }, select: { marketplace: true }, distinct: ["marketplace"] })).map((row) => row.marketplace),
      manualTargets: async () => {
        const publish = (await getRequiredSettings()).publish;
        return SALES_MARKETPLACES.filter(marketplace =>
          publish?.[marketplace === "ebay" ? "ebayBrowser" : marketplace]?.enabled);
      },
      scan: async (marketplace, shouldContinue) => processSalesPass(prisma, await getRequiredSettings(), marketplace, { shouldContinue }),
      remove: async (shouldContinue, recoverInterrupted) => processRemovalQueue(prisma, await getRequiredSettings(), { shouldContinue, recoverInterrupted }),
    }) };
    services[monitorKey] = service;
  }
  return service;
}

/** Runs independently of the current page while the local Next server is alive. */
export function startSaleMonitor() {
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.BLACKCAT_PREVIEW === '1') return;
  const service = saleMonitorService();
  if (service.timer) return;
  service.timer = setInterval(() => { void service.monitor.tick(); }, 30_000);
  service.timer.unref();
  void service.monitor.tick();
}
