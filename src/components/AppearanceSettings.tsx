"use client";
import { useEffect, useState, type CSSProperties } from 'react';
import { APPEARANCE_EVENT, DAYS, defaultTheme, parseTheme, themeAt, THEME_KEY, type ThemeSettings } from '@/lib/appearance';
import styles from './AppearanceSettings.module.css';
import { AmbientBackdrop } from './AmbientBackdrop';

export function AppearanceSettings() {
  const [motion, setMotion] = useState('full');
  const [settings, setSettings] = useState(defaultTheme);
  const [now, setNow] = useState<Date | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [previewHour, setPreviewHour] = useState('now');
  const [error, setError] = useState('');
  useEffect(() => {
    const sync = () => {
      try { setSettings(parseTheme(localStorage.getItem(THEME_KEY))); setMotion(localStorage.getItem('blackcat.motion') || 'full'); }
      catch { setError('Appearance preferences could not be read on this device.'); }
    };
    const tick = () => setNow(new Date());
    const storage = (event: StorageEvent) => { if ([THEME_KEY, 'blackcat.motion', null].includes(event.key)) sync(); };
    sync(); tick(); const timer = window.setInterval(tick, 30_000);
    window.addEventListener('storage', storage); window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); window.removeEventListener('storage', storage); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, []);
  function save(next: ThemeSettings) {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(next)); setSettings(next); setError('');
      window.dispatchEvent(new Event(APPEARANCE_EVENT));
    } catch { setError('Your colors could not be saved on this device. Try again; the last saved colors are still in use.'); }
  }
  const day = selected ?? now?.getDay() ?? 0;
  const gradient = settings.days[day];
  const previewDate = now ? new Date(now) : new Date(2026, 0, 4, 12);
  previewDate.setDate(previewDate.getDate() + day - previewDate.getDay());
  if (previewHour !== 'now') previewDate.setHours(Number(previewHour), 0, 0, 0);
  const preview = themeAt(settings, previewDate);
  const colors = (key: 'start' | 'end', value: string) => save({ ...settings, days: settings.days.map((entry, index) => index === day ? { ...entry, [key]: value } : entry) });
  return <section className={`card ${styles.appearance}`} aria-label="Appearance">
    <div className={styles.heading}><div><h3>Daily colors</h3><p className="muted">Brushed steel with flowing daily color gradients, darker at night.</p></div>
      <label className={styles.mode}>Brightness<select aria-label="Brightness" className="select" value={settings.mode} disabled={!now} onChange={event => save({ ...settings, mode: event.target.value as ThemeSettings['mode'] })}>
        <option value="auto">Follow time of day</option><option value="light">Always light</option><option value="dark">Always dark</option>
      </select></label>
      <label className={styles.mode}>Background<select aria-label="Background" className="select" value={settings.background} disabled={!now} onChange={event => save({ ...settings, background: event.target.value as ThemeSettings['background'] })}>
        <option value="flow">Slow flowing gradients</option><option value="still">Still gradients</option>
      </select></label></div>
    <p className="muted">Uses your computer’s local time. Brightens from 6–9 AM, stays light until 3 PM, then dims until 9 PM. The next day’s colors start at midnight and repeat weekly.</p>
    <div className={styles.days} role="group" aria-label="Choose a day to edit">
      {DAYS.map((name, index) => <button key={name} className={styles.day} aria-label={name} aria-pressed={index === day} disabled={!now} onClick={() => setSelected(index)}>
        <span className={styles.swatch} aria-hidden="true" style={{ background: `linear-gradient(120deg, ${settings.days[index].start}, ${settings.days[index].end})` }} />
        <span>{name.slice(0, 3)}</span><small>{now?.getDay() === index ? 'Today' : '\u00a0'}</small>
      </button>)}
    </div>
    <div className={styles.editor}>
      <div><h4>{DAYS[day]} gradient</h4><div className={styles.colors}>
        <label>First color<input type="color" aria-label={`${DAYS[day]} first gradient color`} value={gradient.start} disabled={!now} onChange={event => colors('start', event.target.value)} /><span className="muted">{gradient.start.toUpperCase()}</span></label>
        <label>Second color<input type="color" aria-label={`${DAYS[day]} second gradient color`} value={gradient.end} disabled={!now} onChange={event => colors('end', event.target.value)} /><span className="muted">{gradient.end.toUpperCase()}</span></label>
      </div><button className="btn" disabled={!now} onClick={() => save({ ...settings, days: settings.days.map((entry, index) => index === day ? defaultTheme().days[index] : entry) })}>Reset {DAYS[day]} colors</button></div>
      <div><label className={styles.previewLabel}>Preview brightness<select aria-label="Preview brightness" className="select" value={previewHour} onChange={event => setPreviewHour(event.target.value)}>
        <option value="now">Current time</option><option value="9">Morning · 9 AM</option><option value="17">Evening · 5 PM</option><option value="22">Night · 10 PM</option>
      </select></label><div className={styles.preview} aria-label={`${DAYS[day]} gradient preview`} style={{ ...preview.tokens, colorScheme: preview.light ? 'light' : 'dark' } as CSSProperties}>
        <AmbientBackdrop contained />
        <strong>{DAYS[day]}</strong><span>{settings.mode === 'auto' ? 'Time of day' : settings.mode === 'light' ? 'Always light' : 'Always dark'}</span>
        <div className={styles.sampleCard}>Your workspace <span className={styles.sampleButton}>Add item</span></div>
      </div><p className={styles.help}>Preview stays in this card. Editing another day keeps today’s colors in place.</p></div>
    </div>
    {error && <p role="alert" style={{ color: 'var(--warn)' }}>{error}</p>}
    <p className={styles.help}>Colors save immediately on this device. Text and controls adjust to stay readable.</p>
    <div className={styles.motion}><h3>Depth &amp; motion</h3><label>Motion level<select aria-label="Motion level" className="select" value={motion} onChange={event => {
      try { localStorage.setItem('blackcat.motion', event.target.value); setMotion(event.target.value); setError(''); window.dispatchEvent(new Event(APPEARANCE_EVENT)); }
      catch { setError('Your motion preference could not be saved on this device.'); }
    }}><option value="full">Responsive cards &amp; buttons</option><option value="subtle">Subtle button feedback</option><option value="off">Motion off</option></select></label>
    <p className={styles.help}>Background gradients drift on their own. Motion off or your system’s reduced-motion preference keeps them still.</p></div>
  </section>;
}
