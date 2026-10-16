import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import * as store from "./intakeJobStore.ts";
import * as worker from "./worker.ts";
import { parseProcessIntent } from "./types.ts";
import { validateManagedWorkRoots, InvalidManagedWorkRootsError } from "./workRoots.ts";
import type { AppSettingsData, WorkerResult } from "./types.ts";

function load(filename: string, dependencies: Record<string, unknown>) {
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports: Record<string, any> = {};
  vm.compileFunction(source, ["exports", "require"], { filename })(exports, (name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  });
  return exports;
}

test("HTTP disconnect and refresh detach observers while one service job finishes and persists", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-job-lifecycle-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { dataRoot: root, incomingPath: path.join(root, "incoming"), processingPath: path.join(root, "processing"),
    archivePath: path.join(root, "archive"), needsReviewPath: path.join(root, "review"), readyPath: path.join(root, "ready"),
    visionEnabled: false } as AppSettingsData;
  let spawns = 0, cancels = 0, commits = 0;
  let resolveResult!: (result: WorkerResult) => void;
  let progress!: (event: Record<string, unknown>) => void;
  const result = new Promise<WorkerResult>(resolve => { resolveResult = resolve; });
  const service = load("src/lib/intakeJobs.ts", {
    "node:fs": fs, "node:path": path, "node:crypto": crypto, "./intakeJobStore": store,
    "./db": { prisma: { intakeReceipt: { findUnique: async () => null } } },
    "./persist": { persistWorkerResult: async () => { commits++; return { batchId: 7, itemsCreated: 40, problems: 0, collisions: 0, needsReview: 0 }; } },
    "./workerResultValidation": { validateWorkerResult: (value: unknown) => value },
    "./worker": { ...worker, startIntake: (_settings: AppSettingsData, options: worker.IntakeOptions) => {
      spawns++; progress = options.onProgress!;
      return { admission: Promise.resolve({ ok: true, mode: "no-ai" }), result, cancel: () => { cancels++; }, subscribe: () => () => {} };
    } },
  });
  const route = load("src/app/api/process/route.ts", {
    "@/lib/settings": { getSettings: async () => settings }, "@/lib/types": { parseProcessIntent },
    "@/lib/worker": { workerPythonExists: () => true }, "@/lib/intakeJobs": service,
    "@/lib/intakeJobStore": store, "@/lib/workRoots": { validateManagedWorkRoots, InvalidManagedWorkRootsError },
    "@/lib/visionServer": { managedVisionStatus: async () => ({ ok: true, kind: "ready" }) },
  });
  const request = () => new Request("http://localhost/api/process", { method: "POST", body: JSON.stringify({ force: true }) });
  const first = await route.POST(request()) as Response;
  assert.equal(first.status, 200);
  const id = service.intakeJobSnapshot(settings).job.id;
  const reader = first.body!.getReader();
  await reader.read();
  await reader.cancel(); // exactly what navigation does to its fetch stream
  assert.equal(cancels, 0);
  progress({ stage: "decode", done: 200, total: 200 });
  assert.equal(store.readIntakeJob(settings, id)!.event!.done, 200);
  const repeat = await route.POST(request()) as Response;
  assert.equal(spawns, 1, "reconnecting / repeated starts must attach to the same job");
  assert.equal(service.intakeJobSnapshot(settings).job.id, id);
  const terminal = service.existingIntakeJob(settings).terminal;
  resolveResult({ batchId: "fixture", items: [], collisions: [], duplicates: [], needsReview: [], problems: [], durationMs: 1,
    counts: { itemsCreated: 0, photosProcessed: 200, duplicatesSkipped: 0, collisions: 0, problems: 0 } });
  await terminal;
  const stream = await repeat.text();
  assert.match(stream, /"type":"done"/);
  assert.equal(commits, 1);
  assert.equal(cancels, 0);
  assert.equal(service.intakeJobSnapshot(settings).running, false);
  assert.equal(store.readIntakeJob(settings, id)!.state, "completed");
  assert.equal(store.intakeLeaseActive(settings), false);
});

test("explicit cancel during queued checkpoint work prevents spawning and remains resumable", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-job-cancel-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { dataRoot: root } as AppSettingsData;
  let releaseLookup!: (value: null) => void;
  const lookup = new Promise<null>(resolve => { releaseLookup = resolve; });
  let spawns = 0, commits = 0;
  const result = { batchId: "fixture", items: [], collisions: [], duplicates: [], needsReview: [], problems: [], durationMs: 1,
    counts: { itemsCreated: 0, photosProcessed: 0, duplicatesSkipped: 0, collisions: 0, problems: 0 } };
  const service = load("src/lib/intakeJobs.ts", {
    "node:fs": fs, "node:path": path, "node:crypto": crypto, "./intakeJobStore": store,
    "./db": { prisma: { intakeReceipt: { findUnique: () => lookup } } },
    "./persist": { persistWorkerResult: async () => { commits++; return { batchId: 1, itemsCreated: 0, problems: 0, collisions: 0, needsReview: 0 }; } },
    "./workerResultValidation": { validateWorkerResult: (value: unknown) => value },
    "./worker": { ...worker, startIntake: () => {
      spawns++;
      return { admission: Promise.resolve({ ok: true, mode: "no-ai" }), result: Promise.resolve(result), cancel: () => true };
    } },
  });
  const queued = service.startIntakeJob(settings, { forceNoAi: true });
  assert.equal(queued.job.state, "queued");
  const cancelled = service.cancelIntakeJob(settings);
  releaseLookup(null);
  assert.equal(await cancelled, true);
  assert.equal((await queued.admission).kind, "cancelled");
  assert.equal(spawns, 0);
  assert.equal(commits, 0);
  assert.equal(store.readIntakeJob(settings, queued.job.id)!.state, "cancelled");
  assert.equal(store.intakeLeaseActive(settings), false);
  const resumed = service.startIntakeJob(settings, { forceNoAi: true, resumeJobId: queued.job.id });
  await resumed.terminal;
  assert.equal(spawns, 1);
  assert.equal(commits, 1);
  assert.equal(store.readIntakeJob(settings, queued.job.id)!.state, "completed");
});
