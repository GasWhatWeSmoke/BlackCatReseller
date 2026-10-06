"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { RotateCw, EyeOff, Eye, Star, ChevronRight, ChevronLeft, Check, CheckCircle2, Loader2, Tag, X, Camera, Flag } from "lucide-react";
import { WHEN_MADE_OPTIONS, COLOR_OPTIONS, PATTERN_OPTIONS, CONDITION_OPTIONS, CONDITION_DEFAULT, ETSY_ELIGIBLE_OPTIONS, FIT_OPTIONS, STYLE_OPTIONS, CATEGORY_OPTIONS, VINTAGE_WHEN_MADE_DEFAULT, normalizeWhenMade } from "@/lib/listingOptions";
import { needsInseam, isVintage, sizelessOk, estimatePrice, itemCategory, assessTitle, isNewWithTags, stripBrandFromModel } from "@/lib/listing";
import { previewListingItem } from "@/lib/listingPreview";
import { describePackage } from '@/lib/packageDetails';
import { PackageDetailsNote } from '@/components/PackageDetailsNote';
import { buildExportCopy, type CopySource } from "@/lib/listingCopy";
import { CatMark } from "@/components/CatMark";
import { PromptDialog, type PromptSpec } from "@/components/PromptDialog";
import { playSound } from "@/lib/sound";
import { saveReviewItem, reviewQueueIndex } from "@/lib/reviewActions";
import { evidenceForValue, withExpectedItemValues } from "@/lib/itemEdits";
import { isAiSkipped } from "@/lib/intakeOutcome";
import { useItemDraft } from "@/components/useItemDraft";
import { DraftRecovery } from "@/components/DraftRecovery";
import type { DraftItem, DraftValue } from "@/lib/itemDrafts";
import { listItemDrafts, draftIdentity } from "@/lib/itemDrafts";
import { countPricingWork } from "@/lib/pricingDraft";
import { fetchPricingIndex } from "@/lib/pricingClient";
import { PricingTable } from "@/components/PricingTable";
import { BulkReview } from "@/components/BulkReview";
import { createReviewCheckpoint, reviewHotkey, reviewKey, reviewProblems, type ReviewItem } from "@/lib/reviewCheckpoint";
import { fetchReviewIndex, fetchReviewDetail, fetchReviewSignatures, filterReviewQueue } from '@/lib/reviewQueueClient';
import type { ReviewIdentity } from '@/lib/reviewQueueRead';
import { forgetReviewCheckpoint, listReviewCheckpoints, putReviewCheckpoint, readReviewCheckpoint, withReviewLock } from "@/lib/reviewCheckpointStore";
import { readReviewItem, readReviewRules } from "@/lib/reviewClient";
import { ReviewPhotos } from "@/components/ReviewPhotos";
import { PhotoViewer } from "@/components/PhotoViewer";
import { PriceResearch } from "@/components/PriceResearch";
import { AiSuggestions } from "@/components/AiSuggestions";
import { useVocabulary, VocabularyNotice } from '@/components/useVocabulary';
import styles from "./Review.module.css";

interface Photo {
  id: number; storedPath: string; thumbPath: string | null; rotation: number;
  isCover: boolean; isMarker: boolean; includeInListing: boolean; sortOrder: number;
}
interface Item {
  createdAt: string;
  updatedAt: string;
  id: number; sku: string; status: string; brand: string;
  size: string | null; itemType: string | null; category: string | null; color: string | null;
  pattern: string | null; weightOz: number | null; aiFields: string | null;
  condition: string | null; etsyEligible: string | null; trueVintage: boolean; inseam: string | null;
  fit: string | null; style: string | null; flagged: boolean;
  // Department decides how a bare numeric size reads (a "2" is not the same garment
  // in Women vs Men), and model/styleNumber are printed into the title by buildTitle.
  department: string | null; model: string | null; styleNumber: string | null;
  keyDetails: string | null;
  notes: string | null; listedPrice: number | null; whenMade: string | null; photos: Photo[];
  // Operator title override. Blank/null = the title stays auto-generated from the fields.
  customTitle: string | null;
  description: string | null;
  // v1.2 batch-reliability fields
  isShell: boolean; groupingConfidence: string | null; groupingLogJson: string | null;
  aiConfidence: number | null; aiRaw: string | null;
  // Per-attribute provenance (verified | inferred | uncertain) written at intake.
  evidenceJson: string | null;
  // WHY AI identification failed for this item (null = it ran fine / not yet retried).
  aiError: string | null;
}

function groupingReasons(it: Item): string[] {
  try {
    const g = it.groupingLogJson ? JSON.parse(it.groupingLogJson) : null;
    return Array.isArray(g?.reasons) ? g.reasons : [];
  } catch { return []; }
}


// AI-flaggable fields the Review queue actually renders (so saving here only confirms
// what the operator could see). Attributes not shown keep their AI badge.
const SHOWN_AI_FIELDS = new Set(["size", "color", "pattern", "itemType", "category", "brand", "weight", "fit", "style", "department", "keyDetails"]);

// The three the operator actually sorts by. "Unisex Adults" is the canonical Nifty
// value; older rows say plain "Unisex", so selection is matched loosely.
const DEPARTMENT_QUICK = ["Women", "Men", "Unisex Adults"] as const;
const deptKey = (value: string | null | undefined) => {
  const d = (value ?? "").trim().toLowerCase();
  return d.startsWith("unisex") ? "unisex" : d;
};

export default function ReviewQueue() {
  const [items, setItems] = useState<ReviewIdentity[]>([]);
  const [detail, setDetail] = useState<{ item: Item; generation: number } | null>(null);
  const [queueKnown, setQueueKnown] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRequest, setDetailRequest] = useState(0);
  const queueRequest = useRef<AbortController | null>(null);
  const [idx, setIdx] = useState(0);
  // "queue" = the field-review cards; "pricing" = the fast price table (every unpriced,
  // not-yet-uploaded item — including Ready ones, since price isn't a gate field).
  const [mode, setMode] = useState<"queue" | "pricing" | "batch">("queue");
  const [modeReady, setModeReady] = useState(false);
  const [findSku, setFindSku] = useState('');
  const pricingNavigation=useRef<((action:()=>void)=>void)|null>(null);
  const registerPricingNavigation=useCallback((navigate:((action:()=>void)=>void)|null)=>{pricingNavigation.current=navigate;},[]);
  const changeMode=(next:typeof mode)=>{const action=()=>setMode(next);if(mode==='pricing'&&pricingNavigation.current)pricingNavigation.current(action);else action();};
  const [batchCount, setBatchCount] = useState<number | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const focusReviewId = useRef<number | null>(null);
  const [unpricedCount, setUnpricedCount] = useState<number | null>(null);
  const pricingCountVersion = useRef(0);
  const updatePricingCount = useCallback((count: number) => { pricingCountVersion.current++; setUnpricedCount(count); }, []);
  useEffect(() => {
    // Deep link from the Ready page's pre-flight: /review?pricing=1
    if (new URLSearchParams(window.location.search).get("pricing") === "1") setMode("pricing");
    setModeReady(true);
    void listReviewCheckpoints().then(rows => { if (alive) setBatchCount(rows.filter(row => row.phase !== 'approved').length); }).catch(() => {});
    let alive = true;
    const version = pricingCountVersion.current;
    const controller = new AbortController();
    void Promise.all([
      fetchPricingIndex(controller.signal).then(result=>result.items),
      listItemDrafts("pricing"),
    ]).then(([items, drafts]) => { if (alive && pricingCountVersion.current === version) setUnpricedCount(countPricingWork(items, drafts)); }).catch(() => {});
    return () => { alive = false; controller.abort(); };
  }, []);
  // Ids the operator chose to Skip — tagged + counted so a deferred item is never silently
  // passed over (§29).
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  // Full-size photo viewer (click a photo to enlarge, click/Esc to close).
  const [lightbox, setLightbox] = useState<Photo | null>(null);
  const vocabulary = useVocabulary(), vocab = vocabulary.vocab;
  const refreshVocab = vocabulary.refresh, learnVocab = vocabulary.learn;
  const [form, setForm] = useState<Partial<Item>>({});
  const [aiSet, setAiSet] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [selectedPhotoId, setSelectedPhotoId] = useState<number | null>(null);
  const [sideTab, setSideTab] = useState<"photos" | "research" | "copy">("photos");
  const [moreActions, setMoreActions] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const identity = items[idx];
  const current = !loadingQueue && detail?.generation === refreshKey && detail.item.id === identity?.id
    && detail.item.createdAt === identity.createdAt ? detail.item : undefined;
  const updateItem = (id: number, patch: Partial<Item>) => {
    setItems(previous => previous.map(item => item.id !== id ? item : { ...item,
      ...(patch.sku !== undefined ? { sku: patch.sku } : {}), ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      ...(patch.flagged !== undefined ? { flagged: patch.flagged } : {}), ...(patch.aiError !== undefined ? { hasAiError: !!patch.aiError } : {}) }));
    setDetail(previous => previous?.item.id === id ? { ...previous, item: { ...previous.item, ...patch } } : previous);
  };
  const activeReviewId = useRef<number | undefined>(current?.id); activeReviewId.current = current?.id;
  const recovery = useItemDraft("review", current as unknown as DraftItem | undefined, changes => {
    const restored = { ...changes };
    if (restored.keyDetails === null) restored.keyDetails = previewListingItem(current as unknown as Record<string, unknown>).keyDetails?.join("\n") ?? "";
    if (typeof restored.whenMade === "string") restored.whenMade = normalizeWhenMade(restored.whenMade);
    setForm(previous => ({ ...previous, ...restored }));
    let ai: string[] = [];
    try { ai = current?.aiFields ? JSON.parse(current.aiFields) : []; } catch { /* invalid old metadata */ }
    setAiSet(new Set(ai.filter(field => !recovery.hasEdit(field))));
  }, refreshKey);
  // Ready-gate config (mirrors the server) so a passing item can auto-export on save.
  const [requiredFields, setRequiredFields] = useState<string[]>(["size", "itemType", "color", "condition"]);
  const [minPhotos, setMinPhotos] = useState(3);

  // Set a field and, since the user just touched it, drop its "AI" badge.
  const setField = (key: keyof Item, value: unknown) => {
    if (!recovery.ready || recovery.discarding || savingRef.current) return;
    if (!recovery.change({ [key]: value as DraftValue })) return;
    setDraftSaved(false); setSaveError(null);
    setForm((f) => ({ ...f, [key]: value }));
    setAiSet((s) => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n; });
  };
  // Correcting the brand also scrubs the OLD brand out of the model field. The vision
  // model writes "Wrangler 2000" for a Wrangler; the title de-dupes the repeat while
  // the brand matches, so the leftover is invisible right up until the brand is
  // changed - then "Wrangler" kept appearing in the title of a Lee with no field
  // that seemed to contain it.
  const setBrand = (value: string) => {
    const stripped = stripBrandFromModel(form.model, form.brand);
    if (stripped !== (form.model ?? "")) setField("model", stripped || null);
    setField("brand", value);
  };

  // NWT is a one-press call the operator makes with the garment in hand, so it gets a
  // button rather than a trip through the Condition combobox. Pressing it again clears
  // back to the default condition instead of stranding the item on "New with tags".
  const nwt = isNewWithTags(form.condition ?? null);
  const toggleNwt = () => {
    setField("condition", nwt ? CONDITION_DEFAULT : "New with tags");
    // A custom title written before the call was made won't contain NWT, and silently
    // shipping it without the keyword is the whole thing this button exists to prevent.
    if (!nwt && form.customTitle?.trim() && !/\bnwt\b/i.test(form.customTitle)) {
      setField("customTitle", `NWT ${form.customTitle.trim()}`.slice(0, 80));
    }
  };

  // Bumped on every server refetch so the form re-inits from FRESH data then (e.g. a
  // price set in the Pricing tab) — while photo ops, which only patch local state,
  // leave typed-but-unsaved edits alone.
  const [dialog, setDialog] = useState<PromptSpec | null>(null);
  const load = useCallback(async () => {
    queueRequest.current?.abort();
    const controller = new AbortController(); queueRequest.current = controller;
    setLoadingQueue(true);
    void refreshVocab(false);
    try {
      const [candidates, checkpoints, ...draftLists] = await Promise.all([
        fetchReviewIndex(controller.signal),
        listReviewCheckpoints(), listItemDrafts("review"), listItemDrafts("editor"), listItemDrafts("pricing"),
      ]);
      const dirty = new Set<string>();
      for (const [index, scope] of (["review", "editor", "pricing"] as const).entries())
        for (const draft of draftLists[index]) { const identity = draftIdentity(draft.key, scope); dirty.add(`${identity.id}:${identity.createdAt}`); }
      const list = await filterReviewQueue(candidates, checkpoints, dirty, ids => fetchReviewSignatures(ids, controller.signal), focusReviewId.current);
      if (controller.signal.aborted) return;
      setBatchCount(checkpoints.filter(checkpoint => checkpoint.phase !== "approved").length);
      setItems(list);
      const focus = focusReviewId.current; focusReviewId.current = null;
      setIdx(previous => focus === null ? reviewQueueIndex(previous, list.length) : Math.max(0, list.findIndex(item => item.id === focus)));
      setRefreshKey(k => k + 1); setLoadError(null); setDetailError(null); setQueueKnown(true);
    } catch (error) { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Review could not load."); }
    finally { if (!controller.signal.aborted) setLoadingQueue(false); }
  }, [refreshVocab]);
  // Refetch whenever the QUEUE becomes the active view — not just on mount. Prices set in
  // the Pricing tab land in the DB only; a stale queue row would show an empty price AND
  // silently PATCH null back over the saved one on "Save & next".
  useEffect(() => {
    if (modeReady && mode === 'queue') void load();
    return () => queueRequest.current?.abort();
  }, [mode, modeReady, load]);
  useEffect(() => {
    if (mode !== 'queue' || loadingQueue || loadError || !identity) return;
    const controller = new AbortController(); setDetailError(null);
    void fetchReviewDetail(identity, controller.signal).then(item => {
      if (!controller.signal.aborted) setDetail({ item: item as unknown as Item, generation: refreshKey });
    }).catch(error => { if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : 'Item details could not load.'); });
    return () => controller.abort();
    // Refresh a returning item, but field/photo saves must not reset its in-progress form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loadingQueue, loadError, identity?.id, identity?.createdAt, refreshKey, detailRequest]);

  // Pull the Ready gate from settings once so the auto-export check matches the server.
  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((j) => {
      if (Array.isArray(j.settings?.requiredFieldsForReady)) setRequiredFields(j.settings.requiredFieldsForReady);
      if (typeof j.settings?.minListingPhotos === "number") setMinPhotos(j.settings.minListingPhotos);
    }).catch(() => {});
  }, []);

  // Per-attribute provenance written by the worker: which values were READ off a
  // tag and which were inferred from the photos.
  const evidence = useMemo(() => Object.fromEntries(Object.entries(parseEvidence(current?.evidenceJson))
    .map(([key, value]) => [key, evidenceForValue(value, ({ ...current, ...form } as Record<string, unknown>)[key])])), [current, form]);
  // Near-miss spellings the normalizer refused to apply on its own. Deliberately
  // never auto-applied -- an almost-match becomes a listing that is confidently
  // wrong -- so they surface here as a one-press decision instead.
  const suggestions = useMemo(() => parseSuggestions(current?.aiRaw), [current?.aiRaw]);

  // Live listing title, built the same way export-item.ts builds it. Review is the last
  // stop before an item is publishable, so the title has to be visible and fixable HERE
  // rather than only on the detail page. Fields Review doesn't render fall back to the
  // stored item, so this is the real title, not a reduced approximation of it.
  const titleBuild = useMemo(
    () => {
      if (!current) return { title: "", keyDetail: null, finalTitle: "", description: "", warnings: [] as string[] };
      // Use the export resolver, not the lighter detail-page preview: export derives
      // sleeve, vintage era, One Size, and collar changes before it selects a detail.
      // The marked line therefore matches what will actually ship.
      const copy = buildExportCopy({ ...current, ...form } as unknown as CopySource);
      return { title: copy.autoTitle, keyDetail: copy.autoTitleKeyDetail, finalTitle: copy.title, description: copy.description, warnings: copy.copyWarnings };
    },
    [current, form],
  );
  const titlePreview = titleBuild.title;
  const keyDetailLines = useMemo(
    () => (form.keyDetails ?? "").split(/[\n,]+/).map((line) => line.trim()).filter(Boolean),
    [form.keyDetails],
  );
  const titleKeyDetailIndex = useMemo(() => {
    const key = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
    const selected = titleBuild.keyDetail ? key(titleBuild.keyDetail) : "";
    return selected ? keyDetailLines.findIndex((detail) => key(detail) === selected) : -1;
  }, [keyDetailLines, titleBuild.keyDetail]);
  const titleKeyDetail = titleKeyDetailIndex >= 0 ? keyDetailLines[titleKeyDetailIndex] : null;
  const effectiveTitle = useMemo(
    () => (form.customTitle ?? "").trim() || titlePreview,
    [form.customTitle, titlePreview],
  );
  const titleCheck = useMemo(() => assessTitle(effectiveTitle), [effectiveTitle]);
  // Re-init the form ONLY when a different ITEM lands in the slot — keyed by id, NOT by
  // object identity. Photo ops (rotate/cover/exclude/remove) replace the item object to
  // refresh the grid, and keying on the object made that WIPE any typed-but-unsaved field
  // edits back to the stale DB values ("typing into Brand doesn't work"). The user's
  // in-progress edits now always survive; generated values never overwrite them.
  useEffect(() => {
    if (current) {
      // Legacy rows can have the details only in aiRaw. Materialize the effective list
      // into Review so every keyword feeding the title is visible and can be changed.
      // A stored empty string is deliberate and stays empty.
      const keyDetails = current.keyDetails
        ?? previewListingItem(current as unknown as Record<string, unknown>).keyDetails?.join("\n")
        ?? "";
      setForm({
        size: current.size, itemType: current.itemType, category: current.category, color: current.color,
        pattern: current.pattern, brand: current.brand, weightOz: current.weightOz,
        condition: current.condition, etsyEligible: current.etsyEligible ?? "none",
        trueVintage: !!current.trueVintage, inseam: current.inseam, fit: current.fit,
        style: current.style, notes: current.notes, listedPrice: current.listedPrice,
        customTitle: current.customTitle,
        description: current.description,
        // These feed the title too. Left out of the form, the Model box rendered EMPTY
        // while the title preview still read the stored value, so an operator could
        // not see, let alone fix, where a stray word in the title was coming from.
        department: current.department, model: current.model, styleNumber: current.styleNumber,
        keyDetails,
        // Normalize the Etsy era to Nifty's exact option string.
        whenMade: normalizeWhenMade(current.whenMade),
      });
      let ai: string[] = [];
      try { ai = current.aiFields ? JSON.parse(current.aiFields) : []; } catch { ai = []; }
      setAiSet(new Set(ai));
      setDraftSaved(false); setSaveError(null);
      setSelectedPhotoId(null);
      setSideTab("photos");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, refreshKey]);

  const saveCurrent = useCallback(async (approve: boolean, forBatch = false) => {
    if (!current || savingRef.current || batchBusy || loadError || detailError || loadingQueue || !recovery.canSave) return;
    const merged = { ...current, ...form } as Record<string, unknown>;
    const sizeExempt = sizelessOk(merged.itemType as string | null, merged.category as string | null);
    const missing = [...new Set([...requiredFields, "brand", "department"])].filter(key =>
      (!String(merged[key] ?? "").trim() || key === "brand" && merged[key] === "Unknown") && !(key === "size" && sizeExempt));
    if (!Number.isFinite(merged.listedPrice) || Number(merged.listedPrice) <= 0) missing.push("price");
    if (current.photos.filter(p => p.includeInListing && !p.isMarker).length < minPhotos) missing.push(`${minPhotos} listing photos`);
    if (approve && missing.length) { setSaveError(`Before crosslisting, add: ${missing.join(", ")}. You can save a draft now.`); return; }
    savingRef.current = true; setSaving(true); setSaveError(null);
    try {
      const save = async () => {
        const rules = forBatch ? await readReviewRules() : null;
        const seen = { ...current, ...form } as unknown as ReviewItem;
        if (rules) { const problems = reviewProblems(seen, rules); if (problems.length) throw new Error(problems.join(" ")); }
        const aiFields = approve || forBatch ? [...aiSet].filter(key => !SHOWN_AI_FIELDS.has(key)) : [...aiSet];
        const draftToken = await recovery.prepareSave();
        const result = await saveReviewItem(current.id, withExpectedItemValues(draftToken.expected,
          { ...form, status: "Needs Info", aiFields: aiFields.length ? aiFields : null }), approve);
        await recovery.saved(draftToken, result.item as DraftItem);
        updateItem(current.id, { ...result.item, photos: current.photos });
        if (forBatch && rules) {
          const fresh = await readReviewItem(current.id);
          if (!fresh) throw new Error("Details saved, but the item is no longer available for individual review.");
          const checkpoint = await createReviewCheckpoint(seen, fresh, result.item.updatedAt, rules);
          await putReviewCheckpoint(checkpoint);
          setItems(previous => { const next = previous.filter(item => item.id !== current.id); setIdx(index => reviewQueueIndex(index, next.length)); return next; });
          setBatchCount((await listReviewCheckpoints()).filter(row => row.phase !== "approved").length);
          if (!(current.listedPrice != null && current.listedPrice > 0) && fresh.listedPrice != null && fresh.listedPrice > 0) {
            pricingCountVersion.current++; setUnpricedCount(value => value == null ? null : Math.max(0, value - 1));
          }
          toast.success(`${current.sku} reviewed for batch approval`);
        } else
        if (result.approved) {
          setItems(previous => { const next = previous.filter(item => item.id !== current.id); setIdx(index => reviewQueueIndex(index, next.length)); return next; });
          toast.success(`${current.sku} approved for Crosslisting`);
          try { const checkpoint = await readReviewCheckpoint(reviewKey(current)); if (checkpoint) await forgetReviewCheckpoint(checkpoint);
            setBatchCount((await listReviewCheckpoints()).filter(row => row.phase !== "approved").length); }
          catch { toast.warning("Item approved; refresh Batch approval to check its local checkpoint."); }
        } else {
          updateItem(current.id, { ...result.item, photos: current.photos });
          setDraftSaved(true); toast.success(`Draft saved · ${current.sku}`);
        }
        if (result.copyWarnings.length) toast.warning(result.copyWarnings.join("; "));
        void learnVocab(result.item, ['brand', 'itemType', 'size', 'color', 'pattern', 'style', 'condition']);
      };
      if (forBatch) await withReviewLock(reviewKey(current), save); else await save();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed. Your draft is still here.";
      setSaveError(message); toast.error(message);
    } finally { savingRef.current = false; setSaving(false); }
  }, [current, form, aiSet, requiredFields, minPhotos, loadError, detailError, loadingQueue, recovery, learnVocab, batchBusy]);
  const saveAndNext = useCallback(() => saveCurrent(true), [saveCurrent]);

  // Skip DEFERS the current item instead of silently wrapping the index (the old
  // `(idx + 1) % len` jumped back to the start with no signal). It moves the item to the
  // END of the queue and tags it "skipped", then shows the next fresh one — so nothing is
  // passed over unseen and there's no confusing wrap-around (§29).
  const skip = useCallback(() => {
    if (!current || activeReviewId.current !== current.id || items.length <= 1 || savingRef.current || !recovery.canLeave) return;
    const id = current.id;
    setDetail(null); setDetailRequest(value => value + 1);
    setSkipped((s) => { const n = new Set(s); n.add(id); return n; });
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      if (i === -1) return prev;
      const arr = prev.slice();
      const [it] = arr.splice(i, 1);
      arr.push(it);
      return arr;
    });
    // The next item slides into the current slot; if we were on the LAST item, continue
    // from the front of the reordered queue (the skipped item now sits at the back).
    setIdx((p) => (p >= items.length - 1 ? 0 : p));
  }, [current, items, recovery.canLeave]);

  // Flag = "come back to this one": persists on the item (survives restarts, shows in
  // Inventory's flagged filter), and defers it to the end of the queue like Skip.
  const toggleFlag = useCallback(async () => {
    if (!current || savingRef.current) return;
    const next = !current.flagged;
    try {
      const response = await fetch(`/api/items/${current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withExpectedItemValues({ createdAt: current.createdAt, status: current.status, flagged: current.flagged }, { flagged: next })) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Could not save the flag");
      updateItem(current.id, { flagged: next });
      if (next) { toast.message(`${current.sku} flagged for later`); if (items.length > 1) skip(); }
    } catch (error) { toast.error((error as Error).message); }
  }, [current, items.length, skip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "queue") return; // pricing mode owns its own Enter handling
      if (e.key === "Escape" && lightbox) { setLightbox(null); return; }
      if (lightbox) return; // don't save/advance underneath the photo viewer
      const blocked = !!(e.target as HTMLElement)?.closest?.("[data-review-research], [role=dialog], dialog, textarea, button, select");
      const action = reviewHotkey(e, blocked);
      if (action) {
        e.preventDefault();
        if (action === "batch") void saveCurrent(false, true); else void saveAndNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveAndNext, saveCurrent, mode, lightbox]);

  async function refreshPhotos(id: number) {
    const response = await fetch(`/api/items/${id}`);
    if (!response.ok) throw new Error("Could not refresh photos. Try reloading Review.");
    const { item } = await response.json();
    updateItem(id, { photos: item.photos });
  }
  async function photoOp(photo: Photo, patch: Record<string, unknown>) {
    if (!current || savingRef.current) return;
    try {
      const response = await fetch(`/api/photos/${photo.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...patch, expectedItemId: current.id }) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "Photo change could not be confirmed.");
      await refreshPhotos(current.id);
    } catch (error) { toast.error((error as Error).message); await refreshPhotos(current.id).catch(() => {}); }
  }
  async function movePhoto(photo: Photo, delta: -1 | 1) {
    if (!current || savingRef.current) return;
    const listing = current.photos.filter(p => !p.isMarker).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const i = listing.findIndex(p => p.id === photo.id), j = i + delta;
    if (i < 0 || j < 0 || j >= listing.length) return;
    const expectedOrder = listing.map(p => p.id), photoOrder = [...expectedOrder];
    [photoOrder[i], photoOrder[j]] = [photoOrder[j], photoOrder[i]];
    try {
      const response = await fetch(`/api/photos/${photo.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoOrder, expectedOrder, expectedItemId: current.id }) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "Photo order could not be confirmed. Reloading its current order.");
    } catch (error) { toast.error((error as Error).message); }
    finally { await refreshPhotos(current.id).catch(error => toast.error(error.message)); }
  }

  // Remove a photo outright (bad shot, wrong item). Working copy + thumb are deleted and
  // the dedup hash is freed; the /archive original survives, so nothing is unrecoverable.
  async function removePhoto(photo: Photo) {
    if (!current) return;
    if (!confirm("Remove this photo from the item?\n\nUnused working copies are removed. Archived originals and shared copies are kept.")) return;
    try {
      const r = await fetch(`/api/photos/${photo.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedItemId: current.id }) });
      const result = await r.json().catch(() => null);
      if (!r.ok || !result?.ok) throw new Error(result?.error || "Photo removal could not be confirmed.");
      if (result.cleanupWarnings?.length) toast.warning(result.cleanupWarnings.join(" "));
    } catch (error) { toast.error((error as Error).message); }
    finally { await refreshPhotos(current.id).catch(error => toast.error(error.message)); }
  }

  // Mode switch: the review cards vs. the fast pricing table.
  const modeBar = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
      <button className="btn" data-sound="none" data-draft-navigation disabled={saving || batchBusy || !recovery.canLeave} onClick={() => changeMode("queue")}
        style={mode === "queue" ? { borderColor: "var(--accent)" } : undefined}>
        <Check size={14} /> Review queue{queueKnown ? ` (${items.length})` : ''}
      </button>
      <button className="btn" data-sound="none" data-draft-navigation disabled={saving || batchBusy || !recovery.canLeave} onClick={() => changeMode("pricing")}
        style={mode === "pricing" ? { borderColor: "var(--accent)" } : undefined}>
        <Tag size={14} /> Pricing{unpricedCount != null ? ` (${unpricedCount} to finish)` : ""}
      </button>
      <button className="btn" data-sound="none" data-draft-navigation disabled={saving || batchBusy || !recovery.canLeave} onClick={() => changeMode("batch")}
        style={mode === "batch" ? { borderColor: "var(--accent)" } : undefined}>Batch approval{batchCount !== null ? ` (${batchCount})` : ''}</button>
      {mode === 'queue' && queueKnown && <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={event => {
        event.preventDefault(); if (savingRef.current || batchBusy || loadingQueue || loadError || !recovery.canLeave) return;
        const found = items.findIndex(item => item.sku.toLowerCase() === findSku.trim().toLowerCase());
        if (found < 0) { toast.message('That SKU is not in the current individual-review queue. Check Inventory or Batch approval.'); return; }
        setDetail(null); setDetailRequest(value => value + 1); setIdx(found); setFindSku(''); setDetailError(null);
      }}>
        <input className="input" style={{ width: 155 }} aria-label="Find SKU in review" placeholder="Find exact SKU" value={findSku} onChange={event => setFindSku(event.target.value)} />
        <button className="btn" data-draft-navigation disabled={saving || batchBusy || loadingQueue || !!loadError || !recovery.canLeave || !findSku.trim()}>Go to SKU</button>
      </form>}
    </div>
  );

  if (mode === "batch") return <div>{modeBar}<BulkReview onBusy={setBatchBusy} onFinished={() => void load()}
    onReview={id => { focusReviewId.current = id ?? null; setMode("queue"); }} /></div>;
  if (mode === "pricing") {
    return (
      <div>
        {modeBar}
        <PricingTable onCount={updatePricingCount} onNavigation={registerPricingNavigation} />
      </div>
    );
  }
  if (loadError) return <div>{modeBar}<div className={styles.error} role="alert">{loadError} <button className="btn" onClick={() => void load()}>Retry loading Review</button></div></div>;
  if (detailError) return <div>{modeBar}<div className={styles.error} role="alert">{detailError} <button className="btn" onClick={() => void load()}>Retry loading Review</button></div></div>;
  if (loadingQueue) return <div>{modeBar}<p role="status">Loading your review workspace…</p></div>;
  if (items.length && !current) return <div>{modeBar}<p role="status">Loading details for {identity?.sku}…</p></div>;
  if (!items.length || !current) {
    return (
      <div>
        {modeBar}
        {(batchCount ?? 0) > 0 ? <div className="card" style={{ padding: 28 }}><h2>Individual review is caught up</h2>
          <p>{batchCount} local checkpoint(s) are waiting for batch approval or follow-up.</p>
          <button className="btn btn-primary" onClick={() => changeMode("batch")}>Open batch approval</button></div> : <Empty />}
      </div>
    );
  }

  // How many items still in the queue were skipped/flagged (drives the counts; ignores
  // saved ones that already left the list).
  const skippedInQueue = items.filter((it) => skipped.has(it.id)).length;
  const flaggedInQueue = items.filter((it) => it.flagged).length;

  const reasons = groupingReasons(current);
  // "medium" belongs here too. It is the verdict for the exact symptoms that mean
  // two items merged - an unusually long pause mid-group, or a photo count well
  // above the batch median - and it used to show only as a chip with a hover
  // tooltip. In the 2026-08-31 batch 7 of the 8 flagged items were "medium",
  // so the merged ones were findable only by eye.
  const groupingUnsure = current.groupingConfidence === "low"
    || current.groupingConfidence === "medium"
    || current.isShell;
  const noAi = !current.aiFields && !current.aiRaw && !current.aiError;
  const aiSkipped = isAiSkipped(current.aiError);
  const aiPendingCount = items.filter((it) => it.hasAiError).length;

  // Re-run AI identification from the item's stored photos (recovery for a batch
  // that imported with a dead vision endpoint — no re-shoot, no re-import).
  async function retryAi(target: Pick<Item, 'id' | 'sku'>, opts?: { silent?: boolean }): Promise<boolean> {
    if (savingRef.current || !recovery.ready || recovery.discarding) return false;
    const t = opts?.silent ? undefined : toast.loading(`Re-running AI for ${target.sku}…`);
    try {
      const r = await fetch(`/api/items/${target.id}/reidentify`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        if (t !== undefined) toast.error(`${target.sku}: AI retry failed — ${j.error ?? r.statusText}`, { id: t, duration: 10000 });
        return false;
      }
      const updated = j.item as Partial<Item>;
      updateItem(target.id, updated);
      if (target.id === activeReviewId.current && !savingRef.current) {
        // Merge ONLY still-empty form fields so typed-but-unsaved edits survive.
        setForm((f) => {
          const out = { ...f } as Record<string, unknown>;
          for (const k of ["size", "itemType", "category", "color", "pattern", "brand", "fit", "style", "weightOz", "description"] as const) {
            const cur = out[k];
            if (!recovery.hasEdit(k) && (cur == null || cur === "") && updated[k] != null) out[k] = updated[k];
          }
          return out as Partial<Item>;
        });
        try { setAiSet(new Set((updated.aiFields ? (JSON.parse(updated.aiFields as string) as string[]) : []).filter(field => !recovery.hasEdit(field)))); } catch { /* keep */ }
      }
      if (t !== undefined) toast.success(`${target.sku}: AI filled ${j.filled?.length ? j.filled.join(", ") : "no new fields"}`, { id: t });
      return true;
    } catch (e) {
      if (t !== undefined) toast.error(`${target.sku}: AI retry failed — ${e instanceof Error ? e.message : String(e)}`, { id: t });
      return false;
    }
  }

  // Sequential bulk retry (the vision model handles one item at a time anyway).
  async function retryAllFailed() {
    const failed = items.filter((it) => it.hasAiError);
    if (!failed.length) return;
    const t = toast.loading(`Re-running AI for ${failed.length} item(s)…`);
    let ok = 0;
    for (const [n, it] of failed.entries()) {
      toast.loading(`Re-running AI… ${n + 1}/${failed.length} (${it.sku})`, { id: t });
      if (await retryAi(it, { silent: true })) ok++;
      else if (n === 0) break; // first one failed — the endpoint is still down, don't grind through the rest
    }
    if (ok === failed.length) toast.success(`AI identification recovered for all ${ok} item(s).`, { id: t });
    else toast.error(`AI recovered ${ok} of ${failed.length} — the vision server still isn't answering. Check Settings → AI Vision.`, { id: t, duration: 12000 });
  }

  // Rename a shell (FIX-xxxx) to its real sticker number without leaving the queue.
  // (In-app dialog, NOT window.prompt — Electron throws on prompt().)
  function assignSku() {
    const cur = current;
    if (!cur) return;
    setDialog({
      title: `Real SKU for ${cur.sku}`,
      message: "The sticker number this item should have.",
      placeholder: "e.g. 000048",
      actionLabel: "Set SKU",
      onSubmit: async (v) => {
        const r = await fetch(`/api/items/${cur.id}`, { method: "PATCH", body: JSON.stringify(withExpectedItemValues({ createdAt: cur.createdAt, sku: cur.sku, status: cur.status }, { sku: v })) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return j.error || "Could not rename SKU";
        updateItem(cur.id, { sku: j.item.sku, isShell: false });
        toast.success(`SKU set to ${j.item.sku}`);
        return null;
      },
    });
  }

  return (
    <div className={styles.workspace}>
      {modeBar}
      <VocabularyNotice state={vocabulary} />
      <div className={styles.heading}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>
          Review · {current.sku}
          {skipped.has(current.id) && (
            <span className="chip" style={{ marginLeft: 10, fontSize: 12, color: "var(--warn)", verticalAlign: "middle" }}>skipped</span>
          )}
          {current.flagged && (
            <span className="chip" style={{ marginLeft: 10, fontSize: 12, color: "var(--warn)", verticalAlign: "middle" }}>🚩 flagged</span>
          )}
          {current.isShell && (
            <button className="btn" onClick={assignSku} data-sound="none"
              title="This item came from an unreadable/missing SKU sticker — give it its real number"
              style={{ marginLeft: 10, fontSize: 12, verticalAlign: "middle", borderColor: "var(--warn)", color: "var(--warn)" }}>
              Unrecognized — set real SKU
            </button>
          )}
          {!current.isShell && current.groupingConfidence === "low" && (
            <span className="chip" title={reasons.join("\n") || "Grouping confidence is low"}
              style={{ marginLeft: 10, fontSize: 12, verticalAlign: "middle", background: "var(--panel-2)", color: "var(--warn)" }}>
              ⚠ Grouping uncertain
            </span>
          )}
          {!current.isShell && current.groupingConfidence === "medium" && (
            <span className="chip" title={reasons.join("\n") || "Double-check this grouping"}
              style={{ marginLeft: 10, fontSize: 12, verticalAlign: "middle", background: "var(--panel-2)" }}>
              Grouping: double-check
            </span>
          )}
          {noAi && (
            <span className="chip" title="AI recognition didn't run for this item — enter the details by hand (nothing was lost)."
              style={{ marginLeft: 10, fontSize: 12, verticalAlign: "middle", background: "var(--panel-2)" }}>
              No AI data — fill manually
            </span>
          )}
          {current.aiError && (
            <span className="chip" title={current.aiError}
              style={{ marginLeft: 10, fontSize: 12, verticalAlign: "middle", background: "var(--panel-2)", color: aiSkipped ? "var(--muted)" : "var(--danger)" }}>
              {aiSkipped ? "AI skipped by request" : "⚠ AI failed"}
            </span>
          )}
        </h1>
        <span className="muted">
          <a href={`/inventory/${current.id}`} style={{ marginRight: 10 }}>Full editor ↗</a>
          {Math.min(idx + 1, items.length)} / {items.length} in queue
          {skippedInQueue > 0 ? ` · ${skippedInQueue} skipped` : ""}
          {flaggedInQueue > 0 ? ` · 🚩 ${flaggedInQueue} flagged` : ""} · Enter = approve &amp; next · Ctrl+Enter = reviewed for batch
        </span>
      </div>

      <DraftRecovery recovery={recovery} item={current as unknown as DraftItem} disabled={saving} />
      {groupingUnsure && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, borderColor: "var(--warn)", fontSize: 13, display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: "var(--warn)" }}>⚠</span>
          <span style={{ flex: 1 }}>
            {current.isShell
              ? "This shell was created because a SKU sticker couldn't be read (or was missing). Set its real SKU above; if photos are missing or don't belong here, "
              : "These photos may not all be one item. "}
            {!current.isShell && reasons.length > 0 && (
              // EVERY reason, not just the first: the decisive one is often not first.
              // 000148 listed "429s pause inside this group" first and "SKU 000147 is
              // missing right before this item" second — the second is the one that
              // actually names the merge, and it was invisible without hovering.
              <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                {reasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            )}
            {!current.isShell && "To split them or move photos to another item, "}
            <a href={`/inventory/${current.id}`}>open the full editor</a>.
          </span>
        </div>
      )}

      {/* AI-failure recovery banner — the durable, per-item face of the 2026-08-05
          blank-batch fix: WHY it failed + one-click retry from the stored photos. */}
      {current.aiError && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, borderColor: aiSkipped ? "var(--border)" : "var(--danger)", fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!aiSkipped && <span style={{ color: "var(--danger)" }}>⚠</span>}
          <span style={{ flex: 1 }}>
            {aiSkipped ? "You chose to import this item without AI. Fill in its details manually or run AI using the saved photos."
              : <>AI identification failed for this item: <b>{current.aiError}</b>. You can retry using the saved photos.</>}
          </span>
          <button className="btn" onClick={() => void retryAi(current)} data-sound="none" style={{ whiteSpace: "nowrap" }}>
            <RotateCw size={14} /> {aiSkipped ? "Run AI" : "Retry AI"}
          </button>
          {aiPendingCount > 1 && (
            <button className="btn" onClick={() => void retryAllFailed()} data-sound="none" style={{ whiteSpace: "nowrap" }}
              title="Run AI for every item in this queue where identification was skipped or failed">
              Run AI for {aiPendingCount} skipped or failed
            </button>
          )}
        </div>
      )}

      <div className={styles.grid}>
        <div className={styles.photoColumn}>
          <div className={styles.sideTabs} aria-label="Review tools"><button aria-pressed={sideTab === "photos"} onClick={() => setSideTab("photos")}>Photos & labels</button><button aria-pressed={sideTab === "research"} onClick={() => setSideTab("research")}>Price research</button><button aria-pressed={sideTab === "copy"} onClick={() => setSideTab("copy")}>Listing preview{titleBuild.warnings.length ? ` · ${titleBuild.warnings.length}` : ""}</button></div>
          <div style={{display:sideTab === "photos" ? "grid" : "none",gap:14}}>
          <ReviewPhotos key={current.id} sku={current.sku} photos={current.photos} disabled={saving} onEnlarge={setLightbox} onChange={photoOp} onMove={movePhoto} onRemove={removePhoto} onSelect={setSelectedPhotoId} />
          <details className={styles.aiTools}><summary>Recheck AI using these photos</summary>
          <AiSuggestions key={`ai-${current.id}`} itemId={current.id} current={{ ...current, ...form }} photoIds={[...new Set([current.photos.find(photo => photo.isCover && !photo.isMarker && photo.includeInListing)?.id, selectedPhotoId ?? current.photos.filter(photo => !photo.isMarker && photo.includeInListing).at(-1)?.id].filter((id): id is number => typeof id === "number"))]} onApply={(field,value) => field === "brand" ? setBrand(value) : setField(field as keyof Item, value)} />
          </details></div>
          <div style={{display:sideTab === "research" ? "block" : "none"}}>
          <PriceResearch key={`research-${current.id}`} item={{ ...current, ...form }} onPrice={value => setField("listedPrice", value)} />
          </div>
          <div className="card" style={{ display: sideTab === "copy" ? "block" : "none", padding: 16, overflowWrap: "anywhere" }}>
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Listing copy preview</h2>
            <strong>{titleBuild.finalTitle}</strong>
            <p style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6 }}>{titleBuild.description}</p>
            {!!titleBuild.warnings.length && <ul role="status" style={{ color: "var(--warn)", paddingLeft: 18 }}>{titleBuild.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
            <label style={{ display: "block", marginTop: 12 }}>Description override
              <textarea className="input" rows={7} style={{ width: "100%", boxSizing: "border-box", marginTop: 6 }}
                disabled={saving || !recovery.ready || recovery.discarding} value={form.description ?? ""}
                placeholder="Leave blank to generate from the item details" onChange={event => setField("description", event.target.value)} />
            </label>
            <button className="btn" disabled={saving || !recovery.ready || recovery.discarding} onClick={() => setField("description", titleBuild.description)}>Use preview text for editing</button>
            <p className="muted" style={{ fontSize: 12 }}>This preview uses the same title and description builder as approval. Edits remain drafts until saved.</p>
          </div>
        </div>

        {/* Fields */}
        <fieldset className={styles.fields} disabled={saving || !recovery.ready || recovery.discarding} data-review-fields>
          <div className={styles.fieldHeading}><span className={styles.step}>1</span><div><h2>Make it accurate</h2><p>Confirm the identity, then set your price.</p></div></div>
          <div className={styles.priority}>
          <Field label="Brand" ai={aiSet.has("brand")} evidence={evidence.brand}>
            <VocabInput value={form.brand === "Unknown" ? "" : form.brand ?? ""} list={vocab.brand} onChange={setBrand} />
            <SuggestionHint
              suggestion={suggestions.brand}
              current={form.brand ?? ""}
              onApply={() => setBrand(suggestions.brand)}
            />
            <div style={{display:"flex",gap:8,alignItems:"center",marginTop:7,fontSize:11,color:"var(--muted)"}}><span>Unreadable label? Save a draft.</span><button className="btn" type="button" style={{fontSize:10,padding:"4px 7px"}} onClick={()=>setBrand("Unbranded")}>Confirmed unbranded</button></div>
          </Field>
          <Field label="Item Type *" ai={aiSet.has("itemType")} evidence={evidence.itemType}><VocabInput value={form.itemType ?? ""} list={vocab.itemType} onChange={(v) => setField("itemType", v)} /></Field>
          <Field label="Department — decides how the size reads"
            ai={aiSet.has("department")} evidence={evidence.department}>
            <div style={{ display: "flex", gap: 6 }}>
              {DEPARTMENT_QUICK.map((d) => {
                const on = deptKey(form.department) === deptKey(d);
                return (
                  <button key={d} type="button" className="btn" data-sound="none"
                    title={`Mark this item ${d}`}
                    onClick={() => setField("department", on ? "" : d)}
                    style={{
                      flex: 1, fontSize: 12, padding: "6px 8px",
                      borderColor: on ? "var(--accent)" : undefined,
                      color: on ? "var(--accent)" : undefined,
                      fontWeight: on ? 600 : 400,
                    }}>
                    {on ? "✓ " : ""}{d === "Unisex Adults" ? "Unisex" : d}
                  </button>
                );
              })}
            </div>
          </Field>
          </div>
          <Field
            label={sizelessOk(form.itemType ?? null, form.category ?? null) ? "Size (optional for this category)" : "Size *"}
            ai={aiSet.has("size")} evidence={evidence.size}>
            <VocabInput value={form.size ?? ""} list={vocab.size} onChange={(v) => setField("size", v)} />
          </Field>
          {needsInseam(form.itemType ?? null) && (
            <Field label="Inseam (in) — eBay">
              <input className="input" type="number" step="0.5" min="0" placeholder="e.g. 32" value={form.inseam ?? ""} onChange={(e) => setField("inseam", e.target.value)} />
            </Field>
          )}
          <Field label="Category" ai={aiSet.has("category")} evidence={evidence.category}>
            <select className="select" value={form.category ?? itemCategory(form.category ?? null, form.itemType ?? null)}
              onChange={(e) => setField("category", e.target.value)}>
              {CATEGORY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          {/* Every field is FREE TEXT with suggestions (there are too many kinds of items
              for strict dropdowns). Off-list values are fine: the upload assist maps
              colors to each marketplace's palette (base-color fallback) and custom-adds
              style/pattern/brand values via the in-menu "Add". */}
          <Field label="Color *" ai={aiSet.has("color")} evidence={evidence.color}>
            <VocabInput value={form.color ?? ""} list={COLOR_OPTIONS} onChange={(v) => setField("color", v)} />
          </Field>
          <Field label="Condition">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <VocabInput value={form.condition ?? ""} list={[...new Set([...(vocab.condition ?? []), ...CONDITION_OPTIONS])]} onChange={(v) => setField("condition", v)} />
              </div>
              <button type="button" className="btn" data-sound="none" onClick={toggleNwt}
                aria-pressed={nwt}
                title={nwt
                  ? "This item is marked New With Tags — press to clear it"
                  : "Mark New With Tags — adds NWT to the front of the listing title"}
                style={{
                  padding: "6px 12px", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap",
                  background: nwt ? "var(--accent)" : undefined,
                  color: nwt ? "var(--accent-ink)" : undefined,
                  borderColor: nwt ? "var(--accent)" : undefined,
                }}>
                <Tag size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />NWT
              </button>
            </div>
          </Field>
          {/* Price sits with the gate fields — it's required before a publish run, so it
              shouldn't hide below the fold (the Pricing tab covers bulk passes). */}
          <div className={styles.fieldHeading}><span className={styles.step}>2</span><div><h2>Set your price</h2><p>Use actual listings and your past sales.</p></div><button className="btn" style={{marginLeft:"auto",fontSize:12}} type="button" onClick={() => setSideTab("research")}>Research ↗</button></div>
          <Field label="Price ($) — fills every marketplace">
            <input className="input" type="number" step="0.01" min="0"
              placeholder={(() => { const p = estimatePrice(form.itemType ?? null); return p != null ? `suggested ~$${p} (type-based)` : "e.g. 24.99"; })()}
              value={form.listedPrice ?? ""} onChange={(e) => setField("listedPrice", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <PackageDetailsNote details={describePackage({ itemType: form.itemType, weightOz: form.weightOz })} />
          <details className={styles.advanced}><summary>More details & listing copy</summary><div>
          <Field label="Model / style no. — printed in the title">
            <input className="input" value={form.model ?? ""} placeholder="e.g. 501"
              onChange={(e) => setField("model", e.target.value)} />
          </Field>
          <Field label="Style" ai={aiSet.has("style")} evidence={evidence.style}>
            <VocabInput value={form.style ?? ""} list={[...new Set([...(vocab.style ?? []), ...STYLE_OPTIONS])]} onChange={(v) => setField("style", v)} />
          </Field>
          <Field label="Pattern" ai={aiSet.has("pattern")} evidence={evidence.pattern}><VocabInput value={form.pattern ?? ""} list={PATTERN_OPTIONS} onChange={(v) => setField("pattern", v)} /></Field>
          <Field label="Fit" ai={aiSet.has("fit")} evidence={evidence.fit}>
            <VocabInput value={form.fit ?? ""} list={FIT_OPTIONS} onChange={(v) => setField("fit", v)} />
          </Field>
          <Field label="Ship Weight (oz)" ai={aiSet.has("weight")}>
            <input className="input" type="number" step="1" min="0" value={form.weightOz ?? ""} onChange={(e) => setField("weightOz", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="True Vintage">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={!!form.trueVintage}
                onChange={(e) => {
                  const v = e.target.checked;
                  setField("trueVintage", v);
                  // Checking the box is enough — make sure the Etsy era reads as vintage.
                  if (v && !isVintage(form.whenMade)) setField("whenMade", VINTAGE_WHEN_MADE_DEFAULT);
                }}
              />
              20+ years old — list on Etsy as vintage
            </label>
          </Field>
          <Field label="When Made (Etsy)">
            <VocabInput value={form.whenMade ?? ""} list={WHEN_MADE_OPTIONS} onChange={(v) => setField("whenMade", v)} />
            {form.trueVintage && !isVintage(form.whenMade) && (
              <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 4 }}>⚠ Pick a 20+ year era (export will use “{VINTAGE_WHEN_MADE_DEFAULT}”).</div>
            )}
          </Field>
          <Field label="Etsy category (handmade / supply)">
            <select className="select" value={form.etsyEligible ?? "none"} onChange={(e) => setField("etsyEligible", e.target.value)}>
              {ETSY_ELIGIBLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Listing notes (public — included in description)">
            <textarea className="input" rows={3} value={form.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} />
          </Field>
          <Field label="Key Details - one per line (ordered title keywords)"
            ai={aiSet.has("keyDetails")} evidence={evidence.keyDetails}>
            <textarea className="input" rows={3} placeholder={"Star Wars\nFleece-Lined"}
              aria-label="Key Details, one per line, in title preference order"
              aria-describedby="key-details-title-status"
              value={form.keyDetails ?? ""} onChange={(e) => setField("keyDetails", e.target.value)} />
            {keyDetailLines.length > 0 && (
              <div aria-hidden="true" style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                {keyDetailLines.map((detail, index) => {
                  const inTitle = index === titleKeyDetailIndex;
                  return (
                    <span key={`${index}-${detail}`} title={inTitle
                      ? "Selected as the key-detail phrase in the auto-generated title"
                      : "Not selected for the auto title's key-detail phrase"}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "3px 7px", borderRadius: 6, fontSize: 11,
                        border: `1px solid ${inTitle ? "var(--accent)" : "var(--border)"}`,
                        color: inTitle ? "var(--accent)" : "var(--muted)",
                        background: "var(--panel-2)",
                      }}>
                      {detail}
                      {inTitle && <strong style={{ fontSize: 10, letterSpacing: 0.5 }}>TITLE DETAIL</strong>}
                    </span>
                  );
                })}
              </div>
            )}
            <div id="key-details-title-status" role="status" aria-live="polite" className="muted"
              style={{ fontSize: 11, marginTop: 5, lineHeight: 1.4 }}>
              {form.customTitle?.trim()
                ? titleKeyDetail
                  ? `A custom title is active. Auto title would use "${titleKeyDetail}" as its detail if reset.`
                  : "A custom title is active. No line currently fills the auto title's key-detail slot."
                : titleKeyDetail
                  ? `Auto title uses "${titleKeyDetail}" as its key-detail phrase. Move or delete lines to change it.`
                  : "No line currently fills the auto title's key-detail slot. Move, add, or remove lines to update it."}
            </div>
          </Field>
          {/* The last thing seen before Save & next: this is the headline buyers read,
              and Review is the final stop before the item can publish. */}
          <Field label={form.customTitle?.trim()
            ? "Listing Title (custom — used on the next upload)"
            : "Listing Title (auto-generated — press Edit title to change it)"}>
            <input
              className="input" maxLength={80}
              value={form.customTitle ?? ""}
              placeholder={titlePreview || "auto-generated from the fields above"}
              onChange={(e) => setField("customTitle", e.target.value)}
              style={{ width: "100%", fontWeight: 600, borderColor: form.customTitle?.trim() ? "var(--accent)" : undefined }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 5, gap: 8 }}>
              <span className="muted" style={{ fontSize: 11, color: titleCheck.ok ? undefined : "var(--warn)" }}>
                {effectiveTitle.length}/80{titleCheck.ok ? "" : ` · ${titleCheck.issues.join(", ")}`}
                {!form.customTitle?.trim() && " · auto"}
              </span>
              {form.customTitle?.trim() ? (
                <button type="button" className="btn" style={{ padding: "2px 10px", fontSize: 12 }} data-sound="none"
                  onClick={() => setField("customTitle", null)}
                  title="Clear the custom title and go back to the auto-generated one">
                  Reset to auto
                </button>
              ) : (
                // The generated title is only a PLACEHOLDER until this is pressed, so
                // without it the text looks greyed out and editing one word means
                // retyping all 80 characters.
                <button type="button" className="btn" style={{ padding: "2px 10px", fontSize: 12 }} data-sound="none"
                  disabled={!titlePreview}
                  onClick={() => setField("customTitle", titlePreview)}
                  title="Copy the auto-generated title into the box so you can edit it">
                  Edit title
                </button>
              )}
            </div>
          </Field>
          </div></details>
        </fieldset>
      </div>
      <div className={styles.actions} onKeyDown={event => { if (event.key === "Enter" && event.repeat) event.preventDefault(); }}>
        {saveError && <div className={styles.error} role="alert">{saveError}</div>}
        <div><strong>#{current.sku} · {saving ? "Saving…" : draftSaved ? "Draft saved" : "Review → Price → Crosslisting"}</strong><small>Only approved, priced items enter the queue.</small></div>
        <button className={`btn ${styles.moreActions}`} aria-expanded={moreActions} aria-controls="review-secondary-actions" onClick={() => setMoreActions(value => !value)}>More <ChevronRight size={14} /></button>
        <div id="review-secondary-actions" className={styles.secondaryActions} data-open={moreActions}>
          <button className="btn" disabled={saving || !recovery.canSave} onClick={() => void saveCurrent(false)}>Save draft</button>
          <button className="btn" disabled={saving || !recovery.canSave} onClick={() => void saveCurrent(false, true)}>Reviewed for batch &amp; next</button>
          <button className="btn" disabled={saving} onClick={toggleFlag}>{current.flagged ? "Unflag" : "Flag"}</button>
          <button className="btn" disabled={saving || !recovery.canLeave || items.length <= 1} onClick={skip}>Later</button>
        </div>
        <button className="btn btn-primary" disabled={saving || !recovery.canSave} onClick={() => void saveAndNext()}><Check size={17} />{saving ? "Saving…" : "Approve & next"}</button>
      </div>

      {lightbox && <PhotoViewer photos={[...current.photos].sort((a,b)=>Number(a.isMarker)-Number(b.isMarker)||a.sortOrder-b.sortOrder)} photoId={lightbox.id} sku={current.sku}
        onSelect={photoId=>{const photo=current.photos.find(value=>value.id===photoId);if(photo)setLightbox(photo);}} onClose={()=>setLightbox(null)} />}

      <PromptDialog spec={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

function Empty() {
  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800 }}>Review</h1>
      <div className="card" style={{ padding: 44, textAlign: "center" }} >
        <CatMark size={44} blink />
        <p className="muted" style={{ margin: "12px 0 0" }}>Queue is clear — every item has what it needs. 🎉</p>
      </div>
    </div>
  );
}

function Field({ label, ai, evidence, children }: {
  label: string; ai?: boolean; evidence?: FieldEvidence | null; children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block" }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
        {label}{ai && <AiBadge />}{evidence && <EvidenceBadge evidence={evidence} />}
      </div>
      {children}
    </label>
  );
}

/** One attribute's provenance, as written by the worker (evidence.py). */
type FieldEvidence = {
  value?: unknown;
  status?: "verified" | "inferred" | "uncertain" | "confirmed";
  sources?: string[];
  rawOcr?: string;
  note?: string;
};

// Parse Item.evidenceJson defensively: it is operator-facing decoration, and a
// malformed blob must never take the review queue down.
function parseEvidence(raw: unknown): Record<string, FieldEvidence> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, FieldEvidence>) : {};
  } catch {
    return {};
  }
}

/** Read raw.normalizationSuggestions out of aiRaw, defensively. */
function parseSuggestions(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const found = parsed?.normalizationSuggestions;
    if (!found || typeof found !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(found)) {
      if (typeof value === "string" && value.trim()) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const EVIDENCE_STYLE = {
  confirmed: { label: "YOU", bg: "var(--mint)", hint: "Your correction" },
  verified: { bg: "var(--ok)", label: "READ", hint: "Matches text detected in a photo; OCR may misread text or read graphics. Check the item's label" },
  inferred: { bg: "var(--panel-2)", label: "GUESS", hint: "Suggested from the photos without a matching text reading" },
  uncertain: { bg: "var(--warn)", label: "CHECK", hint: "Detected photo text and the visual suggestion disagree" },
} as const;

/**
 * Separates photo-text matches from visual inference and operator corrections.
 * Matching OCR is useful evidence, but it does not prove the text was on a label.
 */
function EvidenceBadge({ evidence }: { evidence: FieldEvidence }) {
  const status = evidence.status && evidence.status in EVIDENCE_STYLE ? evidence.status : "inferred";
  const style = EVIDENCE_STYLE[status];
  const detail = [
    style.hint,
    evidence.rawOcr ? `Photo text: "${evidence.rawOcr}"` : "",
    evidence.note ?? "",
  ].filter(Boolean).join(" — ");
  return (
    <span title={detail}
      style={{
        fontSize: 9, fontWeight: 800, letterSpacing: 0.4, background: style.bg,
        color: { inferred: "var(--muted)", confirmed: "var(--mint-ink)", verified: "var(--ok-ink)", uncertain: "var(--warn-ink)" }[status],
        border: status === "inferred" ? "1px solid var(--border)" : "none",
        padding: "1px 5px", borderRadius: 5, cursor: "help",
      }}>
      {style.label}
    </span>
  );
}

function AiBadge() {
  return (
    <span title="Auto-filled by AI — confirm or edit"
      style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, background: "var(--accent)", color: "var(--accent-ink)", padding: "1px 5px", borderRadius: 5 }}>
      AI
    </span>
  );
}

function VocabInput({ value, list, onChange }: { value: string; list?: readonly string[]; onChange: (v: string) => void }) {
  const id = useMemo(() => "dl-" + Math.random().toString(36).slice(2), []);
  return (
    <>
      <input className="input" list={id} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>{(list ?? []).map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick} style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", padding: 3, display: "inline-flex" }}>
      {children}
    </button>
  );
}

/**
 * "Did you mean X?" for a value the normalizer recognized as a near miss.
 *
 * It is a button, not an automatic correction, on purpose: OCR read "QLIKSILVER"
 * off a real tag and vision reported "Roast" for a Roar item. Those are worth
 * showing an operator and are exactly the cases where guessing would put a
 * confidently wrong brand on a live listing.
 */
function SuggestionHint({ suggestion, current, onApply }: {
  suggestion?: string; current: string; onApply: () => void;
}) {
  if (!suggestion) return null;
  // Once it has been applied (or typed), there is nothing left to suggest.
  if (current.trim().toLowerCase() === suggestion.toLowerCase()) return null;
  return (
    <button className="btn" onClick={onApply} type="button"
      title={`Replace "${current}" with "${suggestion}"`}
      style={{ marginTop: 4, padding: "2px 8px", fontSize: 11, borderColor: "var(--warn)" }}>
      Did you mean <strong style={{ marginLeft: 3 }}>{suggestion}</strong>?
    </button>
  );
}
