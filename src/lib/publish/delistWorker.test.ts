import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettingsData } from "../types.ts";
import { parseRemovalReport, runDelistWorker, type RemovalRequest } from "./delistWorker.ts";

const request: RemovalRequest = { listingId: 7, marketplace: "poshmark", externalListingId: "abcdef123456789012345678",
  externalUrl: "https://poshmark.com/listing/Shirt-abcdef123456789012345678", attempt: 2 };
const verified = { outcome: "ended", verified: true, submissionStarted: true,
  externalListingId: request.externalListingId, url: request.externalUrl };
const report = (value: unknown) => `POSHMARK_END_DONE ${JSON.stringify(value)}\n`;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-delist-worker-"));
  const settings = { dataRoot: root, logsPath: root } as AppSettingsData;
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined,
    kill() { killed = true; return true; },
  });
  t.after(async () => {
    child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { settings, child, wasKilled: () => killed, launch: () => child as unknown as ChildProcessWithoutNullStreams };
}

test("only exact verified removal reports certify unavailability", () => {
  assert.equal(parseRemovalReport(report(verified), request)?.outcome, "ended");
  for (const invalid of [null, [], { ...verified, verified: false }, { ...verified, externalListingId: "other" },
    { ...verified, url: "https://example.com/listing/abcdef123456789012345678" },
    { ...verified, outcome: "inspected" }, { ...verified, submissionStarted: "false" }]) {
    assert.equal(parseRemovalReport(report(invalid), request), null);
  }
  assert.equal(parseRemovalReport('POSHMARK_DONE {"outcome":"posted"}\n', request), null);
  assert.equal(parseRemovalReport(report(verified) + "POSHMARK_END_DONE broken\n", request), null);
});

test("failure after any possible submission remains unknown", () => {
  assert.equal(parseRemovalReport(report({ outcome: "failed", verified: false, submissionStarted: false }), request)?.outcome, "failed");
  for (const submissionStarted of [true, undefined, "false"]) {
    assert.equal(parseRemovalReport(report({ outcome: "failed", verified: false, submissionStarted }), request)?.outcome, "unknown");
  }
});

test("Depop removal requires its own report prefix and product identity", () => {
  const depop = { ...request, marketplace: "depop", externalListingId: "seller-shirt", externalUrl: "https://www.depop.com/products/seller-shirt/" };
  const value = { ...verified, externalListingId: depop.externalListingId, url: depop.externalUrl };
  assert.equal(parseRemovalReport(`DEPOP_END_DONE ${JSON.stringify(value)}\n`, depop)?.outcome, "ended");
  assert.equal(parseRemovalReport(report(value), depop), null);
  assert.equal(parseRemovalReport(`DEPOP_END_DONE ${JSON.stringify(verified)}\n`, depop), null);
});

test("eBay and Etsy removal reports require the same exact identity and availability proof", () => {
  for (const marketplace of ["ebay", "etsy", "mercari"]) {
    const externalListingId = marketplace === "mercari" ? "m123456789012" : "123456789012";
    const target = { ...request, marketplace, externalListingId,
      externalUrl: `https://www.${marketplace}.com/${marketplace === "ebay" ? "itm" : marketplace === "mercari" ? "us/item" : "listing"}/${externalListingId}` };
    const value = { ...verified, externalListingId: target.externalListingId, url: target.externalUrl };
    const encode = (body: unknown) => `${marketplace.toUpperCase()}_END_DONE ${JSON.stringify(body)}\n`;
    assert.equal(parseRemovalReport(encode(value), target)?.outcome, "ended");
    assert.equal(parseRemovalReport(encode({ ...value, verified: false }), target), null);
    assert.equal(parseRemovalReport(encode({ ...value, externalListingId: "999999999999" }), target), null);
  }
});

test("the native end command receives the exact attempt and retains ownership until close", async (t) => {
  const { settings, child, launch } = fixture(t);
  let input = "", settled = false;
  child.stdin.on("data", (chunk) => { input += chunk.toString(); });
  const result = runDelistWorker(settings, request, { launch: (args) => {
    assert.deepEqual(args, ["-m", "black_cat_worker.end_poshmark", "--mode", "end", "--listing-stdin"]);
    return launch();
  } });
  void result.then(() => { settled = true; });
  child.stdout.write(report(verified));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(JSON.parse(input), request);
  child.emit("close", 0);
  assert.equal((await result).outcome, "ended");
});

test("stderr output and silent worker exit cannot certify removal", async (t) => {
  const { settings, child, launch } = fixture(t);
  const result = runDelistWorker(settings, request, { launch });
  child.stderr.write(report(verified));
  child.emit("close", 1);
  assert.equal((await result).outcome, "unknown");
});

test("timeout retains the claim until close and cannot be overwritten by late success", async (t) => {
  const { settings, child, launch, wasKilled } = fixture(t);
  let settled = false;
  const result = runDelistWorker(settings, request, { launch, timeoutMs: 5 });
  void result.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(wasKilled(), true);
  assert.equal(settled, false);
  child.stdout.write(report(verified));
  child.emit("close", 1);
  assert.equal((await result).outcome, "unknown");
});

test("unspawned worker failure is explicitly unsubmitted", async (t) => {
  const { settings, child, launch } = fixture(t);
  const result = runDelistWorker(settings, request, { launch });
  child.emit("error", new Error("spawn ENOENT"));
  assert.deepEqual(await result, { outcome: "failed", verified: false, submissionStarted: false, reason: "spawn ENOENT" });
});

test("unsupported platforms and mismatched identities never start a removal process", async (t) => {
  const { settings } = fixture(t);
  for (const invalid of [{ ...request, marketplace: "amazon" }, { ...request, listingId: -1 }, { ...request, externalListingId: "other" }]) {
    const result = await runDelistWorker(settings, invalid, { launch() { throw new Error("must not launch"); } });
    assert.equal(result.submissionStarted, false);
    assert.match(result.reason!, /supported marketplace and exact listing/);
  }
});
