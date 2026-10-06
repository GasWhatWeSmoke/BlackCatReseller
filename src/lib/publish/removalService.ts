import { prisma } from "../db.ts";
import { getSettings } from "../settings.ts";
import { processRemovalQueue } from "./removalQueue.ts";

let active = false;
let recovered = false;
let lastError: string | null = null;
let lastFinishedAt: string | null = null;
let waitingForBrowser = false;

export function removalServiceStatus() {
  return { active, lastError, lastFinishedAt, waitingForBrowser };
}

/** Start a bounded background pass so a long browser operation does not depend
 * on the initiating HTTP connection staying open. Status remains pollable. */
export function startRemovalPass(): boolean {
  if (active) return false;
  active = true;
  lastError = null;
  waitingForBrowser = false;
  void (async () => {
    try {
      const result = await processRemovalQueue(prisma, await getSettings(), { recoverInterrupted: !recovered });
      waitingForBrowser = result.busy;
      if (!result.busy) recovered = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      lastFinishedAt = new Date().toISOString();
      active = false;
    }
  })();
  return true;
}
