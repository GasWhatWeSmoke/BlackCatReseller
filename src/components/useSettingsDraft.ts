"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { AppSettingsData } from '@/lib/types';
import { formAfterSettingsSave, generalSettingsChanges, readSettingsDraft, recoverSettingsDraft,
  settingsDraft, settingsDraftConflicts, SettingsDraftConflict, writeSettingsDraft, type SettingsDraft } from '@/lib/settingsDrafts';
import type { GeneralSettingsField } from '@/lib/settingsDrafts';

interface Context {
  saved: AppSettingsData; form: AppSettingsData; draft: SettingsDraft | null; revision: string | null;
  ready: boolean; readable: boolean; writing: number; discarding: boolean; pending: Promise<void>;
  error: string | null; other: SettingsDraft | null | undefined;
}
export interface SettingsSaveToken { context: Context; submitted: AppSettingsData; patch: Partial<AppSettingsData> }
const message = (error: unknown) => error instanceof Error ? error.message : 'Local draft storage is unavailable.';

export function useSettingsDraft(saving: RefObject<boolean>) {
  const active = useRef<Context | null>(null);
  const [, render] = useState(0);
  const redraw = useCallback((ctx: Context) => { if (active.current === ctx) render(value => value + 1); }, []);
  const persist = useCallback((ctx: Context, next: SettingsDraft) => {
    ctx.draft = next;
    if (!ctx.readable || ctx.other !== undefined) { redraw(ctx); return; }
    ctx.writing++;
    ctx.pending = ctx.pending.then(async () => {
      if (ctx.other !== undefined) return;
      try {
        const stored = await writeSettingsDraft(next, ctx.revision);
        ctx.revision = stored!.revision;
        if (ctx.draft === next) ctx.draft = stored;
        ctx.error = null;
      } catch (error) {
        ctx.error = message(error);
        if (error instanceof SettingsDraftConflict) ctx.other = error.latest;
      }
    }).finally(() => { ctx.writing--; redraw(ctx); });
    redraw(ctx);
  }, [redraw]);
  const load = useCallback(async (saved: AppSettingsData) => {
    const ctx: Context = { saved, form: saved, draft: null, revision: null, ready: false, readable: false,
      writing: 0, discarding: false, pending: Promise.resolve(), error: null, other: undefined };
    active.current = ctx; redraw(ctx);
    try {
      const stored = await readSettingsDraft();
      if (active.current !== ctx) return;
      ctx.readable = true; ctx.revision = stored?.revision ?? null;
      ctx.draft = recoverSettingsDraft(saved, stored);
      ctx.form = { ...saved, ...ctx.draft?.changes };
      if (stored && JSON.stringify(stored) !== JSON.stringify(ctx.draft)) persist(ctx, ctx.draft!);
    } catch (error) {
      // Saved preferences remain editable, but an unreadable draft is never overwritten.
      ctx.error = `${message(error)} Automatic draft recovery is unavailable; any stored draft is kept.`;
    }
    ctx.ready = true; redraw(ctx);
  }, [persist, redraw]);
  useEffect(() => {
    const unsafe = () => {
      const ctx = active.current;
      return saving.current || !!ctx && (ctx.writing > 0 || ctx.discarding
        || !!Object.keys(ctx.draft?.changes ?? {}).length && (!!ctx.error || ctx.other !== undefined));
    };
    const unload = (event: BeforeUnloadEvent) => { if (unsafe()) { event.preventDefault(); event.returnValue = ''; } };
    const navigation = (event: MouseEvent) => {
      if (!unsafe() || !(event.target as Element)?.closest?.('a[href]')) return;
      event.preventDefault(); event.stopPropagation();
      const ctx = active.current;
      if (ctx) { ctx.error = ctx.error ?? 'Wait for the current save, or save preferences before leaving.'; redraw(ctx); }
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigation, true);
    return () => { active.current = null; window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigation, true); };
  }, [redraw, saving]);
  const ctx = active.current;
  return {
    form: ctx?.form ?? null, saved: ctx?.saved ?? null, draft: ctx?.draft ?? null,
    ready: !!ctx?.ready && !ctx.discarding, error: ctx?.error ?? null, writing: !!ctx?.writing,
    dirty: !!Object.keys(ctx?.draft?.changes ?? {}).length, otherWindow: ctx?.other !== undefined,
    conflicts: ctx ? settingsDraftConflicts(ctx.saved, ctx.draft) : [], load,
    change<K extends GeneralSettingsField>(key: K, value: AppSettingsData[K]) {
      const current = active.current;
      if (!current?.ready || current.discarding) return;
      current.form = { ...current.form, [key]: value };
      persist(current, settingsDraft(current.saved, current.form, current.draft));
    },
    async prepareSave(): Promise<SettingsSaveToken> {
      const current = active.current;
      if (!current?.ready || current.discarding) throw Error('Wait for settings recovery before saving.');
      const submitted = current.form;
      await current.pending;
      if (active.current !== current) throw Error('Settings changed while preparing the save.');
      if (current.readable) {
        const latest = await readSettingsDraft();
        if ((latest?.revision ?? null) !== current.revision) {
          current.other = latest; current.error = new SettingsDraftConflict(latest).message; redraw(current);
        }
      }
      if (current.other !== undefined || settingsDraftConflicts(current.saved, current.draft).length)
        throw Error('Resolve the recovered settings draft before saving preferences.');
      return { context: current, submitted, patch: generalSettingsChanges(current.saved, submitted) };
    },
    savedSuccessfully(token: SettingsSaveToken, confirmed: AppSettingsData) {
      const current = token.context;
      current.form = formAfterSettingsSave(token.submitted, current.form, confirmed);
      current.saved = confirmed;
      persist(current, settingsDraft(confirmed, current.form));
    },
    confirmRecovered() {
      const current = active.current;
      if (current?.ready && current.other === undefined) persist(current, settingsDraft(current.saved, current.form));
    },
    async keepThisWindow() {
      const current = active.current;
      if (!current?.ready || current.discarding) return false;
      current.discarding = true; redraw(current);
      try {
        await current.pending;
        const latest = await readSettingsDraft();
        const stored = await writeSettingsDraft(current.draft ?? settingsDraft(current.saved, current.form), latest?.revision ?? null);
        current.draft = stored; current.revision = stored!.revision;
        current.other = undefined; current.error = null;
        return true;
      } catch (error) { current.error = message(error); if (error instanceof SettingsDraftConflict) current.other = error.latest; return false; }
      finally { current.discarding = false; redraw(current); }
    },
    async discard() {
      const current = active.current;
      if (!current?.ready || current.discarding || current.other !== undefined) return;
      current.discarding = true; redraw(current);
      try {
        await current.pending;
        if (current.other !== undefined) return;
        if (current.readable) { await writeSettingsDraft(null, current.revision); current.revision = null; current.error = null; }
        current.draft = null; current.form = current.saved;
      } catch (error) { current.error = message(error); if (error instanceof SettingsDraftConflict) current.other = error.latest; }
      finally { current.discarding = false; redraw(current); }
    },
  };
}
