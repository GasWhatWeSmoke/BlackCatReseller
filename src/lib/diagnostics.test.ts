import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { diagnosticPath, diagnosticsEnabled, exportDiagnostics, normalizeDiagnosticEvent,
  recordDiagnosticEvents, redactDiagnosticText, setDiagnosticsEnabled } from "./diagnostics.ts";
import type { AppSettingsData } from "./types.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-diagnostics-"));
  let release: () => Promise<unknown> = async () => {};
  t.after(async () => { await release(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, settings: { dataRoot: root, logsPath: path.join(root, "logs") } as AppSettingsData,
    beforeRemove: (cleanup: () => Promise<unknown>) => { release = cleanup; } };
}

test("diagnostics redact secrets, personal paths and URL values before recording", () => {
  for (const text of ['password: private-value', '{"access_token":"private-value"}', '{\\"cookie\\":\\"private-value\\"}',
    'Bearer private-value', 'Basic private-value', 'C:\\Users\\Alice\\private-value.txt', '/Users/alice/private-value.jpg',
    '\\\\server\\share\\private-value.txt', 'private-value@example.test', 'https://example.test/private-value?secret-data=yes'])
    assert.ok(!redactDiagnosticText(text).includes("private-value"), text);
  assert.equal(diagnosticPath('/api/items/42/ready?token=private'), '/api/items/42/ready');
  assert.equal(diagnosticPath('/api/settings/alice@example.test/secret'), '/api/settings/:value/:value');
  const event = normalizeDiagnosticEvent({ kind: 'action', path: '/settings', action: 'folder_select', phase: 'completed',
    message: 'Read C:\\Users\\Alice\\photo.jpg', body: 'never-record-this', cookie: 'never-record-this', value: 'never-record-this', durationMs: Infinity });
  assert.equal(event.action, 'folder_select');
  assert.ok(!JSON.stringify(event).includes('never-record-this'));
  assert.equal(event.durationMs, undefined);
  assert.throws(() => normalizeDiagnosticEvent({ kind: 'keystroke', text: 'secret' }));
});

test("local diagnostic opt-out persists and collection rotates within two bounded logs", t => {
  const { root, settings } = fixture(t);
  assert.equal(diagnosticsEnabled(settings), true);
  assert.equal(recordDiagnosticEvents(settings, [{ kind: 'navigation', path: '/inventory' }]), true);
  const file = path.join(settings.logsPath, 'diagnostics.jsonl'), before = fs.readFileSync(file, 'utf8');
  setDiagnosticsEnabled(settings, false);
  assert.equal(diagnosticsEnabled({ ...settings }), false);
  assert.equal(recordDiagnosticEvents(settings, [{ kind: 'action', action: 'item_delete' }]), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => recordDiagnosticEvents(settings, Array(21).fill({ kind: 'error' })));
  setDiagnosticsEnabled(settings, true);
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024));
  recordDiagnosticEvents(settings, [{ kind: 'error', message: 'bounded' }]);
  assert.equal(fs.statSync(path.join(settings.logsPath, 'diagnostics.previous.jsonl')).size, 1024 * 1024);
  assert.ok(fs.statSync(file).size < 1024);
  fs.writeFileSync(path.join(root, 'diagnostics-options.json'), '{broken');
  assert.equal(diagnosticsEnabled(settings), false, 'a damaged preference fails closed');
});

test("diagnostic export reads bounded real SQLite outcomes and excludes private settings and inventory fields", async t => {
  const { root, settings, beforeRemove } = fixture(t), database = path.join(root, 'fixture.db');
  fs.copyFileSync('config/template.db', database);
  const db = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll('\\', '/')}` } } });
  beforeRemove(() => db.$disconnect());
  const item = await db.item.create({ data: { sku: 'BC-000042', brand: 'James Perse', notes: 'PRIVATE-INVENTORY-NOTES', itemCost: 1234 } });
  const run = await db.publishRun.create({ data: { marketplacesJson: '["ebay"]' } });
  await db.publishJob.create({ data: { runId: run.id, itemId: item.id, marketplace: 'ebay', lastError: 'access_token=PRIVATE-CREDENTIAL', status: 'failed' } });
  await db.marketplaceListing.create({ data: { itemId: item.id, marketplace: 'ebay', externalUrl: 'https://private.example/PRIVATE-URL', lastError: 'alice@example.test' } });
  await db.problemLog.create({ data: { type: 'UNCERTAIN_MARKER_RANGE', sku: item.sku, message: 'PRIVATE-PROBLEM-DETAILS' } });
  recordDiagnosticEvents(settings, [{ kind: 'action', action: 'photo_copy', phase: 'completed', path: '/review', message: 'photo ready' }]);
  fs.writeFileSync(path.join(settings.logsPath, 'ebay-42.log'), 'unrelated private browser data\nEBAY_DONE ' + JSON.stringify({ outcome: 'failed', reason: 'Cookie: PRIVATE-COOKIE', submissionStarted: false }) + '\n');
  fs.writeFileSync(path.join(settings.logsPath, 'server.log'), 'Error: /Users/alice/PRIVATE-PATH\n');
  settings.publish = { ebay: { token: 'PRIVATE-SETTINGS' } } as unknown as AppSettingsData['publish'];
  const report = await exportDiagnostics(settings, db), text = JSON.stringify(report);
  for (const secret of ['PRIVATE-INVENTORY-NOTES', 'PRIVATE-CREDENTIAL', 'PRIVATE-URL', 'PRIVATE-PROBLEM-DETAILS', 'PRIVATE-COOKIE', 'PRIVATE-PATH', 'PRIVATE-SETTINGS', 'alice@example.test'])
    assert.ok(!text.includes(secret), secret);
  assert.equal(report.jobs[0].reviewedFields.brand, 'James Perse');
  assert.equal(report.workerReports[0].outcome, 'failed');
  assert.equal(report.events[0].action, 'photo_copy');
  assert.equal(report.problems[0].sku, 'BC-000042');
});

test("a non-file diagnostic target is refused instead of traversed", t => {
  const { settings } = fixture(t);
  fs.mkdirSync(path.join(settings.logsPath, 'diagnostics.jsonl'), { recursive: true });
  assert.throws(() => recordDiagnosticEvents(settings, [{ kind: 'error' }]), /regular file/);
});
