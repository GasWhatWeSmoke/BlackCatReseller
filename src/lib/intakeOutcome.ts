// Retain the existing saved reason so old no-AI batches remain understandable.
export const AI_SKIPPED_BY_OPERATOR = "AI identification skipped by operator request";

export function isAiSkipped(error: string | null | undefined): boolean {
  return error?.trim() === AI_SKIPPED_BY_OPERATOR;
}

export interface IntakeSummary {
  itemsCreated?: number;
  duplicatesSkipped?: number;
  collisions?: number;
  problems?: number;
  aiFailed?: number;
  aiSkipped?: number;
  aiTotal?: number;
  aiFirstError?: string;
}

/** Shared by folder intake and drag-and-drop; counts describe persisted outcomes. */
export function intakeFeedback(summary: IntakeSummary) {
  const created = summary.itemsCreated ?? 0;
  const duplicates = summary.duplicatesSkipped ?? 0;
  const collisions = summary.collisions ?? 0;
  const problems = summary.problems ?? 0;
  const skipped = summary.aiSkipped ?? 0;
  const failed = summary.aiFailed ?? 0;
  const details: string[] = [];
  if (created) details.push(`Added ${created} item(s) to inventory.`);
  if (skipped) details.push(`AI was skipped for ${skipped} item(s) as requested. Fill in their details or use Run AI in Review.`);
  if (failed) details.push(`AI identification failed for ${failed} of ${Math.max(failed, (summary.aiTotal ?? created) - skipped)} attempted item(s)${summary.aiFirstError ? `: ${summary.aiFirstError}` : ""}. Use Retry AI in Review.`);
  if (duplicates) details.push(`Skipped ${duplicates} identical photo(s) already present or repeated in this batch; existing items were kept.`);
  if (collisions) details.push(`${collisions} SKU conflict(s) need a decision under Collisions to resolve on the Dashboard.`);
  if (problems) details.push(`${problems} problem(s) need attention on the Dashboard.`);
  const warning = failed > 0 || collisions > 0 || problems > 0;
  if (!details.length) details.push("No items found. Check that each item ends with its SKU sticker photo, then try again.");
  return {
    created,
    ok: !warning && (created > 0 || duplicates > 0),
    tone: warning || (!created && !duplicates) ? "warning" as const : skipped || !created ? "message" as const : "success" as const,
    text: details.join(" "),
  };
}
