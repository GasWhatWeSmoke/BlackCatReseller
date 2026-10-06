interface EngineState {
  running: boolean;
  recovered: boolean;
  lastPublishAt: Map<string, number>;
  consecutiveFailures: Map<number, number>;
}
const key = Symbol.for("blackcat.publishEngine");
const engines = globalThis as unknown as Record<symbol, EngineState | undefined>;

/** Startup automation and API routes can load separate bundles. They must own
 * the same engine lock and recovery state for this server process. */
export function publishEngineState(): EngineState {
  return engines[key] ??= { running: false, recovered: false, lastPublishAt: new Map(), consecutiveFailures: new Map() };
}
