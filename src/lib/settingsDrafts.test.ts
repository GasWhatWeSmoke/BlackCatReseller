import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AppSettingsData } from './types.ts';
import { generalSettingsChanges, settingsDraft, settingsDraftConflicts, recoverSettingsDraft,
  formAfterSettingsSave, parseSettingsDraft, describeSettingsValue } from './settingsDrafts.ts';
const fixture = (): AppSettingsData => ({ ...JSON.parse(fs.readFileSync('config/defaults.json', 'utf8')).defaults,
  dataRoot: 'C:/fixture', priceWarnMin: 5, publish: { saleMonitorEnabled: true } });

test('settings recovery records only changed general controls, never account or runtime data', () => {
  const saved = fixture(), form = { ...saved, priceWarnMin: 42, lastSyncSummary: 'private runtime summary',
    publish: { ...saved.publish, ebay: { enabled: true, env: 'production' as const, clientId: 'private-key', clientSecret: 'private-secret', ruName: 'private-name' } } };
  const draft = settingsDraft(saved, form);
  assert.deepEqual(draft.changes, { priceWarnMin: 42 });
  assert.deepEqual(draft.baseline, { priceWarnMin: 5 });
  assert.equal(JSON.stringify(draft).includes('private'), false);
  assert.deepEqual(parseSettingsDraft(draft), draft);
  assert.deepEqual(generalSettingsChanges(saved, form), { priceWarnMin: 42 });
});
test('recovered settings retain original comparison values and expose conflicting saved changes', () => {
  const saved = fixture(), draft = settingsDraft(saved, { ...saved, priceWarnMin: 42 });
  const current = { ...saved, priceWarnMin: 10 };
  const recovered = recoverSettingsDraft(current, draft)!;
  const edited = settingsDraft(current, { ...current, ...recovered.changes, priceWarnMax: 600 }, recovered);
  assert.equal(edited.baseline.priceWarnMin, 5);
  assert.deepEqual(settingsDraftConflicts(current, edited), ['priceWarnMin']);
  const confirmed = settingsDraft(current, { ...current, ...edited.changes });
  assert.deepEqual(settingsDraftConflicts(current, confirmed), []);
});
test('an uncertain successful save is recognized without replaying already applied settings', () => {
  const saved = fixture(), draft = settingsDraft(saved, { ...saved, dataRoot: 'C:/moved', priceWarnMin: 42 });
  const current = { ...saved, dataRoot: 'C:/moved', priceWarnMin: 42, lastSyncSummary: 'new background state' };
  const recovered = recoverSettingsDraft(current, draft)!;
  assert.deepEqual(recovered.changes, {});
  assert.deepEqual(recovered.baseline, {});
  assert.equal(recovered.workspace, current.dataRoot);
  assert.deepEqual(settingsDraftConflicts(current, recovered), []);
});
test('a different workspace cannot silently inherit a settings draft', () => {
  const saved = fixture(), draft = settingsDraft(saved, { ...saved, priceWarnMin: 42 });
  const different = { ...saved, dataRoot: 'C:/different' };
  assert.deepEqual(settingsDraftConflicts(different, draft), ['dataRoot']);
  assert.equal(recoverSettingsDraft(different, draft), draft);
});
test('an empty receipt does not bind new edits to an old workspace', () => {
  const old = fixture(), empty = settingsDraft(old, old);
  const current = { ...old, dataRoot: 'C:/new-workspace' };
  const next = settingsDraft(current, { ...current, priceWarnMin: 42 }, empty);
  assert.equal(next.workspace, current.dataRoot);
  assert.deepEqual(settingsDraftConflicts(current, next), []);
});
test('typing while a save is in flight survives the receipt without overwriting current account state', () => {
  const saved = fixture(), submitted = { ...saved, priceWarnMin: 42 };
  const typedLater = { ...submitted, priceWarnMin: 55, priceWarnMax: 900 };
  const confirmed = { ...submitted, publish: { saleMonitorEnabled: false }, lastSyncSummary: 'new' };
  const form = formAfterSettingsSave(submitted, typedLater, confirmed);
  assert.equal(form.priceWarnMin, 55); assert.equal(form.priceWarnMax, 900);
  assert.deepEqual(form.publish, confirmed.publish); assert.equal(form.lastSyncSummary, 'new');
  const draft = settingsDraft(confirmed, form);
  assert.equal(draft.baseline.priceWarnMin, 42);
  assert.deepEqual(settingsDraftConflicts(confirmed, draft), []);
});
test('malformed local settings values are retained for recovery instead of crashing form controls', () => {
  const saved = fixture(), draft = settingsDraft(saved, { ...saved, skuPrefixes: ['NEW-'] });
  for (const bad of [
    { ...draft, version: 2 }, { ...draft, baseline: {} },
    { ...draft, changes: { skuPrefixes: 1 } }, { ...draft, changes: { skuPrefixes: ['ok', 1] } },
    { ...draft, baseline: { publish: {} }, changes: { publish: {} } },
    { ...draft, baseline: { feeModel: null }, changes: { feeModel: { ebay: { feePercent: 'bad', fixedFee: 1 } } } },
    { ...draft, baseline: { shippingModel: null }, changes: { shippingModel: { default: 1, tiers: [null] } } },
  ]) assert.throws(() => parseSettingsDraft(bad), /stored copy has been kept/);
});
test('conflict comparisons use readable values without hiding zeros or rounding differences', () => {
  assert.equal(describeSettingsValue('visionEnabled', false), 'Off');
  assert.equal(describeSettingsValue('priceWarnMin', 0), '0');
  assert.equal(describeSettingsValue('visionFields', ['size','brand']), 'size, brand');
  assert.equal(describeSettingsValue('feeModel', { ebay: { feePercent: 12.345, fixedFee: 0 } }), 'ebay: 12.345% + $0');
  assert.equal(describeSettingsValue('shippingModel', { tiers: [{maxOz:16,cost:4.99}], default:0 }), '16 oz or less: $4.99\nOver top tier: $0');
  assert.equal(describeSettingsValue('mercariShipFrom', { city:'Town',zip:'12345',state:'AA',stateFull:'State' }), 'City: Town\nZIP: 12345\nState: AA\nFull state: State');
});
