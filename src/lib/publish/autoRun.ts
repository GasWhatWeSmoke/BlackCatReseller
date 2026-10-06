import type { PrismaClient } from "@prisma/client";

export const AUTO_MARKETPLACES = ["depop", "ebay", "etsy", "poshmark", "mercari"] as const;
export interface AutoRunConfig { enabled: boolean; marketplaces: string[]; lastRunId?: number; pausedRunId?: number | null }
export function readAutoRun(value?: Partial<AutoRunConfig>): AutoRunConfig {
  return { enabled: value?.enabled === true, marketplaces: Array.isArray(value?.marketplaces)
    ? [...new Set(value.marketplaces.filter(name => AUTO_MARKETPLACES.includes(name as typeof AUTO_MARKETPLACES[number])))] : [...AUTO_MARKETPLACES],
    ...(Number.isSafeInteger(value?.lastRunId) ? { lastRunId: value!.lastRunId } : {}), pausedRunId: value?.pausedRunId ?? null };
}

/** Only this setting changes. Switching off pauses its current automatic batch
 * in the same transaction, while preserving the user's other settings. */
export async function configureAutoRun(db: Pick<PrismaClient, "$transaction">, enabled: boolean, marketplaces: string[]) {
  if (typeof enabled !== "boolean" || !Array.isArray(marketplaces) || !marketplaces.length || marketplaces.some(name => !AUTO_MARKETPLACES.includes(name as typeof AUTO_MARKETPLACES[number]))) throw new Error("Choose supported marketplaces for Auto Run.");
  return db.$transaction(async tx => {
    const row = await tx.appSettings.findUnique({ where: { id: 1 } });
    const data = row ? JSON.parse(row.data) : {};
    const previous = readAutoRun(data.publish?.autoRun);
    const next: AutoRunConfig = { ...previous, enabled, marketplaces: [...new Set(marketplaces)] };
    if (!enabled && previous.lastRunId) {
      const paused = await tx.publishRun.updateMany({ where: { id: previous.lastRunId, status: "running" }, data: { status: "paused" } });
      if (paused.count) next.pausedRunId = previous.lastRunId;
    } else if (enabled && previous.pausedRunId) {
      if (await tx.publishRun.findFirst({ where: { id: { not: previous.pausedRunId }, status: { in: ["running", "paused"] } }, select: { id: true } })) throw new Error("Finish the other active run before resuming Auto Run.");
      await tx.publishRun.updateMany({ where: { id: previous.pausedRunId, status: "paused" }, data: { status: "running" } });
      next.pausedRunId = null;
    }
    data.publish = { ...data.publish, autoRun: next };
    await tx.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: JSON.stringify(data) }, update: { data: JSON.stringify(data) } });
    return next;
  });
}

export interface AutoBatch { itemIds: number[]; marketplaces: string[] }
export interface AutoScanCoverage { checked: number; total: number; complete: boolean }
export function selectAutoBatch(candidates: { id: number; marketplaces: string[] }[]): AutoBatch | null {
  const first = candidates.find(item => item.marketplaces.length);
  if (!first) return null;
  const signature = [...first.marketplaces].sort().join(",");
  return { marketplaces: first.marketplaces, itemIds: candidates.filter(item => [...item.marketplaces].sort().join(",") === signature).slice(0, 25).map(item => item.id) };
}

export function createAutoRunController(deps: {
  config: () => Promise<AutoRunConfig>;
  activeRun: () => Promise<{ id: number; status: string } | null>;
  batch: (marketplaces: string[], onProgress?: (result: { needsAttention: number; coverage?: AutoScanCoverage }) => void) => Promise<{ batch: AutoBatch | null; needsAttention: number; coverage?: AutoScanCoverage; cancelled?: boolean }>;
  queue: (batch: AutoBatch) => Promise<{ ok: boolean; runId?: number; error?: string }>;
}) {
  let busy = false;
  const state = { state: "off", lastCheckedAt: null as string | null, runId: null as number | null, needsAttention: 0,
    attentionCoverage: null as AutoScanCoverage | null, error: null as string | null };
  return {
    snapshot: () => ({ ...state, attentionCoverage: state.attentionCoverage ? { ...state.attentionCoverage } : null, checking: busy }),
    async tick() {
      if (busy) return;
      busy = true;
      try {
        const config = await deps.config();
        state.error = null;
        if (!config.enabled) { state.state = "off"; return; }
        const active = await deps.activeRun();
        if (active) { state.state = active.status === "paused" ? "paused" : "running"; state.runId = active.id; return; }
        state.state = "checking";
        state.needsAttention = 0; state.attentionCoverage = null;
        const result = await deps.batch(config.marketplaces, progress => {
          state.needsAttention = progress.needsAttention; state.attentionCoverage = progress.coverage ?? null;
        });
        state.needsAttention = result.needsAttention;
        state.attentionCoverage = result.coverage ?? null;
        const current = await deps.config();
        if (!current.enabled || [...current.marketplaces].sort().join() !== [...config.marketplaces].sort().join()) {
          state.state = "off"; state.needsAttention = 0; state.attentionCoverage = null; return;
        }
        if (result.cancelled) { state.state = 'waiting'; return; }
        if (!result.batch) { state.state = "waiting"; state.runId = null; return; }
        const queued = await deps.queue(result.batch);
        state.state = queued.ok ? "running" : "waiting";
        state.runId = queued.runId ?? null; state.error = queued.error ?? null;
      } catch (error) { state.state = "error"; state.error = error instanceof Error ? error.message : "Auto Run could not check the queue."; }
      finally { state.lastCheckedAt = new Date().toISOString(); busy = false; }
    },
  };
}
