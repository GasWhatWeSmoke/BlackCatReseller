// Re-run AI vision identification for one already-imported item from its STORED
// photos — the recovery path behind Review's "Retry AI" and the dashboard's bulk
// retry. Fill policy: AI values land only in columns the operator hasn't set;
// aiRaw/aiConfidence/aiFields/aiError always refresh. Extracted from the
// items/[id]/reidentify route so the bulk endpoint shares one implementation.
import { prisma } from "./db";
import { getSettings } from "./settings";
import {
  ManagedVisionCancelledError,
  ManagedVisionCancelRequestError,
  ManagedVisionDeferredError,
  runReenrich,
  type ManagedWorkerRunOptions,
  type ReenrichPhotoRequest,
} from "./worker";
import { estimateWeightOz, sanitizeDescription, isDescriptionWeak, cleanAttr } from "./listing";
import type { AppSettingsData, ItemEnrichment } from "./types";
import type { Item, Photo, Prisma } from "@prisma/client";
import { parseEvidence } from "./itemEdits";

export type ReidentifyResult =
  | { ok: true; item: Item; filled: string[] }
  | { ok: false; status: number; error: string };

export interface PreparedReidentifyItem {
  item: Item & { photos: Photo[] };
  itemUpdatedAt: Date;
  photos: ReenrichPhotoRequest[];
}

export type PrepareReidentifyResult =
  | { ok: true; prepared: PreparedReidentifyItem }
  | { ok: false; status: number; error: string };

/** AI retries only propose changes to unpublished, unsold inventory. */
export const REIDENTIFY_CANDIDATE_WHERE = {
  status: { in: ['Photographed', 'Needs Info', 'Ready', 'Ready for Nifty'] },
  niftyStatus: 'Not Uploaded', salePrice: null,
  marketplaceListings: { none: { status: { notIn: ['ended', 'not_published'] } } },
  publishJobs: { none: { status: { in: ['queued', 'retrying', 'publishing'] } } },
} satisfies Prisma.ItemWhereInput;
export async function prepareReidentifyItem(id: number): Promise<PrepareReidentifyResult> {
  const item = await prisma.item.findUnique({ where: { id }, include: { photos: true } });
  if (!item) return { ok: false, status: 404, error: "not found" };
  if (!await prisma.item.findFirst({ where: { id, ...REIDENTIFY_CANDIDATE_WHERE }, select: { id: true } }))
    return { ok: false, status: 409, error: 'AI retry requires unpublished, unsold inventory without active or uncertain publishing work. Review this item manually.' };

  const photos = item.photos
    .filter((photo) => !photo.isMarker && photo.includeInListing && photo.storedPath)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .slice(0, 32)
    .map((photo) => ({
      photoId: photo.id,
      storedPath: photo.storedPath,
      isMarker: false,
      sha256: photo.sha256,
      rotation: photo.rotation,
    }));
  if (!photos.length) {
    return { ok: false, status: 422, error: "this item has no listing photos to analyze" };
  }
  return { ok: true, prepared: { item, itemUpdatedAt: item.updatedAt, photos } };
}

export async function reidentifyItem(
  id: number,
  settings?: AppSettingsData,
  options: ManagedWorkerRunOptions = {},
): Promise<ReidentifyResult> {
  if (options.signal?.aborted) throw new ManagedVisionCancelledError();
  settings = settings ?? (await getSettings());
  const preparedResult = await prepareReidentifyItem(id);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.prepared;
  let enrichment: ItemEnrichment;
  try {
    enrichment = await runReenrich(settings, prepared.item.sku, prepared.photos, options);
  } catch (e) {
    if (e instanceof ManagedVisionDeferredError || e instanceof ManagedVisionCancelledError
        || e instanceof ManagedVisionCancelRequestError) throw e;
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
  // This is the last cancellation boundary. Once the transaction below starts,
  // complete it deterministically so an abort cannot leave a half-applied item.
  if (options.signal?.aborted) throw new ManagedVisionCancelledError();
  const result = await applyReidentification(prepared, enrichment);
  await resolveHealedAiProblems();
  return result;
}

/** Apply a completed enrichment. Callers must invoke this only after the Python
 * managed-session process has exited successfully. */
export async function applyReidentification(
  prepared: PreparedReidentifyItem,
  enrichment: ItemEnrichment,
): Promise<ReidentifyResult> {
  const id = prepared.item.id;
  // A managed batch may take minutes. Re-read operator-owned fields immediately
  // before applying so edits made while inference was running are never replaced
  // based on the stale pre-session snapshot.
  return prisma.$transaction(async (tx) => {
  const item = await tx.item.findUnique({ where: { id }, include: { photos: true } });
  if (!item) return { ok: false, status: 404, error: "not found" };
  const currentPhotos = item.photos
    .filter((photo) => !photo.isMarker && photo.includeInListing && photo.storedPath)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .slice(0, 32)
    .map((photo) => ({
      photoId: photo.id,
      storedPath: photo.storedPath,
      isMarker: false,
      sha256: photo.sha256,
      rotation: photo.rotation,
    }));
  const samePhotos = currentPhotos.length === prepared.photos.length
    && currentPhotos.every((photo, index) =>
      photo.photoId === prepared.photos[index].photoId
      && photo.storedPath === prepared.photos[index].storedPath
      && photo.sha256 === prepared.photos[index].sha256
      && photo.rotation === (prepared.photos[index].rotation ?? 0));
  if (!samePhotos || item.updatedAt.getTime() !== prepared.itemUpdatedAt.getTime() ||
      item.sku !== prepared.item.sku || item.createdAt.getTime() !== prepared.item.createdAt.getTime()) {
    return {
      ok: false,
      status: 409,
      error: "item or listing photos changed during AI identification; retry with the current state",
    };
  }
  if (!await tx.item.findFirst({ where: { id, ...REIDENTIFY_CANDIDATE_WHERE }, select: { id: true } }))
    return { ok: false, status: 409, error: 'This item is now protected by sale or publishing activity. AI results were not applied.' };

  if (enrichment.error || !enrichment.fields) {
    const reason = enrichment.error ?? "vision returned no data";
    const write = await tx.item.updateMany({
      where: { id, updatedAt: item.updatedAt },
      data: { aiError: reason },
    });
    if (write.count !== 1) {
      return { ok: false, status: 409,
        error: "item changed while AI identification was being applied; retry" };
    }
    console.log(`[reidentify] ${item.sku}: FAILED — ${reason}`);
    return { ok: false, status: 502, error: reason };
  }

  const f = enrichment.fields;
  const raw = (enrichment.raw ?? {}) as Record<string, unknown>;
  const rawStr = (k: string) => cleanAttr(raw[k]);
  const joinArr = (k: string): string | undefined => {
    const v = raw[k];
    if (!Array.isArray(v)) return undefined;
    const items = v.map((x) => cleanAttr(x)).filter(Boolean) as string[];
    return items.length ? items.join("\n") : undefined;
  };
  const empty = (v: string | null | undefined) => !v || !String(v).trim();

  // Only fill what the operator hasn't touched. brand "Unknown" counts as unset.
  const data: Record<string, unknown> = {};
  const previousEvidence = parseEvidence(item.evidenceJson);
  const fill = (col: keyof typeof item, value: string | undefined) => {
    if (previousEvidence[col]?.status === "confirmed" || (col === "keyDetails" && item.keyDetails === "")) return;
    if (value && empty(item[col] as string | null)) data[col as string] = value;
  };
  fill("size", f.size);
  fill("itemType", f.itemType);
  fill("category", f.category ?? rawStr("category"));
  fill("color", f.color);
  fill("pattern", f.pattern);
  if (f.brand && previousEvidence.brand?.status !== "confirmed" && (empty(item.brand) || item.brand === "Unknown")) data.brand = f.brand;
  fill("department", rawStr("department"));
  fill("material", rawStr("material"));
  fill("style", rawStr("style"));
  fill("secondaryColor", rawStr("secondaryColor"));
  fill("tertiaryColor", rawStr("tertiaryColor"));
  fill("fit", rawStr("fit"));
  fill("closure", rawStr("closure"));
  fill("neckline", rawStr("neckline"));
  fill("lining", rawStr("lining"));
  fill("graphics", joinArr("graphics"));
  fill("keyDetails", joinArr("keyDetails"));
  fill("aesthetic", joinArr("aesthetic"));
  const visionDesc = sanitizeDescription(rawStr("description"));
  if (visionDesc && !isDescriptionWeak(visionDesc) && empty(item.description)) data.description = visionDesc;
  const newType = (data.itemType as string | undefined) ?? item.itemType;
  if (item.weightOz == null && newType) data.weightOz = estimateWeightOz(newType);

  const rawConf = Number(raw.confidence);
  const aiConfidence = Number.isFinite(rawConf) && rawConf >= 0 && rawConf <= 1 ? rawConf : null;
  const filled = Object.keys(data);
  const newEvidence = raw.evidence && typeof raw.evidence === "object" && !Array.isArray(raw.evidence)
    ? raw.evidence as Record<string, unknown> : {};
  const evidenceJson = JSON.stringify({ ...previousEvidence, ...Object.fromEntries(filled.filter(key => newEvidence[key]).map(key => [key, newEvidence[key]])) });
  // Merge AI badges: previously unconfirmed AI fields + everything filled now.
  const prevAi: string[] = (() => {
    try { return item.aiFields ? (JSON.parse(item.aiFields) as string[]) : []; } catch { return []; }
  })();
  const aiFields = [...new Set([
    ...prevAi,
    ...(enrichment.aiFields ?? []).filter((k) => filled.includes(k)),
    ...(data.weightOz != null ? ["weight"] : []),
  ])];

  const write = await tx.item.updateMany({
    where: { id, updatedAt: item.updatedAt },
    data: {
      ...data,
      // New AI/raw copy has not been reviewed, even when existing fields won.
      status: ['Ready', 'Ready for Nifty'].includes(item.status) ? 'Photographed' : item.status,
      readyFolderPath: null,
      updatedAt: new Date(Math.max(Date.now(), item.updatedAt.getTime() + 1)),
      evidenceJson,
      aiError: null,
      aiRaw: JSON.stringify(enrichment.raw ?? {}),
      aiConfidence,
      aiFields: aiFields.length ? JSON.stringify(aiFields) : item.aiFields,
    },
  });
  if (write.count !== 1) {
    return { ok: false, status: 409,
      error: "item changed while AI identification was being applied; retry" };
  }
  const updated = await tx.item.findUnique({ where: { id } });
  if (!updated) return { ok: false, status: 409, error: "item changed while AI identification was being applied; retry" };
  console.log(`[reidentify] ${item.sku}: ok — filled ${filled.length ? filled.join(", ") : "nothing new (operator already set the fields)"}`);
  return { ok: true, item: updated, filled };
  });
}

/** Once no items carry an aiError anymore, the dashboard's "AI Identification
 * Failed" rows are HEALED — resolve them so a recovered batch stops shouting.
 * Returns how many rows were resolved. */
export async function resolveHealedAiProblems(): Promise<number> {
  const remaining = await prisma.item.count({ where: { aiError: { not: null } } });
  if (remaining > 0) return 0;
  const r = await prisma.problemLog.updateMany({
    where: { type: "AI_ENRICH_FAILED", resolved: false },
    data: { resolved: true },
  });
  if (r.count) console.log(`[reidentify] all AI failures healed — resolved ${r.count} problem row(s)`);
  return r.count;
}
