import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { runBrowserWorker } from "./browserWorker.ts";
import { parseBrowserReport } from "./browserProtocol.ts";
import { currentUploadPhase } from "./liveProgress.ts";
import type { CanonicalListing } from "./types.ts";
import type { AppSettingsData } from "../types.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-browser-worker-"));
  const settings = { dataRoot: root, logsPath: root } as AppSettingsData;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined,
  });
  t.after(async () => {
    child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { settings, child, launch: () => child as unknown as ChildProcessWithoutNullStreams };
}

test("a report does not release the browser before the worker exits, and stdin carries the reviewed copy", async (t) => {
  const { settings, child, launch } = fixture(t);
  const listing = { sku: "000001", title: "Current title", price: 34.99, photos: [] } as unknown as CanonicalListing;
  let input = "";
  child.stdin.on("data", (data) => { input += data.toString(); });
  let settled = false;
  const result = runBrowserWorker(settings, listing, { marketplace: "ebay", mode: "post", launch });
  void result.then(() => { settled = true; });
  child.stdout.write('EBAY_DONE {"outcome":"posted","url":"https://www.ebay.com/itm/123456789012"}\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(JSON.parse(input), listing);
  child.emit("close", 0);
  assert.equal((await result).done?.outcome, "posted");
});

test("UTF-8 characters split between output chunks remain intact", async (t) => {
  const { settings, child, launch } = fixture(t);
  const result = runBrowserWorker(settings, { sku: "000002" } as CanonicalListing, { marketplace: "depop", mode: "post", launch });
  const output = Buffer.from('DEPOP_DONE {"outcome":"failed","reason":"café","submissionStarted":false}\n');
  const split = output.indexOf(Buffer.from("é")) + 1;
  child.stdout.write(output.subarray(0, split));
  child.stdout.write(output.subarray(split));
  child.emit("close", 0);
  assert.equal((await result).done?.reason, "café");
});

test("worker progress reaches the UI while running, without treating it as publication", async (t) => {
  const { settings, child, launch } = fixture(t);
  const result = runBrowserWorker(settings, { sku: "progress-stream" } as CanonicalListing, { marketplace: "ebay", mode: "post", launch });
  child.stdout.write('BLACKCAT_PROGRESS {"stage":"ver');
  child.stdout.write('ifying"}\n');
  assert.equal(currentUploadPhase("ebay", "progress-stream")?.stage, "verifying");
  child.emit("close", 1);
  assert.equal((await result).done, null);
  assert.equal(currentUploadPhase("ebay", "progress-stream"), null);
});

test("a worker that exits without reporting remains ambiguous", async (t) => {
  const { settings, child, launch } = fixture(t);
  const result = runBrowserWorker(settings, { sku: "000003" } as CanonicalListing, { marketplace: "ebay", mode: "post", launch });
  child.emit("close", 1);
  assert.equal((await result).done, null);
});

test("a spawn failure is explicitly unsubmitted", async (t) => {
  const { settings, child, launch } = fixture(t);
  const result = runBrowserWorker(settings, { sku: "000004" } as CanonicalListing, { marketplace: "ebay", mode: "post", launch });
  child.emit("error", new Error("spawn ENOENT"));
  assert.equal((await result).done?.submissionStarted, false);
});

test("the final report must belong to the requested platform and be a valid object", () => {
  assert.equal(parseBrowserReport('DEPOP_DONE {"outcome":"posted"}\n', "EBAY_DONE"), null);
  assert.equal(parseBrowserReport('EBAY_DONE null\n', "EBAY_DONE"), null);
  assert.equal(parseBrowserReport('EBAY_DONE {"outcome":"posted"}\nEBAY_DONE broken\n', "EBAY_DONE"), null);
});
