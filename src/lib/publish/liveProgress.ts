export const UPLOAD_STAGES = ["opening", "photos", "details", "checking", "publishing", "verifying"] as const;
export type UploadStage = typeof UPLOAD_STAGES[number];
export interface UploadPhase { stage: UploadStage; photoCount?: number; updatedAt: string }
const key = Symbol.for("blackcat.publishProgress");
const globals = globalThis as unknown as Record<symbol, Map<string, UploadPhase> | undefined>;
const states = () => globals[key] ??= new Map<string, UploadPhase>();
const identity = (marketplace: string, sku: string) => `${marketplace}:${sku}`;

/** Transient browser telemetry; durable job outcomes remain the completion truth. */
export function beginUploadProgress(marketplace: string, sku: string) {
  const id = identity(marketplace, sku);
  const state: UploadPhase = { stage: "opening", updatedAt: new Date().toISOString() };
  states().set(id, state);
  let pending = "";
  return {
    feed(text: string) {
      pending += text;
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      if (pending.length > 8192) pending = "";
      for (const line of lines) {
        if (!line.startsWith("BLACKCAT_PROGRESS ") || line.length > 1024) continue;
        try {
          const data = JSON.parse(line.slice("BLACKCAT_PROGRESS ".length));
          if (!UPLOAD_STAGES.includes(data?.stage)) continue;
          state.stage = data.stage; state.updatedAt = new Date().toISOString();
          state.photoCount = Number.isInteger(data.photoCount) && data.photoCount > 0 && data.photoCount <= 32 ? data.photoCount : undefined;
        } catch { /* Ignore malformed telemetry without changing the posting result. */ }
      }
    },
    close() { if (states().get(id) === state) states().delete(id); },
  };
}

export function currentUploadPhase(marketplace: string, sku: string): UploadPhase | null {
  const value = states().get(identity(marketplace, sku));
  return value ? { ...value } : null;
}
