import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettingsData } from "../types.ts";
import { runSalesWorker } from "./salesWorker.ts";

const output = 'DEPOP_SALES_DONE {"ok":true,"complete":true,"receiptIds":[],"checkedReceiptIds":[],"confirmedReceiptIds":[],"observations":[]}\n';
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-sales-worker-"));
  let killed = false;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: undefined, kill() { killed = true; return true; } });
  t.after(async () => {
    child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { child, killed: () => killed, settings: { dataRoot: root, logsPath: root } as AppSettingsData,
    launch: () => child as unknown as ChildProcessWithoutNullStreams };
}

test("a sales report retains browser ownership until close and passes only confirmed receipt IDs", async (t) => {
  const { child, settings, launch } = fixture(t);
  let input = "", settled = false;
  child.stdin.on("data", (chunk) => { input += chunk.toString(); });
  const result = runSalesWorker(settings, "depop", ["123"], { launch(args) {
    assert.ok(args.includes("black_cat_worker.depop_sales"));
    assert.ok(args.includes("--known-confirmed-receipts-stdin"));
    assert.equal(args.includes("--mode"), false);
    return launch();
  } });
  void result.then(() => { settled = true; });
  child.stdout.write(output);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(JSON.parse(input), { receiptIds: ["123"] });
  child.emit("close", 0);
  assert.equal((await result).ok, true);
});

test("a timed-out scan cannot be certified by a late report", async (t) => {
  const { child, settings, launch, killed } = fixture(t);
  let settled = false;
  const result = runSalesWorker(settings, "depop", [], { launch, timeoutMs: 5 });
  void result.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(killed(), true); assert.equal(settled, false);
  child.stdout.write(output); child.emit("close", 1);
  const report = await result;
  assert.equal(report.ok, false); assert.equal(report.complete, false);
  assert.match(report.reason!, /timed out/);
});

test("stderr and missing reports cannot confirm sales", async (t) => {
  const { child, settings, launch } = fixture(t);
  const result = runSalesWorker(settings, "depop", [], { launch });
  child.stderr.write(output); child.emit("close", 1);
  assert.equal((await result).ok, false);
});

test("an unspawned read worker produces a failed scan", async (t) => {
  const { child, settings, launch } = fixture(t);
  const result = runSalesWorker(settings, "depop", [], { launch });
  child.emit("error", new Error("spawn ENOENT"));
  assert.equal((await result).ok, false);
});
