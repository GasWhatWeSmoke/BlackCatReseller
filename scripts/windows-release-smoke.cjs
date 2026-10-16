// Packaged Windows acceptance on an owned disposable GitHub Actions runner.
// Uses synthetic inventory only; launches no marketplace browser or local model.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

assert.equal(process.platform, 'win32', 'This acceptance check requires Windows');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only on a disposable GitHub Actions runner');
const [baseline, updated, output] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(baseline && updated && output);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-ci-upgrade-'));
const database = path.join(root, 'data', 'black-cat.db');
const media = path.join(root, 'var');
const python = process.env.BLACKCAT_PYTHON;
assert.ok(python && fs.statSync(python).isFile());
const playwrightPackage = execFileSync(python, ['-c', 'from pathlib import Path; from playwright._impl._driver import compute_driver_executable; print(Path(compute_driver_executable()[1]).parent)'], { encoding: 'utf8' }).trim();
const { _electron } = require(playwrightPackage);
const environment = { ...process.env, DATABASE_URL: `file:${database.replaceAll('\\', '/')}`, BLACKCAT_DATA_ROOT: media,
  BLACKCAT_RUNTIME_ROOT: path.join(media, 'runtime'), BLACKCAT_VISION_ROOT: path.join(media, 'runtime', 'vision'),
  USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
  PYTHONPATH: '', PYTHONHOME: '', NEXT_TELEMETRY_DISABLED: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'BLACKCAT_PREVIEW', 'BLACKCAT_PREVIEW_PORT', 'BLACKCAT_DEV']) delete environment[key];
for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(environment[key], { recursive: true });
const proof = { synthetic: true, baselineVersion: '', updatedVersion: '', preservedTables: [], batches: [],
  cleanOsInstallTest: false, installerExecuted: false, completed: false };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let desktop;
function dbRead(callback) { const db = new DatabaseSync(database); try { return callback(db); } finally { db.close(); } }
function snapshot() {
  return dbRead(db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_prisma_migrations' ORDER BY name").all()
    .map(({ name }) => [name, hash(JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()))])));
}
async function launch(folder, phase) {
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'resources', 'app', 'package.json'), 'utf8'));
  console.log(`${phase}: launching packaged ${metadata.version}`);
  desktop = await _electron.launch({ executablePath: path.join(folder, 'Black Cat Reseller.exe'), cwd: folder,
    env: environment, timeout: 90000, args: ['--disable-background-networking', '--disable-component-update'] });
  const page = await desktop.firstWindow({ timeout: 90000 });
  page.setDefaultTimeout(30000);
  await page.waitForURL('http://127.0.0.1:41999/**', { timeout: 90000 });
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).waitFor();
  await page.getByText(`Black Cat · v${metadata.version} · Beta`, { exact: true }).waitFor();
  assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), metadata.version);
  return { page, version: metadata.version };
}
async function quit() {
  if (!desktop) return;
  await desktop.close(); desktop = null;
}
function seed() {
  const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh9kAAAAASUVORK5CYII=', 'base64');
  const photos = [];
  dbRead(db => {
    const row = db.prepare('SELECT data FROM AppSettings WHERE id=1').get();
    const settings = JSON.parse(row.data);
    Object.assign(settings, { visionEnabled: false, ocrEnabled: false, tagOcrEnabled: false, fileStabilitySeconds: 0 });
    db.prepare('UPDATE AppSettings SET data=? WHERE id=1').run(JSON.stringify(settings));
    assert.equal(db.prepare('SELECT count(*) AS count FROM Item').get().count, 0);
    for (let index = 1; index <= 10; index++) {
      const sku = `BC-${900000 + index}`;
      const filename = path.join(settings.processingPath, sku, 'fixture.png');
      fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, photoBytes);
      const item = db.prepare('INSERT INTO Item (sku,status,brand,size,itemType,color,condition,listedPrice,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sku, 'Photographed', 'Upgrade fixture', 'M', 'T-Shirt', 'Blue', 'Good', 20 + index, Date.now()).lastInsertRowid;
      db.prepare('INSERT INTO Photo (itemId,originalFilename,storedPath,thumbPath,sha256,sortOrder,isCover,width,height) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(item, 'fixture.png', filename, filename, hash(photoBytes), 0, 1, 1, 1);
      photos.push({ filename, sha256: hash(photoBytes) });
    }
  });
  const marker = path.join(media, 'runtime', 'upgrade-fixture.txt');
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, crypto.randomUUID());
  return { photos, runtimeMarker: marker, runtimeHash: hash(fs.readFileSync(marker)) };
}
function generateBatch(folder, firstSku) {
  fs.mkdirSync(folder, { recursive: true });
  const source = `from PIL import Image,ImageDraw\nimport qrcode,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1]); first=int(sys.argv[2])\nfor index in range(200):\n image=Image.new('RGB',(800,600),(35+(index%11),55+(index%13),75))\n draw=ImageDraw.Draw(image); draw.text((30,30),f'Batch {first} source {index}',fill='white')\n if index%5==4:\n  code=qrcode.make(f'BC-{first+index//5:06d}').convert('RGB').resize((330,330)); image.paste(code,(230,180))\n image.save(root/f'IMG_{index+1:04d}.jpg',quality=93)\n`;
  execFileSync(python, ['-c', source, folder, String(firstSku)], { env: environment });
}
async function runBatch(page, number) {
  const folder = path.join(root, `camera-${number}`); generateBatch(folder, (number - 1) * 40 + 1);
  await page.goto('http://127.0.0.1:41999/');
  await page.locator('input[type=file]').setInputFiles(folder);
  let status;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    status = await (await page.request.get('http://127.0.0.1:41999/api/process/progress')).json();
    if (status.job && !proof.batches.some(batch => batch.id === status.job.id)) break;
    await page.waitForTimeout(250);
  }
  assert.ok(status?.job && !proof.batches.some(batch => batch.id === status.job.id), 'A new batch job must be created');
  const id = status.job.id;
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await page.waitForURL('**/inventory'); await page.reload();
  while (Date.now() < deadline) {
    status = await (await page.request.get('http://127.0.0.1:41999/api/process/progress')).json();
    assert.equal(status.job?.id, id, 'Navigation and refresh must retain the same job');
    if (!status.running) break;
    await page.waitForTimeout(500);
  }
  assert.equal(status.running, false, 'Batch must finish within the timeout');
  assert.ok(['completed', 'completed_with_review'].includes(status.job.state), JSON.stringify(status));
  assert.equal(status.job.summary.itemsCreated, 40);
  assert.equal(status.job.summary.collisions, 0); assert.equal(status.job.summary.needsReview, 0);
  const review = await (await page.request.get(`http://127.0.0.1:41999/api/process/review?job=${id}`)).json();
  assert.equal(review.manifest.photos.length, 200); assert.equal(review.verification.groups.length, 40);
  assert.equal(review.verification.unresolved.length, 0);
  dbRead(db => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM Item').get().count, 10 + 40 * number);
    assert.equal(db.prepare('SELECT count(*) AS count FROM Photo').get().count, 10 + 200 * number);
    assert.equal(db.prepare('SELECT count(*) AS count FROM IntakeReceipt WHERE completed=1').get().count, number);
  });
  await page.goto(`http://127.0.0.1:41999/batches?job=${id}`);
  await page.getByRole('heading', { name: 'Batch verification', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `batch-${number}.png`), fullPage: false });
  proof.batches.push({ id, state: status.job.state, summary: status.job.summary, photos: 200, groups: 40,
    note: 'QR fixture; OCR and AI intentionally disabled. Any unavailable-engine warning remains visible.' });
  console.log(`Batch ${number}: 200 photos, 40 items, navigation and refresh passed`);
}

(async () => {
  const first = await launch(baseline, 'baseline'); proof.baselineVersion = first.version;
  await quit(); const fixture = seed(); const before = snapshot();
  const next = await launch(updated, 'upgrade'); proof.updatedVersion = next.version;
  await next.page.goto('http://127.0.0.1:41999/inventory');
  for (let index = 1; index <= 10; index++) await next.page.getByRole('link', { name: new RegExp(`^Open BC-${900000 + index}:`) }).waitFor();
  await quit(); const after = snapshot();
  for (const [table, digest] of Object.entries(before)) {
    assert.equal(after[table], digest, `Upgrade must preserve ${table}`); proof.preservedTables.push(table);
  }
  for (const photo of fixture.photos) assert.equal(hash(fs.readFileSync(photo.filename)), photo.sha256);
  assert.equal(hash(fs.readFileSync(fixture.runtimeMarker)), fixture.runtimeHash);
  const live = await launch(updated, 'intake');
  await runBatch(live.page, 1); await runBatch(live.page, 2); await quit();
  const final = await launch(updated, 'restart'); await final.page.goto('http://127.0.0.1:41999/inventory');
  dbRead(db => assert.equal(db.prepare('SELECT count(*) AS count FROM Item').get().count, 90));
  await quit(); proof.completed = true;
  console.log('Packaged beta.8 upgrade, consecutive 200-photo batches and restart passed');
})().catch(error => { proof.error = error.stack || String(error); process.exitCode = 1; console.error(error); })
  .finally(async () => {
    try { await quit(); } catch (error) { proof.shutdownError = String(error); process.exitCode = 1; }
    fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
    // Keep only synthetic diagnostic logs as failure evidence, never a user workspace.
    const logs = path.join(media, 'logs');
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(output, 'logs'), { recursive: true });
  });
