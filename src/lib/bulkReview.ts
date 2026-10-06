import { checkpointProblem, type ReviewCheckpoint, type ReviewItem, type ReviewRules } from "./reviewCheckpoint.ts";

export interface ApprovalOutcome { kind: "approved" | "blocked" | "unknown"; message: string }
export interface BatchApprovalResult extends ApprovalOutcome { id: number; sku: string }
export const MAX_REVIEW_BATCH = 100;

export interface BatchReviewOperations {
  readItem: (id: number) => Promise<ReviewItem | null>;
  readRules: () => Promise<ReviewRules>;
  claim: (checkpoint: ReviewCheckpoint) => Promise<ReviewCheckpoint>;
  finish: (claim: ReviewCheckpoint, kind: ApprovalOutcome["kind"], message: string) => Promise<unknown>;
  approve: (item: ReviewItem) => Promise<ApprovalOutcome>;
  exclusive: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}

/** One bounded, operator-confirmed batch. Never retry an unclear approval. */
export async function approveReviewedBatch(checkpoints: ReviewCheckpoint[], confirmedRules: ReviewRules, operations: BatchReviewOperations,
  options: { stopped: () => boolean; progress: (result: BatchApprovalResult, completed: number) => void }) {
  if (!checkpoints.length || checkpoints.length > MAX_REVIEW_BATCH || new Set(checkpoints.map(row => row.key)).size !== checkpoints.length)
    throw new Error(`Select between 1 and ${MAX_REVIEW_BATCH} distinct, individually reviewed items.`);
  return operations.exclusive("batch", async () => {
    const results: BatchApprovalResult[] = [];
    for (const checkpoint of checkpoints) {
      if (options.stopped()) break;
      let outcome: ApprovalOutcome;
      try {
        const rules = await operations.readRules();
        if (JSON.stringify(rules) !== JSON.stringify(confirmedRules)) throw new Error("Approval or Auto Run settings changed. Review a fresh batch summary before continuing.");
        outcome = await operations.exclusive(checkpoint.key, async () => {
          const item = await operations.readItem(checkpoint.id);
          const problem = await checkpointProblem(checkpoint, item, rules);
          if (problem || !item) return { kind: "blocked" as const, message: problem || "Item unavailable." };
          let claim: ReviewCheckpoint;
          try { claim = await operations.claim(checkpoint); }
          catch (error) { return { kind: "blocked" as const, message: error instanceof Error ? error.message : "The review checkpoint could not be reserved." }; }
          let result: ApprovalOutcome;
          try { result = await operations.approve(item); }
          catch { result = { kind: "unknown", message: "Approval response was lost. Check Inventory or Crosslisting before taking another action; no automatic retry was made." }; }
          try { await operations.finish(claim, result.kind, result.message); }
          catch { return { kind: "unknown" as const, message: "The approval record could not be updated. Check the saved item before retrying; remaining approvals have stopped." }; }
          return result;
        });
      } catch (error) {
        outcome = { kind: "blocked", message: error instanceof Error ? error.message : "The batch could not verify its current settings or item state." };
        const result = { ...outcome, id: checkpoint.id, sku: checkpoint.sku };
        results.push(result); options.progress(result, results.length);
        break;
      }
      const result = { ...outcome, id: checkpoint.id, sku: checkpoint.sku };
      results.push(result); options.progress(result, results.length);
      if (outcome.kind === "unknown") break;
    }
    return { results, remaining: checkpoints.length - results.length };
  });
}
