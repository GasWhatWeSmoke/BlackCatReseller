import path from "node:path";
import { prisma } from "./db";
import type { AppSettingsData, WorkerItem, WorkerResult } from "./types";
import { estimateWeightOz, sanitizeDescription, isDescriptionWeak, cleanAttr, stripBrandFromModel } from "./listing";
import { backupDatabase } from "./backup";
import { archiveOriginals } from "./fileArchive";
import { isAiSkipped } from "./intakeOutcome";

export interface PersistSummary {
  batchId: number;
  itemsCreated: number;
  duplicatesSkipped: number;
  problems: number;
  collisions: number;
  needsReview: number;
  // AI identification outcome across the batch (2026-08-05 blank-batch fix):
  // aiFailed counts persisted items with photos whose enrichment errored; the
  // first error text explains WHY so the dashboard can say it out loud.
  aiFailed: number;
  aiSkipped: number;
  aiTotal: number;
  aiFirstError?: string;
}

async function createItemWithPhotos(item: WorkerItem, batchId: number) {
  const listingCount = item.photos.filter((p) => p.includeInListing).length;

  // Apply AI vision enrichment (auto-fill; each field flagged for spot-check).
  const enr = item.enrichment ?? {};
  const f = enr.fields ?? {};
  const aiFields = (enr.aiFields ?? []).filter((k) => f[k as keyof typeof f] != null);

  // Auto-estimate ship weight from the detected item type (editable in Review).
  const weightOz = f.itemType ? estimateWeightOz(f.itemType) : null;
  if (weightOz != null) aiFields.push("weight");

  // Promote the extra detected specifics (department/material/style/secondaryColor)
  // from the raw vision JSON into editable columns.
  const raw = (enr.raw ?? {}) as Record<string, unknown>;
  // cleanAttr drops empty/junk values ("null"/"none"/"unknown") so a stringified-null
  // from the model can't be stored as a real column value.
  const rawStr = (k: string) => cleanAttr(raw[k]);
  // The vision model writes a full description paragraph; sanitize it and store it as the
  // editable draft. We deliberately keep it un-desalesified here so the salesy SIGNAL is
  // preserved — the export decides per-item whether to de-hype it or rebuild from the
  // structured fields (see ready/route.ts). Keep it only if it's strong (not too short /
  // not junk), else leave null so the export generates one deterministically.
  const visionDesc = sanitizeDescription(rawStr("description"));
  const description = visionDesc && !isDescriptionWeak(visionDesc) ? visionDesc : undefined;
  // Array detail fields (graphics/keyDetails/aesthetic) -> newline-separated text columns,
  // cleaned of junk so they're editable and feed the copy builders (B27).
  const joinArr = (k: string): string | undefined => {
    const v = raw[k];
    if (!Array.isArray(v)) return undefined;
    const items = v.map((x) => cleanAttr(x)).filter(Boolean) as string[];
    return items.length ? items.join("\n") : undefined;
  };

  // Vision self-reported confidence (0..1) — surfaced so Review can triage
  // recognition quality without digging into aiRaw.
  const rawConf = Number((raw as Record<string, unknown>).confidence);
  const aiConfidence = Number.isFinite(rawConf) && rawConf >= 0 && rawConf <= 1 ? rawConf : undefined;

  // Per-attribute provenance built by the worker (evidence.py). One item-level
  // confidence cannot express that the fabric was READ off a care label while the
  // colour was inferred from a photo, and Review needs to show that difference.
  const evidenceRaw = raw.evidence;
  const evidenceJson =
    evidenceRaw && typeof evidenceRaw === "object" ? JSON.stringify(evidenceRaw) : undefined;

  // Persist the item + its photos + dedup hashes ATOMICALLY (B23) so a crash mid-loop
  // can't leave an item with missing photos or a half-written dedup ledger. One item is
  // small (1 row + a handful of photos), so this stays well within the tx timeout.
  const created = await prisma.$transaction(async (tx) => {
    const it = await tx.item.create({
      data: {
        sku: item.sku,
        originalQrValue: item.originalQrValue ?? undefined,
        status: "Photographed",
        batchId,
        isShell: !!item.placeholder,
        groupingConfidence: item.grouping?.confidence ?? undefined,
        groupingLogJson: item.grouping ? JSON.stringify(item.grouping) : undefined,
        aiConfidence,
        // WHY enrichment produced nothing (endpoint down / text-only model / parse
        // failure) — drives the "AI failed" chip + Retry AI in Review. Null when AI ran.
        aiError: enr.error ?? undefined,
        photoCount: listingCount,
        processingFolderPath: item.processingFolderPath,
        size: f.size ?? undefined,
        color: f.color ?? undefined,
        pattern: f.pattern ?? undefined,
        itemType: f.itemType ?? undefined,
        category: f.category ?? rawStr("category"),
        brand: f.brand ?? undefined, // defaults to "Unknown" if not detected
        weightOz: weightOz ?? undefined,
        department: rawStr("department"),
        material: rawStr("material"),
        style: rawStr("style"),
        secondaryColor: rawStr("secondaryColor"),
        fit: rawStr("fit"),
        // whenMade (Etsy era) is normally operator-set via the True Vintage checkbox; only
        // store an AI era if a future vision prompt ever returns one (no-op otherwise).
        whenMade: rawStr("whenMade"),
        description,
        tertiaryColor: rawStr("tertiaryColor"),
        closure: rawStr("closure"),
        neckline: rawStr("neckline"),
        lining: rawStr("lining"),
        graphics: joinArr("graphics"),
        keyDetails: joinArr("keyDetails"),
        aesthetic: joinArr("aesthetic"),
        // Model/style number/country: the first two may come from vision, the last
        // only ever from a care label. See evidence.py for which is which.
        // The vision model tends to write "Wrangler 2000" when the brand is Wrangler.
        // Stored that way, the brand can never be corrected without the old name
        // surviving in the title, so the brand is scrubbed out of the model here.
        model: stripBrandFromModel(rawStr("model"), f.brand ?? rawStr("brand")) || undefined,
        styleNumber: rawStr("styleNumber"),
        subBrand: rawStr("subBrand"),
        countryOfOrigin: rawStr("countryOfOrigin"),
        aiFields: aiFields.length ? JSON.stringify(aiFields) : undefined,
        aiRaw: enr.raw ? JSON.stringify(enr.raw) : undefined,
        // Lifted out of aiRaw so Review can badge a field without parsing the blob.
        evidenceJson,
      },
    });
    for (const p of item.photos) {
      await tx.photo.create({
        data: {
          itemId: it.id,
          originalFilename: p.originalFilename,
          storedPath: p.storedPath,
          thumbPath: p.thumbPath ?? undefined,
          sha256: p.sha256 ?? "",
          sortOrder: p.sortOrder,
          isCover: p.isCover,
          isMarker: p.isMarker,
          includeInListing: p.includeInListing,
          rotation: p.rotation,
          decodedValue: p.decodedValue ?? undefined,
          width: p.width ?? undefined,
          height: p.height ?? undefined,
          exifDateTimeOriginal: p.exifDateTimeOriginal ?? undefined,
          exifSubSec: p.exifSubSec ?? undefined,
        },
      });
      if (p.sha256) {
        await tx.fileHash.upsert({
          where: { sha256: p.sha256 },
          update: {},
          create: {
            sha256: p.sha256,
            originalFilename: p.originalFilename,
            processedPath: p.storedPath,
            sku: item.sku,
          },
        });
      }
    }
    return it;
  });
  // Log item creation + the AI data outcome so a "no photos / no data" item is
  // diagnosable from server.log without guessing.
  const aiSummary = Object.keys(f).length
    ? Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")
    : (enr.error ? `none (${enr.error})` : "none");
  console.log(`[persist] item ${item.sku} created (#${created.id}) — ` +
    `${item.photos.length} photo(s) attached, ${listingCount} listing; AI: ${aiSummary}`);
  return created;
}

export async function persistWorkerResult(
  result: WorkerResult,
  settings: AppSettingsData,
): Promise<PersistSummary> {
  const archiveDir = path.join(settings.archivePath, result.batchId);
  const needsReviewDir = settings.needsReviewPath;

  // Create the Batch row first (FK target for items/problems). Its counters are written at
  // the END from what ACTUALLY landed, so a partial import never leaves overstated numbers.
  const batch = await prisma.batch.create({
    data: {
      finishedAt: new Date(),
      itemsCreated: 0,
      photosProcessed: result.counts.photosProcessed,
      duplicatesSkipped: result.counts.duplicatesSkipped,
      problems: 0,
      collisions: 0,
      durationMs: result.durationMs,
      summaryJson: JSON.stringify(result.counts),
    },
  });

  let problemCount = 0;
  const logProblem = async (type: string, sku: string | undefined, message: string, photoPath?: string) => {
    await prisma.problemLog.create({
      data: { batchId: batch.id, type, sku, photoPath, message },
    });
    problemCount++;
  };

  // Worker-reported problems.
  for (const prob of result.problems) {
    await logProblem(prob.type, prob.sku ?? undefined, prob.message ?? "", prob.photoPath ?? undefined);
  }

  // Items: commit each ATOMICALLY, THEN archive its originals (originals-safe ordering,
  // §25.2). A persist failure leaves that item's originals in /incoming and continues —
  // the next Process run re-groups and resumes the un-persisted item cleanly.
  let itemsCreated = 0;
  // AI outcome tally (items with listing photos only — a photo-less shell can't
  // be identified and shouldn't count as an AI failure).
  let aiFailed = 0;
  let aiSkipped = 0;
  let aiTotal = 0;
  let duplicatesSkipped = result.counts.duplicatesSkipped;
  let aiFirstError: string | undefined;
  const lateCollisions: WorkerItem[] = [];
  for (const item of result.items) {
    const existing = await prisma.item.findUnique({ where: { sku: item.sku } });
    if (existing) {
      lateCollisions.push(item);
      continue;
    }
    try {
      await createItemWithPhotos(item, batch.id);
      itemsCreated++;
      const hasListingPhotos = item.photos.some((p) => p.includeInListing);
      if (hasListingPhotos) {
        aiTotal++;
        if (isAiSkipped(item.enrichment?.error)) {
          aiSkipped++;
        } else if (item.enrichment?.error) {
          aiFailed++;
          aiFirstError = aiFirstError ?? item.enrichment.error;
        }
      }
      const a = archiveOriginals(item.originalPaths ?? [], archiveDir, needsReviewDir);
      if (a.failed.length) {
        await logProblem("UNREADABLE_FILE", item.sku,
          `committed, but ${a.failed.length} original(s) could not be archived — remove them from /incoming by hand`);
      }
    } catch (e) {
      // Originals stay in /incoming → this SKU resumes on the next Process run.
      await logProblem("IMPORT_FAILED", item.sku,
        `persist failed: ${e instanceof Error ? e.message : String(e)} — left in /incoming to retry next Process`);
    }
  }

  // Collisions (worker-detected + late-detected). An incoming group whose photos are ALL
  // exact byte-duplicates of the existing item's photos is a RE-IMPORT, not a real
  // conflict — auto-resolve it silently instead of demanding an Append/Replace/New
  // decision (these were most of the "too many collisions" noise in the 50-item run).
  const allCollisions = [...result.collisions, ...lateCollisions];
  let pendingCollisions = 0;
  for (const col of allCollisions) {
    const existing = await prisma.item.findUnique({
      where: { sku: col.sku },
      include: { photos: { select: { sha256: true } } },
    });
    try {
      const existingHashes = new Set((existing?.photos ?? []).map((p) => p.sha256).filter(Boolean));
      const incomingHashes = col.photos.map((p) => p.sha256).filter(Boolean) as string[];
      const exactReimport = existing != null && incomingHashes.length > 0 && incomingHashes.length === col.photos.length &&
        incomingHashes.every((h) => existingHashes.has(h));
      if (exactReimport) {
        await prisma.collision.create({
          data: {
            batchId: batch.id,
            sku: col.sku,
            existingItemId: existing.id,
            incomingPhotosJson: JSON.stringify(col.photos),
            status: "resolved",
            resolution: "duplicate-skip",
          },
        });
        duplicatesSkipped += incomingHashes.length;
        console.log(`[persist] collision ${col.sku}: identical re-import (${incomingHashes.length} photo(s)) — auto-resolved, no action needed`);
      } else {
        await prisma.collision.create({
          data: {
            batchId: batch.id,
            sku: col.sku,
            existingItemId: existing?.id ?? undefined,
            incomingPhotosJson: JSON.stringify(col.photos),
            status: "pending",
          },
        });
        pendingCollisions++;
      }
      archiveOriginals(col.originalPaths ?? [], archiveDir, needsReviewDir);
    } catch (e) {
      await logProblem("IMPORT_FAILED", col.sku,
        `collision persist failed: ${e instanceof Error ? e.message : String(e)} — left in /incoming`);
    }
  }

  // AI identification failures become a DURABLE problem row (they used to be
  // console-only — the 2026-08-05 batch imported 23 blank items with zero UI
  // signal). One batch-level row, not one per item: the per-item reason lives on
  // Item.aiError and in Review; this row is the dashboard-visible headline.
  if (aiFailed > 0) {
    await logProblem(
      "AI_ENRICH_FAILED",
      undefined,
      `AI identification failed for ${aiFailed} of ${aiTotal - aiSkipped} attempted item(s) — ${aiFirstError ?? "unknown error"}. ` +
        `The items imported with photos but no AI data. Fix the AI vision server, then use Retry AI in Review.`,
    );
  }

  // Finalize the Batch counters to reflect what actually landed (only collisions that
  // still need a human decision are counted).
  await prisma.batch.update({
    where: { id: batch.id },
    data: { itemsCreated, duplicatesSkipped, problems: problemCount, collisions: pendingCollisions,
      summaryJson: JSON.stringify({ ...result.counts, itemsCreated, duplicatesSkipped,
        problems: problemCount, collisions: pendingCollisions, aiTotal, aiFailed, aiSkipped }) },
  });

  // Snapshot the DB after a batch changes inventory (B7) — best-effort, never blocks.
  await backupDatabase(`batch ${batch.id}`);

  return {
    batchId: batch.id,
    itemsCreated,
    duplicatesSkipped,
    problems: problemCount,
    collisions: pendingCollisions,
    needsReview: result.needsReview.length,
    aiFailed,
    aiSkipped,
    aiTotal,
    aiFirstError,
  };
}
