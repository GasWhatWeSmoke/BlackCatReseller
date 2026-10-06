"use client";
import { useEffect } from 'react';
import { APPEARANCE_EVENT, defaultTheme, parseTheme, themeAt, THEME_KEY } from '@/lib/appearance';

export function DailyTheme() {
  useEffect(() => {
    let settings = defaultTheme();
    const apply = () => {
      const root = document.documentElement, theme = themeAt(settings, new Date());
      for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
      root.style.colorScheme = theme.light ? 'light' : 'dark';
      root.dataset.theme = theme.light ? 'light' : 'dark';
      root.dataset.themeDay = String(theme.day);
      root.dataset.background = settings.background;
      root.dataset.pageVisibility = document.hidden ? 'hidden' : 'visible';
    };
    const sync = () => {
      try { settings = parseTheme(localStorage.getItem(THEME_KEY)); } catch { settings = defaultTheme(); }
      apply();
    };
    const storage = (event: StorageEvent) => { if (event.key === THEME_KEY || event.key === null) sync(); };
    sync();
    const timer = window.setInterval(apply, 30_000);
    window.addEventListener(APPEARANCE_EVENT, sync);
    window.addEventListener('storage', storage);
    window.addEventListener('focus', apply);
    document.addEventListener('visibilitychange', apply);
    return () => {
      clearInterval(timer);
      window.removeEventListener(APPEARANCE_EVENT, sync);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', apply);
      document.removeEventListener('visibilitychange', apply);
    };
  }, []);
  return null;
}
