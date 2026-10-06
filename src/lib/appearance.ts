export const THEME_KEY = 'blackcat.theme';
export const APPEARANCE_EVENT = 'blackcat:appearance';
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export type Gradient = { start: string; end: string };
export type ThemeSettings = { version: 1; mode: 'auto' | 'light' | 'dark'; background: 'flow' | 'still'; days: Gradient[] };

export function defaultTheme(): ThemeSettings {
  return { version: 1, mode: 'auto', background: 'flow', days: [
    { start: '#7a91ac', end: '#a1aab5' },
    { start: '#668f95', end: '#93aaa3' },
    { start: '#648dad', end: '#a0adb9' },
    { start: '#8a84a1', end: '#9ba8b8' },
    { start: '#628f8a', end: '#8babb7' },
    { start: '#738da5', end: '#afb7c1' },
    { start: '#828b9c', end: '#9893ab' },
  ] };
}

export function parseTheme(raw: string | null): ThemeSettings {
  const fallback = defaultTheme();
  try {
    const value = JSON.parse(raw || 'null');
    if (value?.version !== 1) return fallback;
    if (['auto', 'light', 'dark'].includes(value.mode)) fallback.mode = value.mode;
    if (value.background === 'still') fallback.background = 'still';
    if (Array.isArray(value.days)) fallback.days = fallback.days.map((day, index) => ({
      start: validColor(value.days[index]?.start) ? value.days[index].start.toLowerCase() : day.start,
      end: validColor(value.days[index]?.end) ? value.days[index].end.toLowerCase() : day.end,
    }));
  } catch { /* Unavailable or damaged preferences use the daily defaults. */ }
  return fallback;
}

function validColor(value: unknown): value is string { return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value); }
function rgb(hex: string): number[] { return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)); }
function mix(a: string, b: string, amount: number): string {
  const right = rgb(b);
  return '#' + rgb(a).map((left, index) => Math.round(left + (right[index] - left) * amount).toString(16).padStart(2, '0')).join('');
}
function richer(color: string): string {
  const channels = rgb(color), midpoint = (Math.max(...channels) + Math.min(...channels)) / 2;
  return '#' + channels.map(channel => Math.round(Math.max(0, Math.min(255, midpoint + (channel - midpoint) * 3.5))).toString(16).padStart(2, '0')).join('');
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function contrast(a: string, b: string): number {
  const left = luminance(a), right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
function readable(color: string, backgrounds: string[], target: string, minimum = 4.5): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (backgrounds.every(background => contrast(candidate, background) >= minimum)) return candidate;
  }
  return target;
}

// Local wall-clock time deliberately avoids UTC dates and 24-hour DST arithmetic.
export function daylightAt(date: Date): number {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const progress = hour < 9 ? (hour - 6) / 3 : hour < 15 ? 1 : (21 - hour) / 6;
  const bounded = Math.max(0, Math.min(1, progress));
  return bounded * bounded * (3 - 2 * bounded);
}

export function themeAt(settings: ThemeSettings, date: Date) {
  const day = date.getDay(), gradient = settings.days[day];
  const daylight = settings.mode === 'light' ? 1 : settings.mode === 'dark' ? 0 : daylightAt(date);
  const base = mix('#0d141d', '#7d8b99', daylight);
  const text = contrast('#ffffff', base) >= contrast('#000000', base) ? '#ffffff' : '#000000';
  const light = text === '#000000';
  // Custom colors cannot sacrifice readable copy, even during twilight or with black/white picks.
  const surfaceContrast = Math.max(4.5, Math.min(7, contrast(base, text) - 0.2));
  const surface = (color: string) => readable(color, [text], base, surfaceContrast);
  const start = surface(mix(base, gradient.start, 0.18));
  const end = surface(mix(base, gradient.end, 0.18));
  const panel = surface(mix(mix('#202833', '#919fac', daylight), gradient.start, 0.04));
  const panel2 = surface(mix(mix('#293441', '#8393a2', daylight), gradient.end, 0.045));
  const input = surface(mix('#111923', '#a6b2bf', daylight));
  const shadow = surface(mix('#080e17', '#566777', daylight));
  const highlight = surface(mix('#303e50', '#bbc5ce', daylight));
  const panelHighlight = surface(mix(panel, highlight, 0.65));
  const ambientStart = surface(mix(base, richer(gradient.start), 0.65));
  const ambientEnd = surface(mix(base, richer(gradient.end), 0.65));
  const backgrounds = [base, start, end, panel, panel2, input, shadow, highlight, panelHighlight, ambientStart, ambientEnd];
  // Directional reflections and fine horizontal grain give the cool grays a steel finish.
  const grainColor = light ? '#ffffff08' : '#00000014';
  const grain = `repeating-linear-gradient(0deg, ${grainColor} 0px, ${grainColor} 1px, transparent 1px, transparent 3px)`;
  const steel = `linear-gradient(115deg, ${shadow} 0%, ${start} 22%, ${highlight} 42%, ${end} 62%, ${shadow} 100%)`;
  const ink = (color: string) => readable(color, backgrounds, text);
  const accent = ink(mix(gradient.start, gradient.end, 0.35));
  const onColor = (color: string) => contrast('#ffffff', color) >= contrast('#000000', color) ? '#ffffff' : '#000000';
  const ok = ink('#68a07a'), warn = ink('#bc8737'), mint = ink('#519d80');
  return { day, daylight, light, gradient, tokens: {
    '--bg': base, '--gradient-start': start, '--gradient-end': end,
    '--metal-shadow': shadow, '--metal-highlight': highlight, '--panel-highlight': panelHighlight,
    '--ambient-start': ambientStart, '--ambient-end': ambientEnd,
    '--workspace-background': `${grain}, ${steel}`,
    '--sidebar-background': `${grain}, linear-gradient(160deg, ${highlight} 0%, ${start} 24%, ${panel} 55%, ${end} 78%, ${shadow} 100%)`,
    '--hero-background': `${grain}, ${steel}`,
    '--panel': panel, '--panel-2': panel2, '--input': input,
    '--text': text, '--muted': ink(light ? '#526078' : '#a8b5c9'),
    '--border': mix(panel, text, 0.22), '--control-border': readable(mix(panel, text, 0.45), backgrounds, text, 3),
    '--accent': accent, '--accent-hover': accent, '--accent-ink': onColor(accent), '--accent-dim': accent + '10',
    '--brand-accent': readable(mix(gradient.start, gradient.end, 0.5), ['#000000'], '#c8d3df'),
    '--ok': ok, '--ok-ink': onColor(ok), '--warn': warn, '--warn-ink': onColor(warn), '--danger': ink('#cb5b65'),
    '--violet': ink('#9975bd'), '--blue': ink('#488da8'), '--mint': mint, '--mint-ink': onColor(mint),
    '--surface': `${grain}, linear-gradient(110deg, ${panel} 0%, ${panelHighlight} 45%, ${panel} 75%, ${panel2} 100%)`,
    '--surface-shadow': 'inset 0 1px 0 #ffffff30, inset 0 -1px 0 #00000028, 0 12px 32px #08132130',
  } };
}
