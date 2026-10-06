import type { PrismaClient } from "@prisma/client";
import { publishBlockReason } from "./attempts.ts";
import { applicableTo } from "./applicable.ts";
import { readAutoRun } from "./autoRun.ts";

export interface CreateRunResult {
  ok: boolean;
  runId?: number;
  jobs?: number;
  skipped?: { itemId: number; sku: string; marketplace: string; reason: string }[];
  error?: string;
}

/** Reserve the whole batch together. No orphan run or partially saved job list,
 * and a second request cannot replace the active upload shown in the UI. */
export async function createQueuedRun(db: Pick<PrismaClient, "$transaction">, itemIds: number[], marketplaces: string[], automatic = false): Promise<CreateRunResult> {
  const ids = [...new Set(itemIds)], targets = [...new Set(marketplaces)];
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return { ok: false, error: "Select valid reviewed items." };
  if (!targets.length) return { ok: false, error: "Select at least one configured marketplace." };
  return db.$transaction(async tx => {
    const settingsRow = automatic ? await tx.appSettings.findUnique({ where: { id: 1 } }) : null;
    const settings = settingsRow ? JSON.parse(settingsRow.data) : {};
    const auto = readAutoRun(settings.publish?.autoRun);
    if (automatic && (!auto.enabled || targets.some(target => !auto.marketplaces.includes(target)))) return { ok: false, error: "Auto Run was switched off or its platforms changed." };
    if (await tx.publishRun.findFirst({ where: { status: { in: ["running", "paused"] } }, select: { id: true } })) {
      return { ok: false, error: "An upload is already active. Open Run activity to resume, pause or cancel it." };
    }
    const items = await tx.item.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, status: true, niftyStatus: true, trueVintage: true }, orderBy: { id: "asc" } });
    if (items.length !== ids.length || items.some(item => !["Ready", "Ready for Nifty"].includes(item.status))) {
      return { ok: false, error: "Some selected items are no longer Ready. Refresh the batch before uploading." };
    }
    const jobs: { itemId: number; marketplace: string }[] = [];
    const skipped: NonNullable<CreateRunResult["skipped"]> = [];
    for (const item of items) {
      for (const marketplace of targets) {
        if(!applicableTo(item,marketplace)) { skipped.push({itemId:item.id,sku:item.sku,marketplace,reason:"This marketplace is not applicable to this item."}); continue; }
        if (automatic && (["Draft", "Published", "Uploading"].includes(item.niftyStatus) || await tx.publishJob.findFirst({ where: { itemId: item.id, marketplace }, select: { id: true } }))) {
          skipped.push({ itemId: item.id, sku: item.sku, marketplace, reason: "Existing listings and previous attempts need manual handling." }); continue;
        }
        const listing = await tx.marketplaceListing.findUnique({ where: { itemId_marketplace: { itemId: item.id, marketplace } },
          select: { status: true, externalListingId: true } });
        const blocked = publishBlockReason(listing);
        if (blocked) skipped.push({ itemId: item.id, sku: item.sku, marketplace, reason: blocked });
        else jobs.push({ itemId: item.id, marketplace });
      }
    }
    if (!jobs.length) return { ok: false, error: "Nothing to queue — selections are already published or awaiting verification.", skipped };
    const run = await tx.publishRun.create({ data: { status: "running", marketplacesJson: JSON.stringify(targets), totalJobs: jobs.length } });
    await tx.publishJob.createMany({ data: jobs.map(job => ({ ...job, runId: run.id, status: "queued" })) });
    if (automatic) {
      settings.publish = { ...settings.publish, autoRun: { ...auto, lastRunId: run.id, pausedRunId: null } };
      await tx.appSettings.update({ where: { id: 1 }, data: { data: JSON.stringify(settings) } });
    }
    return { ok: true, runId: run.id, jobs: jobs.length, skipped };
  });
}
