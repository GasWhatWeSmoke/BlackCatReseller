import { reviewRules, type ReviewItem } from "./reviewCheckpoint.ts";
import { claimReviewCheckpoint, finishReviewCheckpoint, withReviewLock } from "./reviewCheckpointStore.ts";
import type { BatchReviewOperations } from "./bulkReview.ts";

export async function readReviewItem(id: number): Promise<ReviewItem | null> {
  const response = await fetch(`/api/items/${id}`);
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.item || !Array.isArray(body.item.photos)) throw new Error("The current saved item could not be verified. Reload before approving.");
  return body.item;
}

export async function readReviewRules() {
  const response = await fetch("/api/settings");
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.settings) throw new Error(body?.error || "Saved approval settings could not be verified.");
  return reviewRules(body.settings);
}

export const browserReviewOperations: BatchReviewOperations = {
  readItem: readReviewItem, readRules: readReviewRules, claim: claimReviewCheckpoint, finish: finishReviewCheckpoint,
  exclusive: withReviewLock,
  approve: async item => {
    const response = await fetch(`/api/items/${item.id}/ready`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirePrice: true, expectedUpdatedAt: item.updatedAt }) });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.ok === true && result.item?.id === item.id) {
      if (!["Ready", "Ready for Nifty"].includes(result.item.status))
        return { kind: "blocked", message: `Preparation finished, but the saved item is ${result.item.status || "in another state"}. Check Inventory or Crosslisting before another approval.` };
      return { kind: "approved", message: result.copyWarnings?.length ? `Approved. ${result.copyWarnings.join("; ")}` : "Approved for Crosslisting." };
    }
    // EXPORT_FAILED is returned only before the export activates its saved snapshot.
    if ([400, 404, 409, 422].includes(response.status) || result?.error === "EXPORT_FAILED")
      return { kind: "blocked", message: result?.error === "GATE_FAILED" ? `Approval needs: ${(result.missing ?? []).join(", ") || "more listing photos"}.`
        : result?.message || result?.error || "The item could not be approved. Review its current details." };
    return { kind: "unknown", message: "Approval could not be confirmed. Check Inventory or Crosslisting before retrying." };
  },
};
