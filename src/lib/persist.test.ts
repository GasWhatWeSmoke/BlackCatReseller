import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { PrismaClient } from "@prisma/client";
import * as listing from "./listing.ts";
import * as archive from "./fileArchive.ts";
import * as outcome from "./intakeOutcome.ts";
import type { PersistSummary } from "./persist.ts";
import type { AppSettingsData, WorkerItem, WorkerResult } from "./types.ts";

// Execute the actual persistence function against SQLite and files. Substitute only
// its app-wide client and backup hook, so no production settings/DB can be opened.
const source = ts.transpileModule(fs.readFileSync(new URL("./persist.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-persist-outcome-"));
  const file = path.join(root, "test.db"); fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-persist-outcome-")); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { archivePath: path.join(root, "archive"), needsReviewPath: path.join(root, "review") } as AppSettingsData;
  let backups = 0;
  const dependencies: Record<string, unknown> = { "node:path": path, "./db": { prisma: db }, "./listing": listing,
    "./fileArchive": archive, "./intakeOutcome": outcome, "./backup": { backupDatabase: async () => { backups++; } } };
  const exports: Record<string, unknown> = {};
  vm.compileFunction(source, ["exports", "require"], { filename: "persist.ts" })(exports, (name: string) => {
    assert.ok(name in dependencies, `Unexpected persistence dependency ${name}`); return dependencies[name];
  });
  const persist = exports.persistWorkerResult as (result: WorkerResult, settings: AppSettingsData) => Promise<PersistSummary>;
  let receipt = 0;
  async function run(items: WorkerItem[] = [], collisions: WorkerItem[] = [], duplicates = 0) {
    const result = { batchId: `fixture-${++receipt}`, items, collisions, duplicates: [], needsReview: [], problems: [], durationMs: 1,
      counts: { itemsCreated: items.length, photosProcessed: [...items, ...collisions].reduce((n, it) => n + it.photos.length, duplicates),
        duplicatesSkipped: duplicates, problems: 0, collisions: collisions.length } } as WorkerResult;
    const summary = await persist(result, settings);
    const batch = await db.batch.findUniqueOrThrow({ where: { id: summary.batchId } });
    const saved = JSON.parse(batch.summaryJson!);
    for (const key of ["itemsCreated", "duplicatesSkipped", "problems", "collisions"] as const) {
      assert.equal(batch[key], summary[key]); assert.equal(saved[key], summary[key]);
    }
    for (const key of ["aiFailed", "aiSkipped", "aiTotal"] as const) assert.equal(saved[key], summary[key]);
    assert.equal(backups, receipt);
    return summary;
  }
  function item(sku: string, error?: string, hashes = [`hash-${sku}`]): WorkerItem {
    const original = path.join(root, `${sku}-${receipt}.original.jpg`); fs.writeFileSync(original, `original-${sku}`);
    return { sku, originalPaths: [original], processingFolderPath: root,
      enrichment: error ? { error, ...(outcome.isAiSkipped(error) ? { skipped: true } : {}) } : { fields: { brand: "Fixture" } },
      photos: hashes.map((sha256, index) => ({ originalFilename: `${sku}-${index}.jpg`, storedPath: path.join(root, `${sku}-${index}.jpg`),
        thumbPath: null, sha256, sortOrder: index, isCover: index === 0, isMarker: false, includeInListing: true, rotation: 0 })) } as WorkerItem;
  }
  return { db, root, run, item };
}

test("100 no-AI items retain their reason and originals without false problem rows", async t => {
  const f = await fixture(t);
  const items = Array.from({ length: 100 }, (_, n) => f.item(`NOAI-${n}`, outcome.AI_SKIPPED_BY_OPERATOR));
  const summary = await f.run(items);
  assert.equal(summary.itemsCreated, 100); assert.equal(summary.aiTotal, 100); assert.equal(summary.aiSkipped, 100);
  assert.equal(summary.aiFailed, 0); assert.equal(summary.aiFirstError, undefined); assert.equal(summary.problems, 0);
  assert.equal(await f.db.problemLog.count(), 0);
  assert.equal(await f.db.item.count({ where: { aiError: outcome.AI_SKIPPED_BY_OPERATOR, photoCount: 1 } }), 100);
  assert.equal(await f.db.photo.count(), 100);
  for (const item of items) {
    const archived = path.join(f.root, "archive", "fixture-1", path.basename(item.originalPaths![0]));
    assert.equal(fs.readFileSync(archived, "utf8"), `original-${item.sku}`);
  }
});

test("a mixed batch records actual AI failures independently of intentional skips and shells", async t => {
  const f = await fixture(t);
  const summary = await f.run([f.item("SKIP", outcome.AI_SKIPPED_BY_OPERATOR), f.item("FAIL", "Model output invalid"),
    f.item("OK"), f.item("SHELL", "No listing photos", [])]);
  assert.equal(summary.itemsCreated, 4); assert.equal(summary.aiTotal, 3); assert.equal(summary.aiSkipped, 1);
  assert.equal(summary.aiFailed, 1); assert.equal(summary.aiFirstError, "Model output invalid");
  const problems = await f.db.problemLog.findMany(); assert.equal(problems.length, 1);
  assert.equal(problems[0].type, "AI_ENRICH_FAILED"); assert.match(problems[0].message!, /1 of 2 attempted/);
});

test("100 exact reimports count photos from worker and late collisions without changing existing inventory", async t => {
  const f = await fixture(t);
  const originals = Array.from({ length: 100 }, (_, n) => f.item(`REIMPORT-${n}`, undefined, [`photo-${n}`, `marker-${n}`]));
  await f.run(originals);
  const beforeItems = await f.db.item.findMany({ orderBy: { id: "asc" } });
  const beforePhotos = await f.db.photo.findMany({ orderBy: { id: "asc" } });
  const repeat = originals.map(it => f.item(it.sku, undefined, it.photos.map(p => p.sha256!)));
  const summary = await f.run(repeat.slice(0, 50), repeat.slice(50), 3);
  assert.equal(summary.itemsCreated, 0); assert.equal(summary.duplicatesSkipped, 203);
  assert.equal(summary.collisions, 0); assert.equal(summary.problems, 0);
  assert.equal(await f.db.collision.count({ where: { status: "resolved", resolution: "duplicate-skip" } }), 100);
  assert.deepEqual(await f.db.item.findMany({ orderBy: { id: "asc" } }), beforeItems);
  assert.deepEqual(await f.db.photo.findMany({ orderBy: { id: "asc" } }), beforePhotos);
  assert.ok(outcome.intakeFeedback(summary).ok);
});

test("new and unverified photos keep a reimport pending instead of being counted as duplicates", async t => {
  const f = await fixture(t); await f.run([f.item("EXISTING")]);
  for (const hash of ["new-hash", ""]) {
    const summary = await f.run([], [f.item("EXISTING", undefined, ["hash-EXISTING", hash])]);
    assert.equal(summary.duplicatesSkipped, 0); assert.equal(summary.collisions, 1);
  }
  assert.equal(await f.db.item.count(), 1); assert.equal(await f.db.photo.count(), 1);
});

test("failed duplicate recording does not claim a successful skip or archive its original", async t => {
  const f = await fixture(t); await f.run([f.item("EXISTING")]);
  await f.db.$executeRawUnsafe("CREATE TRIGGER reject_collision BEFORE INSERT ON Collision BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const repeat = f.item("EXISTING");
  const summary = await f.run([], [repeat]);
  assert.equal(summary.duplicatesSkipped, 0); assert.equal(summary.problems, 1);
  assert.equal(fs.readFileSync(repeat.originalPaths![0], "utf8"), "original-EXISTING");
  assert.equal(await f.db.collision.count(), 0);
});
