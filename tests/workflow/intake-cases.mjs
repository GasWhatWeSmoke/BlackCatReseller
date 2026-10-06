import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Uses the same owned fixture, real import/worker/persistence and no-AI boundary
// as the lifecycle runner. No recognition or marketplace result is supplied here.
export async function nativeIntakeCase(stage, { root, fixture, settings, db, intake, importer, persist }) {
  const read = name => JSON.parse(fs.readFileSync(path.join(fixture, name), 'utf8'));
  const write = (name, value) => fs.writeFileSync(path.join(fixture, name), JSON.stringify(value, null, 2));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const incoming = () => Object.fromEntries(fs.readdirSync(settings.incomingPath).sort().map(name => [name, hash(path.join(settings.incomingPath, name))]));
  function files(directory) {
    assert.ok(path.resolve(directory).startsWith(fixture + path.sep));
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? files(file) : [file];
    });
  }
  async function untouched(before) {
    assert.deepEqual(incoming(), before);
    for (const model of ['item', 'photo', 'batch', 'fileHash']) assert.equal(await db[model].count(), 0, model);
    for (const key of ['processingPath', 'archivePath', 'needsReviewPath', 'readyPath']) assert.deepEqual(files(settings[key]), [], key);
  }
  if (stage === 'corrupt') {
    assert.equal(await db.item.count(), 0);
    execFileSync(settings.pythonWorkerPath, [path.join(root, 'tests/workflow/photos.py'), fixture, '50'], {
      cwd: root, env: { ...process.env, PYTHONPATH: '', PYTHONIOENCODING: 'utf-8' }, windowsHide: true,
    });
    const manifest = read('camera-manifest.json');
    for (const photo of manifest.files) {
      if (photo.sku === '900050' && photo.marker) continue;
      await importer.writeIncomingPhoto(settings.incomingPath, photo.filename, fs.readFileSync(path.join(fixture, 'camera', photo.filename)));
    }
    await importer.writeIncomingPhoto(settings.incomingPath, 'BROKEN.jpg', Buffer.from('Owned unreadable JPEG fixture'));
    const before = incoming(); assert.equal(Object.keys(before).length, 200);
    const handle = intake.startIntake(settings, { forceNoAi: true });
    let failure;
    try { await handle.result; } catch (error) { failure = error; }
    assert.ok(failure, 'Unreadable input must not produce a success receipt');
    await untouched(before);
    write('case-before.json', before);
    console.error(JSON.stringify({ stage: 'corrupt', error: failure.message, preserved: true, itemsCreated: 0 }));
    assert.match(failure.message, /BROKEN\.jpg/, 'The operator must be told which camera file needs attention');
    return { inputFiles: 200, preserved: true, itemsCreated: 0, error: failure.message };
  }
  if (stage === 'cancel') {
    const before = read('case-before.json'); await untouched(before);
    const quarantine = path.join(fixture, 'quarantine'); fs.mkdirSync(quarantine);
    fs.renameSync(path.join(settings.incomingPath, 'BROKEN.jpg'), path.join(quarantine, 'BROKEN.jpg'));
    assert.equal(hash(path.join(quarantine, 'BROKEN.jpg')), before['BROKEN.jpg']);
    delete before['BROKEN.jpg']; write('case-before.json', before);
    const handle = intake.startIntake(settings, { forceNoAi: true });
    let requested = false;
    const unsubscribe = handle.subscribe(event => {
      if (!requested && event.event === 'progress' && event.stage === 'hash') requested = handle.cancel();
    });
    try { await assert.rejects(handle.result, error => error.code === 'VISION_CANCELLED'); }
    finally { unsubscribe(); }
    assert.equal(requested, true);
    const admission = await handle.admission;
    assert.ok(admission.ok ? admission.mode === 'no-ai' : admission.kind === 'cancelled');
    await untouched(before);
    return { cancelled: true, inputFiles: 199, preserved: true, itemsCreated: 0 };
  }
  if (stage === 'resume') {
    const before = read('case-before.json'); await untouched(before);
    const manifest = read('camera-manifest.json'), byName = new Map(manifest.files.map(photo => [photo.filename, photo]));
    const result = await intake.runIntake(settings, undefined, { forceNoAi: true });
    assert.equal(result.items.length, 50);
    const shells = result.items.filter(item => item.placeholder); assert.equal(shells.length, 1);
    assert.equal(shells[0].grouping.confidence, 'low');
    assert.equal(result.items.some(item => item.sku === '900050'), false);
    for (const item of result.items) {
      assert.equal(item.enrichment.skipped, true);
      assert.equal(item.grouping.orderSource, 'exif');
      assert.equal(item.photos.length, item.placeholder ? 3 : 4);
      for (const photo of item.photos) {
        const camera = byName.get(photo.originalFilename); assert.ok(camera);
        assert.equal(camera.sku, item.placeholder ? '900050' : item.sku);
        assert.equal(photo.sha256, camera.sha256); assert.equal(hash(photo.storedPath), camera.sha256);
        assert.equal(photo.isMarker, camera.marker);
        assert.equal(photo.includeInListing, !camera.marker);
      }
    }
    const summary = await persist(result, settings);
    assert.equal(summary.itemsCreated, 50); assert.equal(summary.aiSkipped, 50); assert.equal(summary.aiFailed, 0);
    const rows = await db.item.findMany({ orderBy: { id: 'asc' }, include: { photos: { orderBy: { id: 'asc' } } } });
    assert.equal(rows.filter(item => item.isShell).length, 1);
    assert.ok(rows.every(item => item.status === 'Photographed' && !item.readyFolderPath));
    assert.equal(await db.photo.count(), 199); assert.deepEqual(incoming(), {});
    for (const photo of manifest.files) assert.equal(hash(path.join(fixture, 'camera', photo.filename)), photo.sha256);
    const archived = files(settings.archivePath); assert.equal(archived.length, 199);
    for (const file of archived) assert.equal(hash(file), before[path.basename(file)]);
    assert.equal(fs.readFileSync(path.join(fixture, 'quarantine/BROKEN.jpg'), 'utf8'), 'Owned unreadable JPEG fixture');
    for (const photo of manifest.files.filter(photo => photo.sku === '900001'))
      await importer.writeIncomingPhoto(settings.incomingPath, photo.filename, fs.readFileSync(path.join(fixture, 'camera', photo.filename)));
    const duplicate = await persist(await intake.runIntake(settings, undefined, { forceNoAi: true }), settings);
    assert.equal(duplicate.itemsCreated, 0); assert.equal(duplicate.duplicatesSkipped, 4);
    assert.deepEqual(await db.item.findMany({ orderBy: { id: 'asc' }, include: { photos: { orderBy: { id: 'asc' } } } }), rows);
    assert.deepEqual(incoming(), {});
    return { items: 50, decodedMarkers: 49, photoRows: 199, archivedOriginals: 199, cameraOriginals: 200,
      shell: { sku: shells[0].sku, confidence: shells[0].grouping.confidence, photos: 3 },
      noAutomaticApproval: true, reimport: duplicate, problems: result.problems.map(problem => problem.type) };
  }
  throw Error('Unknown native intake case');
}
