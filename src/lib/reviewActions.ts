type Requester = (url: string, init: RequestInit) => Promise<Response>;

export async function saveReviewItem(id: number, changes: Record<string, unknown>, approve: boolean, request: Requester = fetch) {
  const response = await request(`/api/items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
  const saved = await response.json().catch(() => null);
  if (!response.ok || !saved?.item) throw new Error(saved?.error || "The item did not save. Your draft is still here.");
  if (!approve) return { item: saved.item, approved: false, copyWarnings: [] as string[] };
  const readyResponse = await request(`/api/items/${id}/ready`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requirePrice: true, expectedUpdatedAt: saved.item.updatedAt }) });
  const ready = await readyResponse.json().catch(() => null);
  if (!readyResponse.ok || !ready?.ok) throw new Error(ready?.error === "GATE_FAILED"
    ? `Details saved, but approval needs: ${(ready.missing ?? []).join(", ") || "more listing photos"}.`
    : `Details saved, but approval failed: ${ready?.message || ready?.error || "try again"}`);
  return { item: ready.item ?? saved.item, approved: true, copyWarnings: (ready.copyWarnings ?? []) as string[] };
}

export function reviewQueueIndex(index: number, length: number) { return Math.max(0, Math.min(index, Math.max(0, length - 1))); }
