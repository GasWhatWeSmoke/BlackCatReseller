import { draftKey, localDraftDatabase, parseDraft } from "./itemDrafts.ts";
import { parseReviewCheckpoint, type ReviewCheckpoint } from "./reviewCheckpoint.ts";

export async function withReviewLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This app window cannot reserve review work. Reopen the desktop app.");
  return navigator.locks.request(`blackcat-review:${name}`, { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock) throw new Error("Another window is working on this approval. Wait for it to finish.");
    return action();
  });
}

export async function listReviewCheckpoints(): Promise<ReviewCheckpoint[]> {
  const db = await localDraftDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts", "readonly").objectStore("drafts").getAll(IDBKeyRange.bound("reviewed:", "reviewed:\uffff"));
    request.onsuccess = () => { try { resolve(request.result.map(parseReviewCheckpoint)); } catch (error) { reject(error); } };
    request.onerror = () => reject(new Error("Local review checkpoints could not be loaded."));
  });
}

export async function readReviewCheckpoint(key: string): Promise<ReviewCheckpoint | null> {
  const db = await localDraftDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
    request.onsuccess = () => { try { resolve(request.result == null ? null : parseReviewCheckpoint(request.result)); } catch (error) { reject(error); } };
    request.onerror = () => reject(new Error("The individual review checkpoint could not be loaded."));
  });
}

/** Check the checkpoint and all three editing surfaces in the same transaction. */
async function changeCheckpoint(checkpoint: ReviewCheckpoint, change: (previous: ReviewCheckpoint | null) => ReviewCheckpoint | null,
  requireNoDrafts = false): Promise<ReviewCheckpoint | null> {
  const db = await localDraftDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" });
    const store = tx.objectStore("drafts");
    let failure: unknown, result: ReviewCheckpoint | null = null;
    const keys = [checkpoint.key, ...(["review", "editor", "pricing"] as const).map(scope => draftKey(scope, checkpoint))];
    const found: unknown[] = []; let remaining = keys.length;
    keys.forEach((key, index) => {
      const read = store.get(key);
      read.onsuccess = () => {
        found[index] = read.result;
        if (--remaining) return;
        try {
          if (requireNoDrafts && keys.slice(1).some((draftKey, index) => {
            const draft = parseDraft(found[index + 1], draftKey);
            return draft && Object.keys(draft.changes).length > 0;
          })) throw new Error("This item has unfinished local edits. Save or discard them before marking it reviewed or approving it.");
          result = change(found[0] == null ? null : parseReviewCheckpoint(found[0]));
          if (result) { parseReviewCheckpoint(result); store.put(result); } else store.delete(checkpoint.key);
        } catch (error) { failure = error; tx.abort(); }
      };
    });
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? new Error("The review checkpoint could not be saved. No approval should be repeated automatically."));
    tx.onerror = () => { /* onabort reports the result */ };
  });
}

export async function putReviewCheckpoint(checkpoint: ReviewCheckpoint): Promise<ReviewCheckpoint> {
  return (await changeCheckpoint(checkpoint, previous => {
    if (previous?.phase === "approving" && previous.itemVersion === checkpoint.itemVersion)
      throw new Error("The earlier approval is unresolved. Review fresh saved details before trying again.");
    return checkpoint;
  }, true))!;
}

export async function claimReviewCheckpoint(checkpoint: ReviewCheckpoint): Promise<ReviewCheckpoint> {
  return (await changeCheckpoint(checkpoint, previous => {
    if (!previous || previous.revision !== checkpoint.revision || previous.phase !== "reviewed")
      throw new Error("This review changed after the batch summary. Reload the batch before approving.");
    return { ...previous, phase: "approving", revision: crypto.randomUUID(), attempt: crypto.randomUUID(), note: "Approval started; confirm its result before retrying." };
  }, true))!;
}

export async function finishReviewCheckpoint(claim: ReviewCheckpoint, phase: ReviewCheckpoint["phase"], note: string) {
  return changeCheckpoint(claim, previous => {
    if (!previous || previous.attempt !== claim.attempt || previous.phase !== "approving") throw new Error("The approval record changed. Reload to check the saved item.");
    return { ...previous, phase, note, revision: crypto.randomUUID() };
  });
}

export async function forgetReviewCheckpoint(checkpoint: ReviewCheckpoint) {
  return withReviewLock(checkpoint.key, () => changeCheckpoint(checkpoint, previous => {
    if (previous && previous.revision !== checkpoint.revision) throw new Error("This review changed in another window. Reload first.");
    return null;
  }));
}
