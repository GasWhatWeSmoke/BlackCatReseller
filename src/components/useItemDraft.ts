"use client";
import { useEffect, useRef, useState } from "react";
import { changeDraft, draftConflicts, draftExpectedItem, draftKey, LocalDraftConflict, readItemDraft, resolveDraftField,
  writeItemDraft, DRAFT_FIELDS, type DraftItem, type DraftScope, type DraftValues, type ItemDraft } from "@/lib/itemDrafts";

interface Context {
  key: string; item: DraftItem; draft: ItemDraft | null; revision: string | null;
  pending: Promise<void>; error: string | null; other: ItemDraft | null | undefined; ready: boolean; writing: number;
  discarding: boolean;
}
export interface DraftSaveToken { context: Context; draft: ItemDraft | null; expected: Record<string, unknown> }

export function useItemDraft(scope: DraftScope, item: DraftItem | null | undefined,
  restore: (changes: DraftValues) => void, refresh = 0) {
  const active = useRef<Context | null>(null);
  const restoreRef = useRef(restore); restoreRef.current = restore;
  const [, rerender] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const redraw = (ctx: Context) => { if (active.current === ctx) rerender(n => n + 1); };

  function persist(ctx: Context, value: ItemDraft) {
    ctx.draft = value; ctx.writing++;
    ctx.pending = ctx.pending.then(async () => {
      if (ctx.other !== undefined) return;
      try {
        const saved = await writeItemDraft(ctx.key, value, ctx.revision);
        ctx.revision = saved!.revision;
        if (ctx.draft === value) ctx.draft = saved;
        ctx.error = null;
      } catch (error) {
        ctx.error = error instanceof Error ? error.message : "Local draft storage failed. Keep this window open.";
        if (error instanceof LocalDraftConflict) ctx.other = error.latest;
      }
    }).finally(() => { ctx.writing--; redraw(ctx); });
    redraw(ctx);
  }

  useEffect(() => {
    let alive = true;
    active.current = null; setReadError(null); rerender(n => n + 1);
    if (!item) return;
    let key: string;
    try { key = draftKey(scope, item); } catch (error) { setReadError(String(error)); return; }
    const ctx: Context = { key, item, draft: null, revision: null, pending: Promise.resolve(), error: null,
      other: undefined, ready: false, writing: 0, discarding: false };
    active.current = ctx;
    void readItemDraft(key).then(draft => {
      if (!alive) return;
      ctx.draft = draft; ctx.revision = draft?.revision ?? null;
      // Old Review drafts lack original values. Keep them, but require explicit
      // review before allowing them to replace any currently saved values.
      if (!draft && scope === "review") {
        try {
          const old = JSON.parse(localStorage.getItem("blackcat.review.drafts") || "{}")[item.id];
          if (old && typeof old === "object" && !Array.isArray(old)) {
            const fields = Object.fromEntries(Object.entries(old).filter(([field]) => DRAFT_FIELDS.has(field))) as DraftValues;
            if (Object.keys(fields).length) {
              draft = changeDraft(key, item, null, fields);
              draft.baseline.status = "Older draft: original saved values unavailable";
              persist(ctx, draft);
            }
          }
        } catch { ctx.error = "An older Review draft could not be recovered. Its stored copy has been kept."; }
      }
      ctx.ready = true;
      restoreRef.current(draft?.changes ?? {}); redraw(ctx);
    }).catch(error => { if (alive) setReadError(error instanceof Error ? error.message : "Could not load your local draft."); });
    return () => { alive = false; };
    // Photos and freshly returned objects must not reset a field draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, item?.id, item?.createdAt, refresh, retry]);

  const ctx = active.current;
  const belongs = !!ctx && !!item && ctx.item.id === item.id && ctx.item.createdAt === item.createdAt;
  if (belongs) ctx.item = item;
  const draft = belongs ? ctx.draft : null;
  const conflicts = item ? draftConflicts(item, draft) : [];
  const dirty = !!draft && Object.keys(draft.changes).length > 0;
  const unsafeToLeave = belongs && dirty && (!!ctx.error || ctx.writing > 0 || ctx.other !== undefined);
  useEffect(() => {
    if (!unsafeToLeave) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const linkGuard = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.("a[href], [data-draft-navigation]")) {
        event.preventDefault(); event.stopPropagation();
        const current = active.current;
        if (current) { current.error = current.error ?? "Wait for the local draft to finish, or save to inventory before leaving."; redraw(current); }
      }
    };
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", linkGuard, true);
    return () => { window.removeEventListener("beforeunload", guard); document.removeEventListener("click", linkGuard, true); };
  }, [unsafeToLeave]);

  return {
    ready: belongs && ctx.ready,
    dirty, draft, conflicts,
    discarding: belongs && ctx.discarding,
    canLeave: !unsafeToLeave,
    error: readError ?? (belongs ? ctx.error : null),
    writing: belongs ? ctx.writing > 0 : false,
    other: belongs ? ctx.other : undefined,
    canSave: belongs && ctx.ready && !ctx.discarding && !conflicts.length && ctx.other === undefined,
    retryRead: () => setRetry(n => n + 1),
    hasEdit: (field: string) => Object.hasOwn(active.current?.draft?.changes ?? {}, field),
    change(changes: DraftValues) {
      const current = active.current;
      if (!current?.ready || current.discarding) return false;
      try { persist(current, changeDraft(current.key, current.item, current.draft, changes)); return true; }
      catch (error) { current.error = String(error); redraw(current); return false; }
    },
    resolve(field: string, keep: boolean) {
      const current = active.current;
      if (!current?.draft || current.discarding) return;
      const next = resolveDraftField(current.item, current.draft, field, keep);
      persist(current, next);
      restoreRef.current({ ...(keep || field === "status" ? {} : { [field]: current.item[field] ?? null }), ...next.changes } as DraftValues);
    },
    chooseWindow(keep: boolean) {
      const current = active.current;
      if (!current || current.discarding || current.other === undefined) return;
      const other = current.other;
      current.revision = other?.revision ?? null; current.other = undefined;
      const next = keep && current.draft ? current.draft : other ?? changeDraft(current.key, current.item, null, {});
      const reset = Object.fromEntries(Object.keys(current.draft?.changes ?? {}).map(field => [field, current.item[field] ?? null]));
      persist(current, next);
      restoreRef.current({ ...reset, ...next.changes } as DraftValues);
    },
    async prepareSave(): Promise<DraftSaveToken> {
      const current = active.current;
      if (!current?.ready || current.discarding) throw new Error("Wait for local draft recovery before saving.");
      await current.pending;
      const latest = await readItemDraft(current.key);
      if ((latest?.revision ?? null) !== current.revision) {
        const error = new LocalDraftConflict(latest);
        current.other = latest; current.error = error.message; redraw(current); throw error;
      }
      if (current.other !== undefined || draftConflicts(current.item, current.draft).length)
        throw new Error("Review the recovered draft conflicts before saving.");
      return { context: current, draft: current.draft, expected: draftExpectedItem(current.item, current.draft) };
    },
    async saved(token: DraftSaveToken, savedItem: DraftItem) {
      const current = token.context;
      await current.pending;
      if (current.draft !== token.draft || current.other !== undefined) return;
      // Keep an empty receipt so an old localStorage draft cannot reappear later.
      persist(current, changeDraft(current.key, savedItem, null, {}));
      await current.pending;
    },
    async discard(): Promise<boolean> {
      const current = active.current;
      if (!current?.ready || current.discarding || current.other !== undefined) return false;
      current.discarding = true; current.writing++; redraw(current);
      try {
        await current.pending;
        if (current.other !== undefined) return false;
        const old = current.draft;
        const cleared = await writeItemDraft(current.key, changeDraft(current.key, current.item, null, {}), current.revision);
        current.draft = cleared; current.revision = cleared!.revision; current.error = null;
        if (active.current === current) restoreRef.current(Object.fromEntries(
          Object.keys(old?.changes ?? {}).map(field => [field, current.item[field] ?? null])) as DraftValues);
        return true;
      } catch (error) {
        current.error = error instanceof Error ? error.message : "The draft could not be discarded. Your edits are still here.";
        if (error instanceof LocalDraftConflict) current.other = error.latest;
        return false;
      } finally { current.discarding = false; current.writing--; redraw(current); }
    },
  };
}

export type ItemDraftRecovery = ReturnType<typeof useItemDraft>;
