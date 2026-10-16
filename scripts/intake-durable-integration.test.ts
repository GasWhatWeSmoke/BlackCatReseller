import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { spawn } from "node:child_process";
import ts from "typescript";
import { PrismaClient } from "@prisma/client";
import * as listing from "../src/lib/listing.ts";
import * as archive from "../src/lib/fileArchive.ts";
import * as outcome from "../src/lib/intakeOutcome.ts";
import * as store from "../src/lib/intakeJobStore.ts";
import * as worker from "../src/lib/worker.ts";
import { validateWorkerResult } from "../src/lib/workerResultValidation.ts";
import { validateIntakeCorrections, type IntakeManifest } from "../src/lib/intakeReview.ts";
import { readIntakeReview } from "../src/lib/intakeReviewStore.ts";
import type { AppSettingsData, WorkerItem, WorkerResult } from "../src/lib/types.ts";

// The app-wide DB client and child launch are injected. The actual service,
// worker receipt validation, SQLite transactions, archive moves, and durable
// job/manifest files run unchanged against this test's exclusive workspace.
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

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-durable-integration-")));
  const database = path.join(root, "catalog.db"); fs.copyFileSync("config/template.db", database);
  const db = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-durable-integration-")); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { dataRoot: root, incomingPath: path.join(root, "incoming"), processingPath: path.join(root, "processing"),
    archivePath: path.join(root, "archive"), needsReviewPath: path.join(root, "review"), readyPath: path.join(root, "ready"),
    visionEnabled: false } as AppSettingsData;
  for (const directory of [settings.incomingPath, settings.processingPath, settings.archivePath, settings.needsReviewPath, settings.readyPath]) fs.mkdirSync(directory);
  const persistence = load("src/lib/persist.ts", { "node:path": path, "./db": { prisma: db }, "./listing": listing,
    "./fileArchive": archive, "./intakeOutcome": outcome, "./backup": { backupDatabase: async () => {} } });
  let spawns = 0;
  let childResult: WorkerResult;
  const service = load("src/lib/intakeJobs.ts", {
    "node:fs": fs, "node:path": path, "node:crypto": crypto, "./intakeJobStore": store,
    "./db": { prisma: db }, "./persist": persistence,
    "./workerResultValidation": { validateWorkerResult },
    "./worker": { ...worker, startIntake: (_settings: AppSettingsData, options: worker.IntakeOptions) => {
      spawns++;
      writeManifest(options.jobId!, childResult.items.concat(childResult.collisions));
      return { admission: Promise.resolve({ ok: true, mode: "no-ai" }),
        result: Promise.resolve(validateWorkerResult(childResult, settings)), cancel: () => { throw Error("Unexpected cancellation"); } };
    } },
  });
  function item(sku: string, ordinal: number, collision = false): WorkerItem {
    const folder = path.join(settings.processingPath, collision ? `${sku}__incoming-fixture` : sku);
    fs.mkdirSync(folder, { recursive: true });
    const photos = [false, true].map((isMarker, index) => {
      const originalFilename = `IMG_${String(ordinal * 2 + index).padStart(5, "0")}.jpg`;
      const content = Buffer.from(`fixture original ${originalFilename} ${sku}`);
      fs.writeFileSync(path.join(settings.incomingPath, originalFilename), content);
      const storedPath = path.join(folder, originalFilename); fs.writeFileSync(storedPath, content);
      return { originalFilename, storedPath, thumbPath: null, sha256: crypto.createHash("sha256").update(content).digest("hex"),
        sortOrder: index, isCover: !isMarker, isMarker, includeInListing: !isMarker, rotation: 0,
        decodedValue: isMarker ? sku : null, decodeMethod: isMarker ? "ocr" : null,
        width: 1200, height: 1600, exifDateTimeOriginal: null, exifSubSec: null };
    });
    return { sku, originalQrValue: sku, processingFolderPath: folder, photos,
      originalPaths: photos.map(photo => path.join(settings.incomingPath, photo.originalFilename)), placeholder: false,
      enrichment: { fields: { brand: "Fixture" }, aiFields: ["brand"], raw: {} },
      grouping: { confidence: "high", reasons: [], closedBy: "ocr-marker", orderSource: "filename",
        log: photos.map(photo => ({ file: photo.originalFilename, role: photo.isMarker ? "marker" : "photo",
          time: null, gapBeforeSec: null, decode: photo.decodeMethod, raw: photo.decodedValue })) } };
  }
  function result(items: WorkerItem[], collisions: WorkerItem[] = []): WorkerResult {
    return { batchId: "fixture", items, collisions, duplicates: [], needsReview: [], problems: [], durationMs: 1,
      counts: { itemsCreated: items.length, photosProcessed: items.concat(collisions).reduce((n, item) => n + item.photos.length, 0),
        duplicatesSkipped: 0, problems: 0, collisions: collisions.length } };
  }
  function writeManifest(id: string, items: WorkerItem[]): IntakeManifest {
    const directory = store.intakeJobDir(settings, id), sources = path.join(directory, "sources");
    fs.mkdirSync(sources, { recursive: true });
    const photos = items.flatMap(item => item.photos).map((photo, sequenceIndex) => {
      const id = `photo-${sequenceIndex}`, storedPath = path.join(sources, `${id}.jpg`);
      fs.copyFileSync(photo.storedPath, storedPath);
      return { id, sequenceIndex, storedPath, originalFilename: photo.originalFilename, sha256: photo.sha256!,
        originalPath: path.join(settings.incomingPath, photo.originalFilename) };
    });
    const manifest: IntakeManifest = { version: 2, photos, orderSource: "filename", orderReviewRequired: false };
    store.writeIntakeJson(path.join(directory, "manifest.json"), manifest);
    return manifest;
  }
  function crashedJob(id: string): store.IntakeJob {
    const now = new Date().toISOString();
    const job: store.IntakeJob = { id, state: "persisting", stage: "persisting", createdAt: now, updatedAt: now, heartbeatAt: now,
      ownerPid: 2_147_483_647, attempt: 1, manifestRevision: 0, forceNoAi: true, seq: 1, event: null };
    store.saveIntakeJob(settings, job); return job;
  }
  return { root, db, settings, service, persistence, item, result, writeManifest, crashedJob, spawns: () => spawns,
    setChildResult: (value: WorkerResult) => { childResult = value; } };
}

test("service resumes a partially committed saved receipt without reprocessing archived photos or duplicating inventory", async t => {
  const f = await fixture(t), items = [f.item("BC-000042", 0), f.item("BC-000043", 1)];
  f.setChildResult(f.result(items));
  await f.db.$executeRawUnsafe("CREATE TRIGGER fail_second BEFORE INSERT ON Item WHEN NEW.sku='BC-000043' BEGIN SELECT RAISE(ABORT,'injected interruption'); END");
  const live = f.service.startIntakeJob(f.settings, { forceNoAi: true });
  assert.equal(f.service.startIntakeJob(f.settings, { forceNoAi: true }), live);
  await live.terminal;
  assert.equal(live.job.state, "failed"); assert.equal(f.spawns(), 1);
  assert.equal(await f.db.item.count(), 1); assert.equal(await f.db.photo.count(), 2);
  assert.equal(fs.existsSync(items[0].originalPaths![0]), false);
  assert.equal(fs.existsSync(items[1].originalPaths![0]), true);
  assert.deepEqual(live.job.committedPhotoIds, ["photo-0", "photo-1"]);
  await f.db.$executeRawUnsafe("DROP TRIGGER fail_second");
  const retry = f.service.startIntakeJob(f.settings, { forceNoAi: true, resumeJobId: live.job.id });
  await retry.terminal;
  assert.equal(retry.job.state, "completed");
  assert.equal(await f.db.problemLog.count({ where: { type: "IMPORT_FAILED", resolved: true } }), 1, "recovered failure remains in diagnostic history");
  assert.equal(f.spawns(), 1, "saved validated result needs no new child");
  assert.equal(await f.db.batch.count(), 1); assert.equal(await f.db.item.count(), 2);
  assert.equal(await f.db.photo.count(), 4); assert.equal(await f.db.collision.count(), 0);
  assert.deepEqual(retry.job.committedPhotoIds, ["photo-0", "photo-1", "photo-2", "photo-3"]);
  for (const item of items) for (const original of item.originalPaths!) {
    assert.equal(fs.existsSync(original), false);
    assert.ok(fs.existsSync(path.join(f.settings.archivePath, "fixture", path.basename(original))));
  }
  const again = f.service.startIntakeJob(f.settings, { forceNoAi: true, resumeJobId: live.job.id });
  await again.terminal;
  assert.equal(f.spawns(), 1); assert.equal(await f.db.item.count(), 2); assert.equal(await f.db.batch.count(), 1);
});

test("crash after SQLite commit reconstructs saved photo protection before accepting a manual correction", async t => {
  const f = await fixture(t), id = crypto.randomUUID(), item = f.item("BC-000042", 0), raw = f.result([item]);
  const manifest = f.writeManifest(id, [item]); f.crashedJob(id);
  store.writeIntakeJson(path.join(store.intakeJobDir(f.settings, id), "result.json"), raw);
  await f.persistence.persistWorkerResult(validateWorkerResult(raw, f.settings), f.settings, { jobId: id, revision: 0 });
  // Simulates process death after commit/archive, before the JSON committed checkpoint.
  assert.equal(store.readIntakeJob(f.settings, id)!.committedPhotoIds, undefined);
  await assert.rejects(f.service.withIntakeJobMutation(f.settings, id, async (job: store.IntakeJob) => {
    validateIntakeCorrections({ expectedRevision: 0, markers: { "photo-1": "BC-000099" } }, manifest, null, new Set(job.committedPhotoIds));
  }), /already saved/);
  assert.equal((await f.db.item.findFirstOrThrow()).sku, "BC-000042");
  assert.deepEqual(store.readIntakeJob(f.settings, id)!.committedPhotoIds, ["photo-0", "photo-1"]);
  const retry = f.service.startIntakeJob(f.settings, { forceNoAi: true, resumeJobId: id }); await retry.terminal;
  assert.equal(retry.job.state, "completed"); assert.equal(f.spawns(), 0);
  assert.equal(await f.db.item.count(), 1); assert.equal(await f.db.intakeReceipt.count(), 1);
});

test("saved collision groups protect their archived source photos during later batch correction", async t => {
  const f = await fixture(t), id = crypto.randomUUID(), collision = f.item("BC-000042", 0, true);
  await f.db.item.create({ data: { sku: "BC-000042" } });
  const manifest = f.writeManifest(id, [collision]); f.crashedJob(id);
  const raw = f.result([], [collision]);
  store.writeIntakeJson(path.join(store.intakeJobDir(f.settings, id), "result.json"), raw);
  await f.persistence.persistWorkerResult(validateWorkerResult(raw, f.settings), f.settings, { jobId: id, revision: 0 });
  await assert.rejects(f.service.withIntakeJobMutation(f.settings, id, async (job: store.IntakeJob) => {
    validateIntakeCorrections({ expectedRevision: 0, markers: { "photo-1": "BC-000099" } }, manifest, null, new Set(job.committedPhotoIds));
  }), /already saved/);
  assert.equal(await f.db.collision.count({ where: { status: "pending" } }), 1);
  assert.equal(await f.db.item.count(), 1);
  assert.deepEqual(store.readIntakeJob(f.settings, id)!.committedPhotoIds, ["photo-0", "photo-1"]);
  const retry = f.service.startIntakeJob(f.settings, { forceNoAi: true, resumeJobId: id }); await retry.terminal;
  assert.equal(retry.job.state, "completed_with_review"); assert.equal(f.spawns(), 0);
  assert.equal(await f.db.collision.count(), 1); assert.equal(await f.db.batch.count(), 1);
});

test("explicitly corrected marker and source order survive receipt validation and real inventory persistence", async t => {
  const f = await fixture(t), item = f.item("BC-000042", 0);
  item.grouping = { ...item.grouping!, closedBy: "manual-marker", orderSource: "manual" } as WorkerItem["grouping"];
  f.setChildResult(f.result([item]));
  const job = f.service.startIntakeJob(f.settings, { forceNoAi: true }); await job.terminal;
  assert.equal(job.job.state, "completed");
  const saved = await f.db.item.findFirstOrThrow();
  assert.equal(saved.sku, "BC-000042");
  assert.equal(JSON.parse(saved.groupingLogJson!).closedBy, "manual-marker");
  assert.equal(JSON.parse(saved.groupingLogJson!).orderSource, "manual");
});

test("a job ID from another local workspace cannot be read, corrected, or resumed", async t => {
  const one = await fixture(t), two = await fixture(t), id = crypto.randomUUID();
  one.crashedJob(id);
  assert.equal(store.readIntakeJob(two.settings, id), null);
  assert.throws(() => readIntakeReview(two.settings, id), /not found in this workspace/);
  await assert.rejects(two.service.withIntakeJobMutation(two.settings, id, async () => { throw Error("must not enter"); }), /not found/);
  assert.throws(() => two.service.startIntakeJob(two.settings, { forceNoAi: true, resumeJobId: id }), /not found/);
  assert.equal(await two.db.item.count(), 0); assert.equal(await two.db.intakeReceipt.count(), 0);
  assert.equal(two.spawns(), 0); assert.equal(store.intakeLeaseActive(two.settings), false);
  assert.equal(store.readIntakeJob(one.settings, id)!.attempt, 1);
});

test("an orphaned live child blocks resume, source import, and corrections until it exits", async t => {
  const f = await fixture(t), id = crypto.randomUUID();
  const job = f.crashedJob(id); job.workerPid = process.pid; store.saveIntakeJob(f.settings, job);
  assert.throws(() => f.service.startIntakeJob(f.settings, { forceNoAi: true, resumeJobId: id }), /previous worker|INTAKE_BUSY/);
  assert.throws(() => store.acquireIntakeLease(f.settings, "photo-import"), /INTAKE_BUSY/);
  await assert.rejects(f.service.withIntakeJobMutation(f.settings, id, async () => { throw Error("must not enter"); }), /INTAKE_BUSY/);
  assert.equal(f.spawns(), 0); assert.equal(await f.db.item.count(), 0);
  assert.equal(store.intakeLeaseActive(f.settings), false, "rejected contenders leave no ticket behind");
});

test("independent server processes recover stale leases and never overlap incoming-work ownership", { timeout: 20_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-lease-processes-")));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const leases = path.join(root, "intake-jobs", "leases"); fs.mkdirSync(leases, { recursive: true });
  const stale = path.join(leases, "dead-owner.json");
  fs.writeFileSync(stale, JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", jobId: crypto.randomUUID(), ticket: 1 }));
  const source = `import fs from 'node:fs';
    import path from 'node:path';
    import { acquireIntakeLease } from ${JSON.stringify(new URL("../src/lib/intakeJobStore.ts", import.meta.url).href)};
    const root = process.argv[1], guard = path.join(root, 'exclusive-owner');
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(root, 'start'))) { if (Date.now() > deadline) throw Error('start timed out'); await pause(2); }
    for (let acquired = 0; acquired < 15;) {
      if (Date.now() > deadline) throw Error('lease acquisition timed out');
      let release;
      try { release = acquireIntakeLease({dataRoot: root}, 'process-' + process.pid); }
      catch (error) { if (error.message !== 'INTAKE_BUSY') throw error; await pause(1 + Math.floor(Math.random() * 4)); continue; }
      let fd;
      try {
        fd = fs.openSync(guard, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        await pause(3);
        fs.closeSync(fd); fd = undefined; fs.unlinkSync(guard); acquired++;
      } finally { if (fd !== undefined) fs.closeSync(fd); release(); }
      await pause(1);
    }
    console.log('completed 15 exclusive acquisitions');`;
  const pending = Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", value => { output += value; });
    child.stderr.setEncoding("utf8").on("data", value => { output += value; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(output) : reject(Error(`Lease contender exited ${code}: ${output}`)));
    t.after(() => { if (child.exitCode === null) child.kill(); });
  }));
  fs.writeFileSync(path.join(root, "start"), "start");
  for (const result of await Promise.all(pending)) assert.match(result, /completed 15 exclusive acquisitions/);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(path.join(root, "exclusive-owner")), false);
  assert.equal(store.intakeLeaseActive({ dataRoot: root }), false);
  assert.deepEqual(fs.readdirSync(leases), []);
});
