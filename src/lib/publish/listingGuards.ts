import type { Prisma, PrismaClient } from "@prisma/client";

// Legacy reconciliation must not overwrite a direct listing or an in-flight
// upload. Explicit Nifty fallback after ended/failed direct attempts still works.
export const unlinkedHistoryWhere = {
  marketplaceListings: { none: { status: { notIn: ["ended", "not_published"] } } },
  publishJobs: { none: { status: { in: ["queued", "retrying", "publishing"] } } },
} satisfies Prisma.ItemWhereInput;

export const directUploadState = {
  marketplaceListings: { select: { marketplace: true, status: true } },
  publishJobs: {
    where: { status: { in: ["queued", "retrying", "publishing"] } },
    select: { marketplace: true, status: true },
  },
} satisfies Prisma.ItemInclude;

type DirectState = {
  marketplaceListings: { marketplace: string; status: string }[];
  publishJobs: { marketplace: string; status: string }[];
};

/** Nifty creates a new cross-listing, so it cannot be used as a retry for a
 *  direct attempt that is live, uncertain, or still queued. */
export function republicationBlockReason(item: DirectState): string | null {
  const listing = item.marketplaceListings.find((row) => !["ended", "not_published"].includes(row.status));
  if (listing) {
    if (listing.status === "sold") return "This item has sold through direct posting. It cannot be uploaded again automatically.";
    if (listing.status.startsWith("delist")) return "This item sold and its other listings are awaiting removal. Finish that before any new upload.";
    return listing.status === "published"
      ? `Already listed directly on ${listing.marketplace}. Creating another listing could duplicate it. Manage the existing listing first.`
      : `The direct ${listing.marketplace} attempt needs verification. Resolve it in Needs attention before another upload.`;
  }
  const job = item.publishJobs.find((row) => ["queued", "retrying", "publishing"].includes(row.status));
  return job ? `A direct ${job.marketplace} upload is pending. Finish or cancel that run before another upload.` : null;
}

/** Call after claiming the browser, before exporting or changing Nifty state. */
export async function checkExistingUploadState(db: Pick<PrismaClient, "item">, itemId: number): Promise<string | null> {
  const item = await db.item.findUnique({ where: { id: itemId }, include: directUploadState });
  return item ? republicationBlockReason(item) : "This item no longer exists.";
}

/** The queue may have validated before a Nifty run completed. Re-read while
 *  owning the browser so that stale validation cannot start a second listing. */
export async function checkDirectUploadOverlap(db: Pick<PrismaClient, "item">, itemId: number, allowNiftyOverlap = false): Promise<string | null> {
  const item = await db.item.findUnique({ where: { id: itemId }, select: { status: true, niftyStatus: true } });
  if (!item) return "This item no longer exists.";
  if (!["Ready", "Ready for Nifty"].includes(item.status)) return "This item is no longer approved for a new upload.";
  return !allowNiftyOverlap && ["Uploading", "Draft", "Published"].includes(item.niftyStatus ?? "")
    ? "This imported listing still needs reconciliation. Verify its marketplace links before publishing another copy." : null;
}
