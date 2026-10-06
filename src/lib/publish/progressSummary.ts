import type { StatusPayload } from "./uiTypes.ts";

export function progressSummary(status: StatusPayload) {
  const platforms = (status.run?.marketplaces ?? []).map(marketplace => {
    const counts = status.byMarketplace?.[marketplace] ?? {};
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return { marketplace, total, published: counts.published ?? 0,
      attention: (counts.failed ?? 0) + (counts.requires_review ?? 0),
      cancelled: counts.cancelled ?? 0, active: counts.publishing ?? 0,
      queued: (counts.queued ?? 0) + (counts.retrying ?? 0) };
  });
  const published = platforms.reduce((sum, p) => sum + p.published, 0);
  const total = status.run?.totalJobs ?? 0;
  const attention = platforms.reduce((sum, p) => sum + p.attention, 0);
  const queued = platforms.reduce((sum, p) => sum + p.queued, 0);
  const active = platforms.reduce((sum, p) => sum + p.active, 0);
  const cancelled = platforms.reduce((sum, p) => sum + p.cancelled, 0);
  const pieces = new Map<number, boolean>();
  for (const job of status.jobs ?? []) pieces.set(job.itemId, (pieces.get(job.itemId) ?? true) && job.status === "published");
  return { platforms, published, total, attention, queued, active, cancelled,
    percent: total > 0 ? Math.min(100, Math.floor(100 * published / total)) : 0,
    totalPieces: pieces.size, completedPieces: [...pieces.values()].filter(Boolean).length };
}

export function uploadStageLabel(stage?: string, photoCount?: number) {
  switch (stage) {
    case "opening": return "Opening marketplace";
    case "photos": return photoCount ? `Uploading ${photoCount} photos` : "Uploading photos";
    case "details": return "Filling listing details";
    case "checking": return "Checking photos and details";
    case "publishing": return "Submitting listing";
    case "verifying": return "Confirming the listing is live";
    default: return "Preparing marketplace upload";
  }
}

export function elapsedTime(start: string, end: number) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
