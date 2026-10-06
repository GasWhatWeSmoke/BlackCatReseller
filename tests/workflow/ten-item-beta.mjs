import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const root = process.cwd(), fixture = path.resolve(process.argv[2]), python = path.resolve(process.argv[3]), scenario = process.argv[4];
assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
assert.ok(path.basename(fixture).startsWith('blackcat-workflow-ten-'));
assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'fixture-owner.json'), 'utf8')).fixture, true);
assert.ok(['complete', 'missing-marker'].includes(scenario));
assert.ok(fs.statSync(python).isFile());
const inside = file => path.resolve(file).startsWith(fixture + path.sep);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const require = createRequire(path.join(root, 'package.json')), ts = require('typescript'), { PrismaClient } = require('@prisma/client');
const file = path.join(fixture, 'inventory.db');
assert.equal(fs.existsSync(file), false);
fs.copyFileSync(path.join(root, 'config/template.db'), file);
const environment = { ...process.env, DATABASE_URL: 'file:' + file.replaceAll('\\', '/'), BLACKCAT_PREVIEW: '1', BLACKCAT_DATA_ROOT: fixture };
const db = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
const module = async name => import(pathToFileURL(path.join(root, 'src/lib', name + '.ts')).href);
const [listing, archive, outcome, prepared, copy, edit, importer, validation, roots] = await Promise.all([
  'listing', 'fileArchive', 'intakeOutcome', 'preparedPhotos', 'listingCopy', 'itemUpdate', 'importPhoto', 'workerResultValidation', 'workRoots',
].map(module));
function loadActual(relative, dependencies) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.compileFunction(source, ['exports', 'require', 'process'], { filename: relative })(exports, name => {
    if (!Object.hasOwn(dependencies, name)) throw Error('Unapproved fixture dependency: ' + name);
    return dependencies[name];
  }, { env: environment, cwd: () => root, pid: process.pid, platform: process.platform });
  return exports;
}
let backups = 0;
const worker = loadActual('src/lib/worker.ts', {
  'node:child_process': { spawn: (command, args, options) => {
    assert.equal(path.resolve(command), python);
    assert.equal(args[0], '-m');
    assert.ok(['black_cat_worker.process', 'black_cat_worker.export'].includes(args[1]));
    return spawn(command, args, { ...options, windowsHide: true });
  } }, 'node:path': path, 'node:fs': fs, 'node:os': os, 'node:crypto': crypto, 'node:string_decoder': { StringDecoder },
  './workerResultValidation.ts': validation, './workRoots.ts': roots,
});
const persist = loadActual('src/lib/persist.ts', {
  'node:path': path, './db': { prisma: db }, './listing': listing, './fileArchive': archive,
  './intakeOutcome': outcome, './backup': { backupDatabase: async () => { backups++; } },
}).persistWorkerResult;
const base = JSON.parse(fs.readFileSync(path.join(root, 'config/defaults.json'), 'utf8')).defaults;
const settings = { ...base, dataRoot: fixture, pythonWorkerPath: python, visionEnabled: false, ocrEnabled: false,
  tagOcrEnabled: false, publish: { autoRun: { enabled: false, marketplaces: [] } }, minListingPhotos: 3 };
for (const [key, name] of Object.entries({ incomingPath: 'incoming', processingPath: 'processing', archivePath: 'archive',
  needsReviewPath: 'needs-review', readyPath: 'ready', exportsPath: 'exports', backupsPath: 'backups', logsPath: 'logs' })) {
  settings[key] = path.join(fixture, name); fs.mkdirSync(settings[key]);
}
const exportItem = loadActual('src/lib/export-item.ts', {
  'node:path': path, 'node:fs': fs, 'node:crypto': crypto, '@/lib/db': { prisma: db },
  '@/lib/settings': { getRequiredSettings: async () => settings }, '@/lib/listingCopy': copy, '@/lib/listing': listing,
  './preparedPhotos': prepared, '@/lib/worker': { runExport: (config, spec) => {
    assert.ok(inside(spec.readyDir)); assert.ok(spec.listingPhotos.every(photo => inside(photo.src)));
    return worker.runExport(config, spec);
  } },
}).exportItemById;
const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'camera-manifest.json'), 'utf8'));
assert.equal(path.resolve(manifest.python), python, 'Camera generator must use the chosen fresh interpreter');
const source = new Map(manifest.files.map(photo => [photo.filename, photo]));
const selected = manifest.files.filter(photo => !(scenario === 'missing-marker' && photo.sku === '000010' && photo.marker));
try {
  for (const table of ['item', 'photo', 'publishJob', 'publishRun', 'marketplaceListing']) assert.equal(await db[table].count(), 0, table);
  await db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: JSON.stringify(settings) }, update: { data: JSON.stringify(settings) } });
  for (const photo of [...selected].reverse()) await importer.writeIncomingPhoto(settings.incomingPath, photo.filename, fs.readFileSync(path.join(fixture, 'camera', photo.filename)));
  const progress = [], result = await worker.runIntake(settings, event => progress.push(event), { forceNoAi: true });
  assert.equal(result.items.length, 10); assert.equal(result.collisions.length, 0);
  const shells = result.items.filter(item => item.placeholder);
  assert.equal(shells.length, scenario === 'missing-marker' ? 1 : 0);
  if (shells.length) { assert.equal(shells[0].grouping.confidence, 'low'); assert.notEqual(shells[0].sku, '000010'); }
  let markers = 0, garmentPhotos = 0;
  for (const item of result.items) {
    assert.equal(item.enrichment.skipped, true); assert.equal(item.grouping.orderSource, 'exif');
    assert.equal(item.photos.length, item.placeholder ? 3 : 4);
    if (!item.placeholder) assert.equal(item.originalQrValue, 'BC-' + item.sku);
    for (const photo of item.photos) {
      const camera = source.get(photo.originalFilename); assert.ok(camera);
      assert.equal(camera.sku, item.placeholder ? '000010' : item.sku);
      assert.equal(camera.sha256, photo.sha256); assert.ok(inside(photo.storedPath)); assert.equal(hash(photo.storedPath), camera.sha256);
      assert.equal(photo.isMarker, camera.marker); assert.equal(photo.includeInListing, !camera.marker);
      if (photo.isMarker) { markers++; assert.equal(photo.isCover, false); }
      else { garmentPhotos++; assert.ok(inside(photo.thumbPath)); assert.ok(fs.statSync(photo.thumbPath).isFile()); }
    }
  }
  assert.equal(markers, scenario === 'missing-marker' ? 9 : 10); assert.equal(garmentPhotos, 30);
  const summary = await persist(result, settings);
  assert.equal(summary.itemsCreated, 10); assert.equal(summary.aiSkipped, 10); assert.equal(summary.aiFailed, 0);
  let rows = await db.item.findMany({ orderBy: { id: 'asc' }, include: { photos: { orderBy: { id: 'asc' } } } });
  assert.equal(rows.length, 10); assert.equal(await db.photo.count(), selected.length);
  assert.ok(rows.every(item => item.status === 'Photographed' && !item.readyFolderPath && !item.size && !item.itemType && !item.color));
  assert.deepEqual(fs.readdirSync(settings.incomingPath), []);
  for (const photo of selected) assert.equal(hash(path.join(settings.archivePath, result.batchId, photo.filename)), photo.sha256);
  for (const photo of manifest.files) assert.equal(hash(path.join(fixture, 'camera', photo.filename)), photo.sha256);
  let exported = 0;
  if (scenario === 'complete') {
    for (const row of rows) {
      const before = await exportItem(row.id);
      assert.equal(before.ok, false); assert.equal(before.error, 'GATE_FAILED', 'Unreviewed no-AI items must require manual details');
      const saved = await edit.applyItemChanges(db, row.id, { brand: 'Practice', itemType: 'T-shirt', color: 'Blue', size: 'M',
        department: 'Men', condition: 'Good', category: 'Tops', listedPrice: 20, expectedValues: { updatedAt: row.updatedAt.toISOString() } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const preparedItem = await exportItem(row.id, { requirePrice: true, expectedUpdatedAt: saved.body.item.updatedAt.toISOString() });
      assert.equal(preparedItem.ok, true, JSON.stringify(preparedItem));
      const receipt = JSON.parse(fs.readFileSync(path.join(preparedItem.readyDir, 'item.json'), 'utf8'));
      assert.equal(receipt.photoSnapshot.itemId, row.id); assert.equal(receipt.photoSnapshot.sku, row.sku);
      assert.equal(receipt.listingPhotos.length, 3); assert.equal(receipt.photoSnapshot.recipe.length, 3);
      assert.equal(fs.readdirSync(path.join(preparedItem.readyDir, 'listing_photos')).length, 3);
      for (let i = 0; i < 3; i++) {
        const photo = receipt.photoSnapshot.recipe[i];
        const file = path.join(preparedItem.readyDir, 'listing_photos', photo.name);
        assert.ok(inside(file)); assert.equal(hash(file), receipt.photoSnapshot.files[i].sha256);
        const original = row.photos.find(sourcePhoto => sourcePhoto.id === photo.id && sourcePhoto.storedPath === photo.sourcePath);
        assert.ok(original && !original.isMarker, 'Only original garment photos can enter listing exports');
        assert.equal(hash(file), original.sha256, 'Unrotated exported bytes must match their original');
        exported++;
      }
    }
    assert.equal(exported, 30);
  }
  rows = await db.item.findMany({ orderBy: { id: 'asc' }, include: { photos: { orderBy: { id: 'asc' } } } });
  const repeat = scenario === 'complete' ? selected : selected.filter(photo => photo.sku === '000001');
  for (const photo of repeat) await importer.writeIncomingPhoto(settings.incomingPath, photo.filename, fs.readFileSync(path.join(fixture, 'camera', photo.filename)));
  const reimport = await persist(await worker.runIntake(settings, undefined, { forceNoAi: true }), settings);
  assert.equal(reimport.itemsCreated, 0); assert.equal(reimport.duplicatesSkipped, repeat.length); assert.equal(reimport.collisions, 0);
  assert.deepEqual(await db.item.findMany({ orderBy: { id: 'asc' }, include: { photos: { orderBy: { id: 'asc' } } } }), rows);
  assert.deepEqual(fs.readdirSync(settings.incomingPath), []);
  for (const table of ['publishJob', 'publishRun', 'marketplaceListing']) assert.equal(await db[table].count(), 0, table);
  if (scenario === 'missing-marker') assert.ok(rows.every(item => item.status === 'Photographed' && !item.readyFolderPath));
  const proof = { scenario, items: 10, sourcePhotos: selected.length, decodedMarkers: markers, garmentPhotos, archivedOriginals: selected.length,
    sourceHashesPreserved: true, noAutomaticApproval: true, manualFixtureEdits: scenario === 'complete' ? 10 : 0,
    exportedPhotos: exported, duplicatePhotosSkipped: reimport.duplicatesSkipped, itemPhotoSnapshotUnchangedOnReimport: true,
    missingMarkerShells: shells.length, problemTypes: result.problems.map(problem => problem.type), backupHookCalls: backups,
    workerPython: python, workerDurationMs: result.durationMs };
  fs.writeFileSync(path.join(fixture, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally { await db.$disconnect(); }
