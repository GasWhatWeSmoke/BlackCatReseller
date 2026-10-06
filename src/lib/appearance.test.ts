import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTheme, parseTheme, daylightAt, themeAt } from './appearance.ts';

test('daily palettes follow local midnight, including week and year boundaries', () => {
  const settings = defaultTheme();
  assert.equal(new Set(settings.days.map(day => JSON.stringify(day))).size, 7);
  for (const [before, after] of [
    [new Date(2026, 9, 3, 23, 59, 59), new Date(2026, 9, 4)],
    [new Date(2026, 11, 31, 23, 59, 59), new Date(2027, 0, 1)],
    [new Date(2028, 1, 28, 23, 59, 59), new Date(2028, 1, 29)],
  ]) {
    assert.notDeepEqual(themeAt(settings, before).gradient, themeAt(settings, after).gradient);
    assert.deepEqual(themeAt(settings, after).gradient, settings.days[after.getDay()]);
    assert.equal(themeAt(settings, before).daylight, 0);
    assert.equal(themeAt(settings, after).daylight, 0);
  }
});

test('brightness brightens in the morning, dims in the evening, and stays stable overnight', () => {
  const at = (hour: number, minute = 0) => daylightAt(new Date(2026, 9, 2, hour, minute));
  assert.equal(at(6), 0); assert.equal(at(9), 1); assert.equal(at(15), 1); assert.equal(at(21), 0);
  assert.equal(at(0), 0); assert.equal(at(23, 59), 0);
  let morning = 0, evening = 1;
  for (let minute = 0; minute <= 180; minute++) {
    const next = at(6, minute); assert.ok(next >= morning); assert.ok(next - morning < 0.01); morning = next;
  }
  for (let minute = 0; minute <= 360; minute++) {
    const next = at(15, minute); assert.ok(next <= evening); assert.ok(evening - next < 0.01); evening = next;
  }
});

test('manual brightness keeps the chosen daily rotation and does not mutate preferences', () => {
  const settings = defaultTheme(), original = JSON.stringify(settings);
  for (const mode of ['light', 'dark'] as const) for (const hour of [0, 9, 18, 23]) {
    const result = themeAt({ ...settings, mode }, new Date(2026, 9, 2, hour));
    assert.equal(result.daylight, mode === 'light' ? 1 : 0);
    assert.deepEqual(result.gradient, settings.days[5]);
  }
  assert.equal(JSON.stringify(settings), original);
});

test('saved gradients round trip while invalid and future settings fall back safely', () => {
  const settings = defaultTheme(); settings.days[5] = { start: '#123456', end: '#abcdef' }; settings.mode = 'dark'; settings.background = 'still';
  assert.deepEqual(parseTheme(JSON.stringify(settings)), settings);
  for (const raw of [null, '', 'broken', 'null', '[]', '{"version":2}']) assert.deepEqual(parseTheme(raw), defaultTheme());
  const partial = parseTheme(JSON.stringify({ version: 1, mode: 'invalid', days: [null, { start: '#AABBCC', end: 'url(https://example.com)' }, 'bad'] }));
  assert.equal(partial.mode, 'auto'); assert.deepEqual(partial.days[0], defaultTheme().days[0]);
  assert.equal(partial.days[1].start, '#aabbcc'); assert.equal(partial.days[1].end, defaultTheme().days[1].end);
  assert.equal(partial.days.length, 7);
  partial.days[0].start = '#000000'; assert.notEqual(defaultTheme().days[0].start, '#000000');
});

test('existing daily colors gain flowing backgrounds without losing saved colors or brightness', () => {
  const { background, ...legacy } = defaultTheme();
  legacy.mode = 'dark'; legacy.days[0] = { start: '#336699', end: '#996633' };
  assert.deepEqual(parseTheme(JSON.stringify(legacy)), { ...legacy, background: 'flow' });
  assert.deepEqual(parseTheme(JSON.stringify({ ...legacy, background: 'invalid' })), { ...legacy, background });
});

// Independent WCAG contrast calculation checks the rendered token pairs, not the adjustment algorithm.
function ratio(a: string, b: string): number {
  function lum(hex: string) {
    const channels = hex.slice(1).match(/../g)!.map(part => parseInt(part, 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return channels.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  }
  const values = [lum(a), lum(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('custom extremes and every daily palette keep readable text through dawn and dusk', () => {
  const settings = defaultTheme();
  const palettes = [...settings.days, { start: '#000000', end: '#ffffff' }, { start: '#ff0000', end: '#0000ff' }, { start: '#00ff00', end: '#ffff00' }];
  for (const gradient of palettes) {
    const customized = { ...settings, days: settings.days.map(() => gradient) };
    for (let minute = 0; minute < 1440; minute += 2) {
      const { tokens: t } = themeAt(customized, new Date(2026, 9, 2, 0, minute));
      for (const background of ['--bg', '--gradient-start', '--gradient-end', '--panel', '--panel-2', '--input', '--metal-shadow', '--metal-highlight', '--panel-highlight', '--ambient-start', '--ambient-end'] as const) {
        for (const color of ['--text', '--muted', '--accent', '--ok', '--warn', '--danger', '--violet', '--blue', '--mint'] as const) {
          assert.ok(ratio(t[color], t[background]) >= 4.5, `${gradient.start} at ${minute}: ${color} on ${background}`);
        }
        assert.ok(ratio(t['--control-border'], t[background]) >= 3);
      }
      for (const color of ['accent', 'ok', 'warn', 'mint'] as const) assert.ok(ratio(t[`--${color}`], t[`--${color}-ink`]) >= 4.5);
      assert.ok(ratio(t['--brand-accent'], '#000000') >= 4.5);
    }
  }
});

test('daytime steel remains visibly gray instead of washing panels and inputs to white', () => {
  const settings = defaultTheme();
  for (let day = 0; day < 7; day++) {
    const { tokens } = themeAt(settings, new Date(2026, 9, 4 + day, 12));
    for (const key of ['--bg', '--panel', '--panel-2', '--input', '--metal-highlight', '--panel-highlight'] as const) {
      assert.ok(ratio(tokens[key], '#000000') < 13, `${key} is too close to white`);
    }
  }
});
