import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExport } from "./worker.ts";
import type { AppSettingsData } from "./types.ts";

type Reply = { code?: number; stdout?: string; stderr?: string; error?: Error };
function fakeWorker(t: TestContext, reply: (spec: Record<string, unknown>) => Reply) {
  const original = childProcess.spawn;
  const specs: string[] = [];
  childProcess.spawn = ((_exe: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const specPath = args.at(-1)!; specs.push(specPath);
    setImmediate(() => {
      try {
        const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
        const result = reply(spec);
        if (result.error) { child.emit("error", result.error); return; }
        child.stdout.end(result.stdout ?? `${JSON.stringify({ ok: true, readyDir: spec.readyDir })}\n`);
        child.stderr.end(result.stderr ?? "");
        child.emit("close", result.code ?? 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  return specs;
}
const settings = { dataRoot: os.tmpdir(), pythonWorkerPath: "test-worker" } as AppSettingsData;
const readyDir = path.join(os.tmpdir(), "blackcat-export-result");
function assertClean(specs: string[]) {
  for (const file of specs) {
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.dirname(file)), false);
  }
}

test("simultaneous exports keep distinct specs and return their own folders even in the same millisecond", async t => {
  const specs = fakeWorker(t, spec => {
    assert.equal(spec.title, "Reviewed café shirt");
    return {};
  });
  const originalClock = Date.now; Date.now = () => 1789900000123;
  t.after(() => { Date.now = originalClock; });
  const folders = Array.from({ length: 24 }, (_, index) => path.join(readyDir, String(index)));
  const results = await Promise.all(folders.map(folder => runExport(settings, { readyDir: folder, title: "Reviewed café shirt" })));
  assert.deepEqual(results, folders);
  assert.equal(new Set(specs).size, 24);
  assertClean(specs);
});

test("a success-looking receipt cannot override a failed worker exit", async t => {
  const specs = fakeWorker(t, () => ({ code: 7, stderr: "Rotation could not be completed." }));
  await assert.rejects(runExport(settings, { readyDir }), /exit 7.*Rotation could not be completed/);
  assertClean(specs);
});

test("only one valid success receipt for the requested folder completes export", async t => {
  let output = "";
  const specs = fakeWorker(t, () => ({ stdout: output }));
  const good = JSON.stringify({ ok: true, readyDir });
  for (const invalid of ["", `${good}\n${good}\n`, `${good}\nnoise\n`, good,
    "null\n", "[]\n", `{"readyDir":}\n`, JSON.stringify({ ok: false, readyDir }) + "\n",
    JSON.stringify({ ok: true, readyDir: path.join(readyDir, "another-item") }) + "\n"]) {
    output = invalid;
    await assert.rejects(runExport(settings, { readyDir }), /Export/);
  }
  assertClean(specs);
});

test("worker startup failures still clean up the private export spec", async t => {
  const specs = fakeWorker(t, () => ({ error: new Error("worker startup failed") }));
  await assert.rejects(runExport(settings, { readyDir }), /worker startup failed/);
  assertClean(specs);
});

test("export rejects missing or relative result folders before spawning", async t => {
  const specs = fakeWorker(t, () => ({}));
  for (const folder of [undefined, "", "relative", 12]) {
    await assert.rejects(runExport(settings, { readyDir: folder }), /absolute ready folder/);
  }
  assert.equal(specs.length, 0);
});
