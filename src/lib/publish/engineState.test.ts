import test from "node:test";
import assert from "node:assert/strict";
import { publishEngineState } from "./engineState.ts";

test("startup and separately loaded route bundles share one publishing engine lock", async () => {
  const copy = await import(new URL('./engineState.ts?route-copy', import.meta.url).href);
  const startup = publishEngineState();
  try {
    startup.running = true; startup.lastPublishAt.set('depop', 123);
    const route = copy.publishEngineState();
    assert.equal(route, startup); assert.equal(route.running, true); assert.equal(route.lastPublishAt.get('depop'), 123);
  } finally { startup.running = false; startup.lastPublishAt.clear(); }
});
