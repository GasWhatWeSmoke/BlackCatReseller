import { prisma } from "../db.ts";
import { getSettings } from "../settings.ts";
import { getAdapter } from "./adapters/registry.ts";
import { createQueuedRun } from "./createQueuedRun.ts";
import { kickEngine } from "./queue.ts";
import { createAutoRunController, readAutoRun } from "./autoRun.ts";
import { scanAutoRunCandidates } from './autoRunScan.ts';

const key = Symbol.for("blackcat.autoCrosslisting");
type Service = { controller: ReturnType<typeof createAutoRunController>; timer: ReturnType<typeof setInterval> | null };
const services = globalThis as unknown as Record<symbol, Service | undefined>;
export function autoRunService() {
  if (!services[key]) services[key] = { timer: null, controller: createAutoRunController({
    config: async () => readAutoRun((await getSettings()).publish?.autoRun),
    activeRun: () => prisma.publishRun.findFirst({ where: { status: { in: ["running", "paused"] } }, select: { id: true, status: true } }),
    batch: async (targets, onProgress) => {
      const settings = await getSettings();
      return scanAutoRunCandidates(prisma, settings, targets, getAdapter, { onProgress, shouldContinue: async () => {
        const current = readAutoRun((await getSettings()).publish?.autoRun);
        return current.enabled && [...current.marketplaces].sort().join() === [...targets].sort().join();
      } });
    },
    queue: async batch => {
      const result = await createQueuedRun(prisma, batch.itemIds, batch.marketplaces, true);
      if (result.ok) void kickEngine();
      return result;
    },
  }) };
  return services[key]!;
}
export function startAutoCrosslisting() {
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.BLACKCAT_PREVIEW === '1') return;
  const service = autoRunService();
  if (service.timer) return;
  service.timer = setInterval(() => { void service.controller.tick(); }, 10000);
  service.timer.unref();
  void service.controller.tick();
  void kickEngine();
}
