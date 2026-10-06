// A browser submission is not idempotent. Persist uncertainty before opening the
// form, and never turn a lost response into permission to publish another copy.
import type { MarketplaceListing, PrismaClient, PublishJob } from "@prisma/client";
import type { PublishSuccess } from "./types.ts";

type Store = Pick<PrismaClient, "$transaction">;
const UNKNOWN = "The previous attempt may be live. Check the marketplace and resolve this listing before retrying.";

export function publishBlockReason(listing: { status: string; externalListingId?: string | null } | null): string | null {
  if (!listing || ["ended", "not_published"].includes(listing.status)) return null;
  if (listing.status === "sold") return "This listing has sold. It cannot be published again automatically.";
  if (["delist_pending", "delisting", "delist_unknown", "delist_failed"].includes(listing.status)) return "This item is awaiting removal after a sale. Resolve its removal before any new publication.";
  if (listing.status === "published") return `Already published (listing ${listing.externalListingId ?? "?"}).`;
  return UNKNOWN;
}

/** The reservation commits BEFORE the adapter can click anything. */
export async function beginPublishAttempt(db: Store, jobId: number): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const job = await tx.publishJob.findUniqueOrThrow({ where: { id: jobId }, include: { run: true } });
    if (job.status !== "publishing" || job.run.status !== "running") return "The run was paused or cancelled before publishing.";
    const where = { itemId_marketplace: { itemId: job.itemId, marketplace: job.marketplace } };
    const existing = await tx.marketplaceListing.findUnique({ where });
    const blocked = publishBlockReason(existing);
    if (blocked) return blocked;
    const now = new Date();
    await tx.marketplaceListing.upsert({
      where,
      create: { itemId: job.itemId, marketplace: job.marketplace, status: "unknown", lastAttemptAt: now, attemptCount: 1, lastError: UNKNOWN },
      update: {
        status: "unknown", lastAttemptAt: now, attemptCount: { increment: 1 }, lastError: UNKNOWN,
        externalListingId: null, externalUrl: null, publishedAt: null, endedAt: null,
      },
    });
    return null;
  });
}

/** Listing and job success commit together, including a response recovered by hand. */
export async function completePublishAttempt(
  db: Store, jobId: number, result: PublishSuccess, copy: { price: number; title: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const job = await tx.publishJob.findUniqueOrThrow({ where: { id: jobId } });
    const identity = listingIdentity(job.marketplace, result.externalUrl ?? "");
    if (!identity || identity.id !== result.externalListingId) throw new Error("Marketplace did not return a valid listing identity.");
    if (result.publishedPrice !== undefined && (!Number.isFinite(result.publishedPrice) || result.publishedPrice <= 0)) throw new Error("Marketplace returned an invalid published price.");
    if (result.publishedTitle !== undefined && (typeof result.publishedTitle !== "string" || !result.publishedTitle.trim())) throw new Error("Marketplace returned an empty published title.");
    const item = await tx.item.findUniqueOrThrow({ where: { id: job.itemId }, select: { status: true } });
    const soldMeanwhile = item.status === "Sold";
    const previous = await tx.marketplaceListing.findUnique({ where: { itemId_marketplace: { itemId: job.itemId, marketplace: job.marketplace } } });
    const alreadySold = previous?.status === "sold" && previous.externalListingId === result.externalListingId;
    const now = new Date();
    await tx.marketplaceListing.update({
      where: { itemId_marketplace: { itemId: job.itemId, marketplace: job.marketplace } },
      data: { status: alreadySold ? "sold" : soldMeanwhile ? "delist_pending" : "published", externalListingId: result.externalListingId, externalUrl: result.externalUrl,
        publishedAt: now, lastError: null, price: result.publishedPrice ?? copy.price, title: result.publishedTitle ?? copy.title,
        ...(soldMeanwhile && !alreadySold ? { attemptCount: 0, lastAttemptAt: null } : {}) },
    });
    await tx.publishJob.update({ where: { id: jobId }, data: {
      status: "published", errorClass: null, lastError: null, validationJson: null, nextAttemptAt: null,
      externalListingId: result.externalListingId, externalUrl: result.externalUrl, finishedAt: now,
    } });
  });
}

/** Only an adapter's explicit proof that submission did not start permits retry. */
export async function recordUnsubmittedAttempt(db: Store, jobId: number, message: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const job = await tx.publishJob.findUniqueOrThrow({ where: { id: jobId } });
    await tx.marketplaceListing.updateMany({
      where: { itemId: job.itemId, marketplace: job.marketplace, status: "unknown" },
      data: { status: "not_published", lastError: message.slice(0, 2000) },
    });
  });
}

export async function recoverPublishAttempts(db: Store): Promise<number> {
  return db.$transaction(async (tx) => {
    const jobs = await tx.publishJob.findMany({ where: { status: "publishing" } });
    for (const job of jobs) {
      const where = { itemId_marketplace: { itemId: job.itemId, marketplace: job.marketplace } };
      const listing = await tx.marketplaceListing.findUnique({ where });
      const item = await tx.item.findUnique({ where: { id: job.itemId }, select: { status: true } });
      const saleState = listing && (["sold", "delist_pending", "delisting", "delist_unknown", "delist_failed"].includes(listing.status) || (listing.status === "ended" && item?.status === "Sold"));
      if (saleState) {
        // Do not overwrite a sale/removal with publication uncertainty, or
        // claim this interrupted job posted an older listing's identity.
        await tx.publishJob.update({ where: { id: job.id }, data: {
          status: "cancelled", lastError: "Item sold; interrupted publication will not resume. Its current listing/removal state was preserved.",
          errorClass: null, nextAttemptAt: null, finishedAt: new Date(),
        } });
      } else if (listing?.status === "published" && listing.externalListingId) {
        await tx.publishJob.update({ where: { id: job.id }, data: {
          status: "published", externalListingId: listing.externalListingId, externalUrl: listing.externalUrl,
          errorClass: null, lastError: null, nextAttemptAt: null, finishedAt: new Date(),
        } });
      } else if (listing?.status === "not_published") {
        await tx.publishJob.update({ where: { id: job.id }, data: {
          status: "queued", errorClass: null, nextAttemptAt: null, finishedAt: null,
          lastError: "Interrupted before submission; safe to retry.",
        } });
      } else {
        // Legacy jobs may have no reservation at all. Absence is not proof that
        // their browser never posted, so they need the same verification.
        await tx.marketplaceListing.upsert({ where,
          create: { itemId: job.itemId, marketplace: job.marketplace, status: "unknown", lastError: UNKNOWN },
          update: { status: "unknown", lastError: UNKNOWN },
        });
        await tx.publishJob.update({ where: { id: job.id }, data: {
          status: "requires_review", errorClass: "requires_review", lastError: UNKNOWN,
          nextAttemptAt: null, finishedAt: new Date(),
        } });
      }
    }
    return jobs.length;
  });
}

export function listingIdentity(marketplace: string, value: string): { id: string; url: string } | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.replace(/^www\./, "");
    if (host !== `${marketplace}.com`) return null;
    const patterns: Record<string, RegExp> = {
      depop: /^\/products\/((?!create\/?$)[a-z0-9][a-z0-9-]*)\/?$/i,
      ebay: /^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/,
      etsy: /^\/listing\/(\d+)(?:\/[^/]+)?\/?$/,
      poshmark: /^\/listing\/(?:[^/]+-)?([a-f0-9]{24})\/?$/i,
      mercari: /^\/us\/item\/(m\d{9,15})\/?$/,
    };
    const id = patterns[marketplace]?.exec(url.pathname)?.[1];
    if (!id) return null;
    return { id, url: `https://www.${host}${url.pathname}` };
  } catch { return null; }
}

/** Bind the confirmation to the job and listing actually presented for review. */
export function publicationVerificationRevision(
  job: Pick<PublishJob, "id" | "updatedAt" | "attemptCount" | "startedAt" | "status">,
  listing: Pick<MarketplaceListing, "id" | "updatedAt" | "attemptCount" | "lastAttemptAt" | "status" | "externalListingId" | "externalUrl">,
): string {
  return JSON.stringify([job.id, job.updatedAt, job.attemptCount, job.startedAt, job.status,
    listing.id, listing.updatedAt, listing.attemptCount, listing.lastAttemptAt, listing.status,
    listing.externalListingId, listing.externalUrl]);
}

/** Operator verification changes the durable listing record; Retry alone cannot. */
export async function resolvePublishAttempt(
  db: Store, jobId: number, outcome: "published" | "not_published", url: string | undefined, expectedRevision: string,
): Promise<{ ok: boolean; error?: string }> {
  return db.$transaction(async (tx) => {
    const job = await tx.publishJob.findUnique({ where: { id: jobId } });
    if (!job) return { ok: false, error: "Job not found." };
    // Updating an old error does not make that historical job the current attempt.
    const newer = await tx.publishJob.count({ where: {
      itemId: job.itemId, marketplace: job.marketplace, id: { gt: job.id },
    } });
    if (newer) return { ok: false, error: "A newer publication attempt exists. Refresh and review the current attempt." };
    if (!["requires_review", "failed", "cancelled"].includes(job.status)) return { ok: false, error: "This job is still active or already resolved." };
    const active = await tx.publishJob.count({ where: {
      itemId: job.itemId, marketplace: job.marketplace, status: { in: ["publishing", "queued", "retrying"] },
    } });
    if (active) return { ok: false, error: "Pause and finish the active job before resolving this listing." };
    const where = { itemId_marketplace: { itemId: job.itemId, marketplace: job.marketplace } };
    const listing = await tx.marketplaceListing.findUnique({ where });
    if (listing?.status !== "unknown") return { ok: false, error: "This listing does not need verification." };
    if (!expectedRevision || expectedRevision !== publicationVerificationRevision(job, listing)) {
      return { ok: false, error: "This publication attempt changed. Refresh and check the marketplace again before confirming." };
    }
    const identity = outcome === "published" ? listingIdentity(job.marketplace, url ?? "") : null;
    if (outcome === "published" && !identity) return { ok: false, error: "Enter the HTTPS listing URL from this marketplace." };
    const now = new Date();
    const item = await tx.item.findUniqueOrThrow({ where: { id: job.itemId }, select: { status: true } });
    const removeAfterVerification = !!identity && item.status === "Sold";
    await tx.marketplaceListing.update({ where, data: {
      status: removeAfterVerification ? "delist_pending" : outcome, externalListingId: identity?.id ?? null, externalUrl: identity?.url ?? null,
      publishedAt: identity ? now : null, lastError: identity ? null : "Verified by operator: not published.",
      ...(removeAfterVerification ? { attemptCount: 0, lastAttemptAt: null } : {}),
    } });
    await tx.publishJob.update({ where: { id: jobId }, data: {
      status: identity ? "published" : "failed", errorClass: identity ? null : "requires_review",
      lastError: identity ? null : "Verified by operator: not published. Ready to retry.",
      externalListingId: identity?.id ?? null, externalUrl: identity?.url ?? null,
      validationJson: null, nextAttemptAt: null, finishedAt: now,
    } });
    return { ok: true };
  });
}
