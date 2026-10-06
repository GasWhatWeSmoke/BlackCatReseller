"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { RotateCw, EyeOff, Eye, Star, ArrowLeft, Maximize2, GripVertical, Save, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  WHEN_MADE_OPTIONS, COLOR_OPTIONS, PATTERN_OPTIONS, DEPARTMENT_OPTIONS, SIZE_OPTIONS,
  MATERIAL_OPTIONS, STYLE_OPTIONS, CONDITION_OPTIONS, ETSY_ELIGIBLE_OPTIONS, FIT_OPTIONS,
  CATEGORY_OPTIONS, VINTAGE_WHEN_MADE_DEFAULT, normalizeWhenMade,
} from "@/lib/listingOptions";
import {
  needsInseam, isVintage, buildTitle, buildDescription, assessTitle,
  isDescriptionWeak, sanitizeDescription, desalesify, marketingHits, measurementsFor, itemCategory,
  stripBrandFromModel,
} from "@/lib/listing";
import { previewListingItem } from "@/lib/listingPreview";
import { describePackage } from '@/lib/packageDetails';
import { PackageDetailsNote } from '@/components/PackageDetailsNote';
import { PromptDialog, type PromptSpec } from "@/components/PromptDialog";
import { withExpectedItemValues } from "@/lib/itemEdits";
import { itemDeleteExpectation, itemDeleteReceiptMatches } from '@/lib/itemDeleteSelection';
import { useItemDraft } from "@/components/useItemDraft";
import { DraftRecovery } from "@/components/DraftRecovery";
import { PhotoImage } from "@/components/PhotoImage";
import { PhotoViewer } from "@/components/PhotoViewer";
import { useVocabulary, VocabularyNotice } from '@/components/useVocabulary';
import styles from "./Editor.module.css";
import type { DraftItem, DraftValue } from "@/lib/itemDrafts";
import { DEFAULT_INVENTORY_QUERY, inventoryBackHref, inventoryItemHref, inventoryQueryString, parseInventoryQuery, type InventoryQuery } from "@/lib/inventoryQuery";

interface Photo {
  id: number; storedPath: string; thumbPath: string | null; rotation: number;
  isCover: boolean; isMarker: boolean; includeInListing: boolean; sortOrder: number;
}
interface Item {
  createdAt: string;
  updatedAt: string;
  id: number; sku: string; status: string; displayStatus?: string; niftyStatus: string; brand: string;
  size: string | null; itemType: string | null; category: string | null; color: string | null;
  pattern: string | null; aiFields: string | null; aiRaw: string | null; weightOz: number | null; whenMade: string | null;
  department: string | null; material: string | null; style: string | null; secondaryColor: string | null;
  condition: string | null; etsyEligible: string | null; trueVintage: boolean; inseam: string | null;
  fit: string | null; description: string | null; customTitle: string | null; model: string | null;
  tertiaryColor: string | null; closure: string | null; neckline: string | null; lining: string | null;
  graphics: string | null; keyDetails: string | null; aesthetic: string | null;
  chestIn: string | null; lengthIn: string | null; sleeveIn: string | null; shoulderIn: string | null;
  waistIn: string | null; hipIn: string | null; riseIn: string | null;
  notes: string | null; listedPrice: number | null; itemCost: number | null; salePrice: number | null; photoCount: number; photos: Photo[];
  // v1.2 batch-reliability fields
  isShell: boolean; groupingConfidence: string | null; groupingLogJson: string | null; aiConfidence: number | null;
  flagged: boolean;
}

interface GroupingReport {
  confidence?: string; reasons?: string[]; closedBy?: string; orderSource?: string;
  log?: { file: string; role: string; time: string | null; gapBeforeSec: number | null; decode: string | null; raw: string | null }[];
}

function thumbSrc(p: Photo) {
  return `/api/thumb?path=${encodeURIComponent(p.thumbPath ?? p.storedPath)}&full=${encodeURIComponent(p.storedPath)}`;
}

export default function ItemDetail() {
  const { id: routeId } = useParams<{ id: string }>();
  const id = Number.isSafeInteger(Number(routeId)) && Number(routeId) > 0 ? String(Number(routeId)) : routeId;
  const activeItemId = useRef(id); activeItemId.current = id;
  const photoBusyRef = useRef(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const router = useRouter();
  const [item, setItem] = useState<Item | null>(null);
  const [listing, setListing] = useState<Photo[]>([]);   // non-marker, in display order
  const [marker, setMarker] = useState<Photo | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<Photo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const [listQuery, setListQuery] = useState<InventoryQuery>({ ...DEFAULT_INVENTORY_QUERY });
  const [contextReady, setContextReady] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Item>>({});
  const [draftRefresh, setDraftRefresh] = useState(0);
  const recovery = useItemDraft("editor", item as unknown as DraftItem | null,
    changes => setForm(previous => ({ ...previous, ...changes })), draftRefresh);
  const vocabulary = useVocabulary(), vocab = vocabulary.vocab;
  const refreshVocab = vocabulary.refresh, learnVocab = vocabulary.learn;
  const [savingDetails, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const flaggingRef = useRef(false);
  const deletingRef = useRef(false), deleteMounted = useRef(true);
  const deletedIdentity = useRef<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const itemDeleted = !!item && deletedIdentity.current === `${item.id}:${item.createdAt}`;
  const saving = savingDetails || deleting || itemDeleted || flagging;
  useEffect(() => { deleteMounted.current = true; return () => { deleteMounted.current = false; }; }, []);
  useEffect(() => {
    if (!deleting) return;
    const unload = (event: BeforeUnloadEvent) => { if (!deletedIdentity.current) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => { if (!deletedIdentity.current && (event.target as Element)?.closest?.('a[href]')) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [deleting]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nav, setNav] = useState<{ prev: number | null; next: number | null; index: number; total: number; matches: boolean } | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [navAttempt, setNavAttempt] = useState(0);
  // Batch-recovery photo selection (split / move between items).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    try {
      const context = new URLSearchParams(window.location.search).get("from") ?? "";
      setListQuery(parseInventoryQuery(new URLSearchParams(context))); setContextError(null);
    } catch { setListQuery({ ...DEFAULT_INVENTORY_QUERY }); setContextError("The inventory filters in this link could not be restored. Return to Inventory to choose a view."); }
    setContextReady(true);
  }, [id]);
  const contextKey = inventoryQueryString(listQuery);
  const returnQuery = nav && nav.index >= 0 ? { ...listQuery, page: Math.floor(nav.index / listQuery.pageSize) + 1 } : listQuery;
  const backHref = inventoryBackHref(returnQuery);

  const load = useCallback(async () => {
    void refreshVocab(false);
    const version = ++loadVersion.current;
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoadError(null); setNotFound(false);
    try {
    const r = await fetch(`/api/items/${id}`, { signal: controller.signal });
    if (activeItemId.current !== id || version !== loadVersion.current || controller.signal.aborted) return;
    if (r.status === 404) { setNotFound(true); return; }
    if (!r.ok) throw new Error("Item details could not be loaded. Your local draft is kept; retry loading the item.");
    const { item } = await r.json();
    if (activeItemId.current !== id || version !== loadVersion.current || controller.signal.aborted) return;
    if (!item || item.id !== Number(id) || !Array.isArray(item.photos)) throw new Error("The saved item details could not be verified.");
    setNotFound(false);
    setDeleteError(null);
    setItem(item);
    setForm({
      brand: item.brand, size: item.size, itemType: item.itemType, category: item.category, color: item.color,
      pattern: item.pattern, listedPrice: item.listedPrice, itemCost: item.itemCost, weightOz: item.weightOz,
      whenMade: normalizeWhenMade(item.whenMade), notes: item.notes,
      department: item.department, material: item.material, style: item.style,
      secondaryColor: item.secondaryColor, condition: item.condition,
      etsyEligible: item.etsyEligible ?? "none", trueVintage: !!item.trueVintage, inseam: item.inseam,
      fit: item.fit, description: item.description, customTitle: item.customTitle,
      // Not edited here directly, but a brand correction scrubs the old brand out of it
      // (see setBrand), and the scrubbed value has to reach the PATCH.
      model: item.model,
      tertiaryColor: item.tertiaryColor, closure: item.closure, neckline: item.neckline, lining: item.lining,
      graphics: item.graphics, keyDetails: item.keyDetails, aesthetic: item.aesthetic,
      chestIn: item.chestIn, lengthIn: item.lengthIn, sleeveIn: item.sleeveIn, shoulderIn: item.shoulderIn,
      waistIn: item.waistIn, hipIn: item.hipIn, riseIn: item.riseIn,
    });
    setDraftRefresh(value => value + 1);
    setMarker(item.photos.find((p: Photo) => p.isMarker) ?? null);
    setListing(item.photos.filter((p: Photo) => !p.isMarker).sort((a: Photo, b: Photo) => a.sortOrder - b.sortOrder));
    } catch (error) {
      if (activeItemId.current === id && version === loadVersion.current && !controller.signal.aborted)
        setLoadError(error instanceof Error ? error.message : "Item details could not be loaded.");
    }
  }, [id, refreshVocab]);
  useEffect(() => { void load(); return () => loadController.current?.abort(); }, [load]);

  // Previous/next item ids (same order as the inventory grid) for flip-through nav.
  useEffect(() => {
    setNav(null); setNavError(null);
    if (!contextReady || contextError || !item || item.id !== Number(id)) return;
    const controller = new AbortController();
    fetch(`/api/items/${id}/neighbors?${contextKey}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok || !Number.isInteger(result.index) || !Number.isSafeInteger(result.total)) throw new Error(result.error || "Previous and next items could not be loaded.");
        return result;
      }).then(value => { if (!controller.signal.aborted) setNav(value); })
      .catch(error => { if (!controller.signal.aborted) setNavError(error instanceof Error ? error.message : "Item navigation could not be loaded."); });
    return () => controller.abort();
  }, [id, contextKey, contextReady, contextError, item?.updatedAt, item?.flagged, navAttempt]);

  const goPrev = useCallback(() => { if (!deletingRef.current && recovery.canLeave && nav?.prev != null) router.push(inventoryItemHref(nav.prev, { ...listQuery, page: Math.floor((nav.index - 1) / listQuery.pageSize) + 1 })); }, [nav, router, recovery.canLeave, listQuery]);
  const goNext = useCallback(() => { if (!deletingRef.current && recovery.canLeave && nav?.next != null) router.push(inventoryItemHref(nav.next, { ...listQuery, page: Math.floor((nav.index + 1) / listQuery.pageSize) + 1 })); }, [nav, router, recovery.canLeave, listQuery]);

  // ←/→ flip between items, but only when not typing in a field or viewing the lightbox.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement)?.isContentEditable) return;
      if (lightbox) return;
      if (e.key === "ArrowLeft") goPrev();
      else goNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, lightbox]);

  const setField = (k: keyof Item, v: unknown) => {
    if (!recovery.ready || recovery.discarding || saving) return;
    if (!recovery.change({ [k]: v as DraftValue })) return;
    setForm(f => ({ ...f, [k]: v }));
  };
  // Same rule as Review: the vision model folds the brand into the model ("Wrangler
  // 2000"), so correcting the brand scrubs the old name out of the model, or it would
  // keep appearing in the title with no visible source.
  const setBrand = (v: string) => {
    if (!recovery.ready || recovery.discarding || saving) return;
    const changes = { brand: v, model: stripBrandFromModel(form.model, form.brand) || null };
    if (!recovery.change(changes)) return;
    setForm(f => ({ ...f, ...changes }));
  };

  // Live listing-copy preview from the editable form (rich detail is now in editable
  // columns; fall back to the AI's raw JSON for older items). Lets the operator SEE the
  // generated title/description and its quality before exporting.
  const previewItem = useMemo(
    () => previewListingItem(item as unknown as Record<string, unknown> | null,
                             form as Record<string, unknown>),
    [form, item],
  );
  const titlePreview = useMemo(() => buildTitle(previewItem), [previewItem]);
  // The title that will actually be exported: the operator's override when set, else auto.
  const effectiveTitle = useMemo(
    () => (form.customTitle ?? "").trim() || titlePreview,
    [form.customTitle, titlePreview],
  );
  const titleCheck = useMemo(() => assessTitle(effectiveTitle), [effectiveTitle]);
  const genDesc = useMemo(() => buildDescription(previewItem), [previewItem]);
  // Mirror the export's source selection: heavily-salesy copy (>=2 markers) is rebuilt from
  // the structured fields; mild/clean copy is de-hyped and used if still strong; otherwise
  // the deterministic factual build.
  const descPreview = useMemo(() => {
    const raw = sanitizeDescription(form.description);
    const cleaned = desalesify(raw);
    if (marketingHits(raw).length >= 2 && !isDescriptionWeak(genDesc)) return genDesc;
    if (form.description && !isDescriptionWeak(cleaned)) return cleaned;
    return genDesc;
  }, [form.description, genDesc]);

  const saveDetails = useCallback(async () => {
    if (!item || saving || photoBusyRef.current || !recovery.canSave) return;
    setSaving(true); setSaveError(null);
    const sku = item.sku;
    // Re-export only for PRE-UPLOAD items so editing keeps item.json/copy in sync and a
    // now-complete item auto-lists (§25.1). Never disturb something already on Nifty —
    // re-export resets niftyStatus, so gate it on niftyStatus === "Not Uploaded".
    const preUpload = ["Photographed", "Needs Info", "Ready", "Ready for Nifty"].includes(item.status)
      && (item.niftyStatus ?? "Not Uploaded") === "Not Uploaded";
    try {
      const draftToken = await recovery.prepareSave();
      const r = await fetch(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify(withExpectedItemValues(draftToken.expected, form)) });
      // Stale-price tripwire: repricing an already-uploaded item does NOT change the
      // live Nifty listing — surface the server's warning loudly.
      const pj = await r.json().catch(() => null);
      if (!r.ok || !pj?.item) throw new Error(pj?.error || "Could not confirm saved changes");
      await recovery.saved(draftToken, pj.item as DraftItem);
      void learnVocab(pj.item, ['size', 'itemType', 'color', 'brand']);
      if (pj?.priceWarning) toast.warning(`${sku}: ${pj.priceWarning}`, { duration: 12000 });
      // Re-run the export (server re-validates the gate; a fail is a harmless no-op).
      let listed = false;
      if (preUpload) {
        try {
          const ej = await fetch(`/api/items/${item.id}/ready`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedUpdatedAt: pj?.item?.updatedAt }) }).then((x) => x.json());
          if (ej?.ok) {
            listed = true;
            if (ej.copyWarnings?.length) toast.warning(`${sku}: ${ej.copyWarnings.join("; ")} — review listing copy`, { duration: 8000 });
          }
        } catch { /* leave status unchanged on export error */ }
      }
      toast.success(listed ? `Saved ${sku} → Ready to upload` : `Saved ${sku}`);
      if (activeItemId.current === String(item.id)) void load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save changes";
      setSaveError(message);
      toast.error(message, { duration: 12000 });
    } finally {
      setSaving(false);
    }
  }, [item, form, saving, learnVocab, load, recovery]);

  // Delete this whole item (photos + working files; /archive originals are kept).
  // A SOLD item is earnings history: deleting it erases that sale from the Earnings
  // tab forever, so it gets a spell-it-out confirm and an explicit force flag —
  // this is the only path that can clear a sale (bulk deletes always keep sold items).
  const deleteThisItem = useCallback(async () => {
    if (!item || deletingRef.current || deletedIdentity.current === `${item.id}:${item.createdAt}` || saving || photoBusyRef.current || deleteError || !recovery.canLeave || activeItemId.current !== String(item.id)) return;
    let expected;
    try { expected = itemDeleteExpectation(item); }
    catch { setDeleteError('Reload the item before confirming deletion.'); return; }
    const sold = item.status === "Sold" || item.salePrice != null;
    if (sold) {
      if (!confirm(
        `${item.sku} has SOLD${item.salePrice != null ? ` for $${item.salePrice.toFixed(2)}` : ""}.\n\n` +
        `Deleting it PERMANENTLY ERASES this sale from your earnings history — totals, profit and ` +
        `per-platform stats will no longer include it. The photos' /archive originals are kept.\n\n` +
        `Really erase this sold item and its earnings record?`,
      )) return;
    } else if (!confirm(`Delete item ${item.sku}? This removes it and its photos (originals stay in /archive).`)) {
      return;
    }
    deletedIdentity.current = null; deletingRef.current = true; setDeleting(true);
    const version = loadVersion.current;
    try {
      const r = await fetch(`/api/items/${item.id}${sold ? "?force=1" : ""}`, { method: "DELETE", headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected }) });
      const result = await r.json().catch(() => null);
      if (!r.ok || !itemDeleteReceiptMatches(result, expected)) throw Error(result?.error || 'Deletion could not be confirmed. Reload the item before another action.');
      deletedIdentity.current = `${item.id}:${item.createdAt}`;
      if (result?.cleanupWarnings?.length) toast.warning(`Item ${item.sku} deleted`, { description: result.cleanupWarnings.join(" "), duration: 12000 });
      else toast.success(`Item ${item.sku} deleted`);
      if (deleteMounted.current && activeItemId.current === String(item.id) && loadVersion.current === version) router.push(backHref);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deletion could not be confirmed. Reload before trying again.';
      toast.error(`${item.sku}: ${message}`);
      if (deleteMounted.current && activeItemId.current === String(item.id) && loadVersion.current === version) setDeleteError(message);
    } finally {
      deletingRef.current = false; if (deleteMounted.current) setDeleting(false);
    }
  }, [item, router, backHref, saving, deleteError, recovery.canLeave]);

  // Flag = "come back to this one" (badge everywhere + Inventory's flagged filter).
  const toggleFlag = useCallback(async () => {
    if (!item || saving || flaggingRef.current || photoBusyRef.current || deletingRef.current) return;
    flaggingRef.current = true; setFlagging(true);
    const next = !item.flagged;
    const sameItem = (row: Item | null) => row?.id === item.id && row.createdAt === item.createdAt;
    setItem((prev) => (sameItem(prev) ? { ...prev!, flagged: next } : prev));
    try {
      const r = await fetch(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify(withExpectedItemValues({ createdAt: item.createdAt, status: item.status, flagged: item.flagged }, { flagged: next })) });
      const result = await r.json().catch(() => null);
      if (!r.ok || result?.item?.id !== item.id || result.item.createdAt !== item.createdAt || result.item.flagged !== next
        || typeof result.item.updatedAt !== 'string' || !Number.isFinite(Date.parse(result.item.updatedAt)))
        throw Error(result?.error || 'Could not confirm the flag. Reload before trying again.');
      // Advance the reviewed version only when the other saved scalar values match
      // what is on screen. A background edit must still require fresh review.
      const sameValues = Object.entries(item).every(([key, value]) => ['flagged', 'updatedAt'].includes(key)
        || value !== null && typeof value === 'object' || result.item[key] === value);
      if (sameValues && result.previousUpdatedAt === item.updatedAt)
        setItem(prev => sameItem(prev) && prev!.updatedAt === item.updatedAt ? { ...prev!, updatedAt: result.item.updatedAt } : prev);
      toast.success(next ? `${item.sku} flagged — see Inventory → Flagged` : `${item.sku} unflagged`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not confirm the flag. Reload before trying again.');
      setItem(prev => sameItem(prev) ? { ...prev!, flagged: item.flagged } : prev);
    } finally {
      flaggingRef.current = false; if (deleteMounted.current) setFlagging(false);
    }
  }, [item, saving]);

  // ---- Batch-recovery tools (v1.2): rename SKU, split, move photos ------------
  // All three ask for a SKU via the in-app PromptDialog — window.prompt() THROWS in
  // Electron (never implemented), which made these buttons look completely dead.
  const [dialog, setDialog] = useState<PromptSpec | null>(null);

  const renameSku = useCallback(() => {
    if (!item) return;
    setDialog({
      title: `Rename ${item.sku}`,
      message: "Renumber this item, or give a FIX-xxxx shell its real sticker number.",
      defaultValue: item.sku.startsWith("FIX-") ? "" : item.sku,
      placeholder: "e.g. 000048",
      actionLabel: "Rename",
      onSubmit: async (v) => {
        if (v === item.sku) return null;
        const r = await fetch(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify(withExpectedItemValues({ createdAt: item.createdAt, sku: item.sku, status: item.status }, { sku: v })) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return j.error || "Could not rename SKU";
        toast.success(`SKU: ${item.sku} → ${j.item.sku}`);
        load();
        return null;
      },
    });
  }, [item, load]);

  const toggleSelect = useCallback((photoId: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(photoId)) n.delete(photoId); else n.add(photoId);
      return n;
    });
  }, []);

  const applyPhotoState = useCallback((owner: { id: number; photos: Photo[]; photoCount: number }) => {
    if (activeItemId.current !== String(owner.id)) return;
    setListing(owner.photos.filter(p => !p.isMarker).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id));
    setMarker(owner.photos.find(p => p.isMarker) ?? null);
    const present = new Set(owner.photos.map(p => p.id));
    setSelected(previous => new Set([...previous].filter(id => present.has(id))));
    // Keep unsaved form fields and their saved baseline intact.
    setItem(previous => previous?.id === owner.id ? { ...previous, photos: owner.photos, photoCount: owner.photoCount } : previous);
  }, []);

  const splitSelected = useCallback(() => {
    if (!item || selected.size === 0 || saving || photoBusyRef.current || String(item.id) !== id) return;
    setDialog({
      title: `Split ${selected.size} photo(s) into a NEW item`,
      message: `The selected photos leave ${item.sku} and become a brand-new item — enter its SKU ` +
        `(usually the missing sticker number). To add photos to an item that already exists, ` +
        `cancel and use "Move to item…" instead.`,
      placeholder: "e.g. 000078",
      actionLabel: "Split",
      onSubmit: async (v) => {
        const r = await fetch(`/api/items/${item.id}/split`, {
          method: "POST",
          body: JSON.stringify({ photoIds: [...selected], newSku: v }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) return j.error || "Split failed";
        toast.success(`Created ${v} with ${j.moved} photo(s)`);
        setSelected(new Set()); setSelecting(false);
        const owner = j.items?.find((value: { id: number }) => value.id === item.id);
        if (owner && Array.isArray(owner.photos)) applyPhotoState(owner);
        return null;
      },
    });
  }, [item, selected, applyPhotoState, saving, id]);

  const moveSelected = useCallback(() => {
    if (!item || selected.size === 0 || saving || photoBusyRef.current || String(item.id) !== id) return;
    setDialog({
      title: `Move ${selected.size} photo(s) to an existing item`,
      message: `The selected photos leave ${item.sku} and join an item that ALREADY exists. Enter its SKU.`,
      placeholder: "e.g. 000070",
      actionLabel: "Move",
      onSubmit: async (v) => {
        const r = await fetch(`/api/items/${item.id}/move-photos`, {
          method: "POST",
          body: JSON.stringify({ photoIds: [...selected], targetSku: v }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) return j.error || "Move failed";
        toast.success(`Moved ${j.moved} photo(s) to ${j.target.sku}`);
        setSelected(new Set()); setSelecting(false);
        const owner = j.items?.find((value: { id: number }) => value.id === item.id);
        if (owner && Array.isArray(owner.photos)) applyPhotoState(owner);
        return null;
      },
    });
  }, [item, selected, applyPhotoState, saving, id]);



  async function savePhotoChange(photo: Photo, patch: Record<string, unknown>): Promise<boolean> {
    if (!item || saving || photoBusyRef.current || String(item.id) !== id) return false;
    const ownerId = item.id;
    photoBusyRef.current = true; setPhotoBusy(true);
    try {
      const response = await fetch(`/api/photos/${photo.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, expectedItemId: ownerId }) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "Photo change could not be confirmed.");
      const owner = result.items?.find((value: { id: number }) => value.id === ownerId);
      if (!owner || !Array.isArray(owner.photos)) throw new Error("Photo change could not be confirmed. Reload the current photos.");
      applyPhotoState(owner);
      return activeItemId.current === String(ownerId);
    } catch (error) {
      if (activeItemId.current === String(ownerId)) toast.error(error instanceof Error ? error.message : "Photo change could not be confirmed.");
      try {
        const response = await fetch(`/api/items/${ownerId}`);
        if (response.ok) { const value = await response.json(); if (value.item?.id === ownerId) applyPhotoState(value.item); }
      } catch { /* Keep the last known photo state and the visible error. */ }
      return false;
    } finally { photoBusyRef.current = false; setPhotoBusy(false); }
  }

  // Save the whole order atomically, bound to the order the operator reviewed.
  async function persistOrder(next: Photo[]) {
    if (!next.length || next.every((p, index) => p.id === listing[index]?.id)) return;
    if (await savePhotoChange(next[0], { photoOrder: next.map(p => p.id), expectedOrder: listing.map(p => p.id) }))
      toast.success("Photo order saved");
  }

  function onDrop(targetId: number) {
    setOverId(null);
    if (dragId == null || dragId === targetId) { setDragId(null); return; }
    const arr = [...listing];
    const from = arr.findIndex((p) => p.id === dragId);
    const to = arr.findIndex((p) => p.id === targetId);
    if (from < 0 || to < 0) { setDragId(null); return; }
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    setDragId(null);
    void persistOrder(arr);
  }

  // Show confirmed photo metadata; failed saves never masquerade as success.
  async function photoOp(photo: Photo, patch: Record<string, unknown>) {
    await savePhotoChange(photo, patch);
  }

  function moveBy(photo: Photo, delta: number) {
    const arr = [...listing];
    const from = arr.findIndex((p) => p.id === photo.id);
    const to = from + delta;
    if (to < 0 || to >= arr.length) return;
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    void persistOrder(arr);
  }

  if (loadError) return <div role="alert" className="card" style={{ padding: 24 }}>{loadError} <button className="btn" onClick={() => void load()}>Retry loading item</button> <Link href={backHref}>Back to inventory</Link></div>;
  if (notFound) return <NotFound />;
  if (!item || String(item.id) !== id) return <p className="muted">Loading…</p>;

  const summary = [item.color, item.pattern, item.itemType, item.size, item.brand !== "Unknown" ? item.brand : null].filter(Boolean).join(" · ") || "no details yet";
  const viewerPhotos = [...listing, ...(marker ? [marker] : [])];
  let aiList: string[] = [];
  try { aiList = item.aiFields ? JSON.parse(item.aiFields) : []; } catch { aiList = []; }
  let grouping: GroupingReport | null = null;
  try { grouping = item.groupingLogJson ? JSON.parse(item.groupingLogJson) : null; } catch { grouping = null; }

  return (
    <div className={styles.workspace}>
      <VocabularyNotice state={vocabulary} />
      {/* Top nav: back to grid + flip to the previous/next item (←/→ keys too). */}
      <div className={styles.navigation}>
        <Link href={backHref} className="btn"><ArrowLeft size={16} /> Inventory</Link>
        <div className={styles.actions}>
          {nav && nav.total > 0 && nav.index >= 0 && (
            <span className="muted" style={{ fontSize: 13 }}>{nav.index + 1} / {nav.total}</span>
          )}
          <button className="btn" onClick={goPrev} disabled={!nav?.prev || !recovery.canLeave} title="Previous item (←)" data-sound="none">
            <ChevronLeft size={16} /> Prev
          </button>
          <button className="btn" onClick={goNext} disabled={!nav?.next || !recovery.canLeave} title="Next item (→)" data-sound="none">
            Next <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {contextError && <p role="alert" style={{ color: "var(--warn)" }}>{contextError}</p>}
      {navError && <p role="alert" style={{ color: "var(--warn)" }}>{navError} <button className="btn" onClick={() => setNavAttempt(value => value + 1)}>Retry item navigation</button></p>}
      {nav?.matches === false && <p className="muted">This item no longer matches the inventory filters you opened it from. Back to Inventory keeps that view.</p>}

      <div className={styles.heading}>
        <div className={styles.identity}>
          <h1>
            {item.sku}
            <button className="btn" onClick={renameSku} disabled={saving || photoBusy} data-sound="none" title="Rename / renumber this item's SKU"
              style={{ fontSize: 12, padding: "3px 9px" }}>
              Edit SKU
            </button>
            {item.isShell && (
              <span className="chip" style={{ fontSize: 12, background: "var(--panel-2)", color: "var(--warn)" }}
                title="Created because a SKU sticker was unreadable or missing — set its real number with Edit SKU.">
                unrecognized sticker
              </span>
            )}
          </h1>
          <div className="muted" style={{ marginTop: 4 }}>{summary}</div>
        </div>
        <div className={styles.status}>
          {item.groupingConfidence && item.groupingConfidence !== "high" && (
            <span className="chip"
              title={(grouping?.reasons ?? []).join("\n") || "Check that these photos are one item"}
              style={{ background: "var(--panel-2)", color: item.groupingConfidence === "low" ? "var(--warn)" : undefined }}>
              {item.groupingConfidence === "low" ? "⚠ grouping uncertain" : "grouping: double-check"}
            </span>
          )}
          {item.aiConfidence != null && item.aiConfidence < 0.55 && (
            <span className="chip" title={`The vision model was unsure about this garment (confidence ${Math.round(item.aiConfidence * 100)}%) — double-check its fields.`}
              style={{ background: "var(--panel-2)" }}>AI unsure</span>
          )}
          {aiList.length > 0 && (
            <span className="chip" title={"AI-filled, confirm in Review: " + aiList.join(", ")} style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>AI · {aiList.length}</span>
          )}
          <span className="chip">{item.displayStatus || (item.status === "Ready for Nifty" ? "Ready" : item.status)}</span>
        </div>
      </div>

      {/* Why-these-photos-grouped report (from the worker's per-item audit log). */}
      {grouping && (grouping.reasons?.length || grouping.log?.length) ? (
        <details className="card" style={{ padding: "10px 14px", margin: "10px 0 0", fontSize: 13 }}>
          <summary style={{ cursor: "pointer" }}>
            Grouping report — {grouping.confidence ?? "?"} confidence
            {grouping.reasons?.length ? ` · ${grouping.reasons.length} note(s)` : ""}
            {grouping.orderSource && grouping.orderSource !== "exif" ? ` · ordered by ${grouping.orderSource}` : ""}
          </summary>
          {(grouping.reasons ?? []).map((r, i) => (
            <div key={i} style={{ color: "var(--warn)", margin: "8px 0 0" }}>⚠ {r}</div>
          ))}
          {grouping.log?.length ? (
            <div className={styles.tableScroll} role="region" aria-label="Photo grouping details" tabIndex={0}
              onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight')event.stopPropagation();}}><table>
              <thead>
                <tr className="muted" style={{ textAlign: "left" }}>
                  <th style={{ padding: "3px 8px 3px 0" }}>Photo</th><th>Role</th><th>Taken</th><th>Gap before</th><th>Decode</th>
                </tr>
              </thead>
              <tbody>
                {grouping.log.map((e, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "3px 8px 3px 0" }}>{e.file}</td>
                    <td>{e.role}</td>
                    <td className="muted">{e.time ?? "—"}</td>
                    <td className="muted">{e.gapBeforeSec != null ? `${e.gapBeforeSec}s` : "—"}</td>
                    <td className="muted">{e.decode ?? "—"}{e.raw ? ` (${e.raw})` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : null}
        </details>
      ) : null}

      {/* Editable item details — saves back to the DB any time (not just in Review). */}
      <div className={`card ${styles.details}`}>
        <div className={styles.sectionHeading}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Item details</h2>
          <div className={styles.actions}>
            <button className="btn" onClick={toggleFlag} disabled={saving || photoBusy}
              title={item.flagged ? "Remove the flag" : "Flag to come back later (shows under Inventory → Flagged)"}
              style={item.flagged ? { borderColor: "var(--warn)", color: "var(--warn)" } : undefined}>
              🚩 {item.flagged ? "Unflag" : "Flag"}
            </button>
            <button className="btn btn-danger" onClick={deleteThisItem} title="Delete this item" disabled={saving || photoBusy || !recovery.canLeave || !!deleteError}>
              <Trash2 size={15} /> {itemDeleted ? 'Deleted' : deleting ? 'Deleting…' : 'Delete item'}
            </button>
            <button className="btn btn-primary" data-sound="save" onClick={saveDetails} disabled={saving || photoBusy || !recovery.canSave}>
              <Save size={15} /> {savingDetails ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 14px" }}>
          Review the shared details here. Black Cat maps them to each marketplace when it posts.
        </p>
        {saveError && <p role="alert" style={{ color: "var(--warn)", fontSize: 13 }}>{saveError} Your edits remain in this form.</p>}
        {deleteError && <p role="alert" style={{ color: 'var(--warn)' }}>{deleteError} <button className="btn" disabled={saving || !recovery.canLeave} onClick={() => void load()}>Reload item before deleting</button></p>}
        <DraftRecovery recovery={recovery} item={item as unknown as DraftItem} disabled={saving} />
        <fieldset className={styles.fields} disabled={saving || !recovery.ready || recovery.discarding}>
          {/* Free-text (with suggestions) — Nifty allows custom values here. */}
          <Field label="Brand"><VocabInput value={form.brand ?? ""} list={vocab.brand} onChange={setBrand} /></Field>
          <Field label="Item Type"><VocabInput value={form.itemType ?? ""} list={vocab.itemType} onChange={(v) => setField("itemType", v)} /></Field>
          <Field label="Category">
            <select className="select" value={form.category ?? itemCategory(form.category ?? null, form.itemType ?? null)}
              onChange={(e) => setField("category", e.target.value)}>
              {CATEGORY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          {/* Strict dropdowns — fixed Nifty lists, value must be exactly one of these. */}
          <Field label="Color"><SelectInput value={form.color ?? ""} options={COLOR_OPTIONS} onChange={(v) => setField("color", v)} /></Field>
          <Field label="Secondary Color"><SelectInput value={form.secondaryColor ?? ""} options={COLOR_OPTIONS} onChange={(v) => setField("secondaryColor", v)} /></Field>
          <Field label="Condition"><SelectInput value={form.condition ?? ""} options={CONDITION_OPTIONS} onChange={(v) => setField("condition", v)} /></Field>
          <Field label="True Vintage (20+ yrs)">
            <span style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, minHeight: 38 }}>
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
              List on Etsy as vintage
            </span>
          </Field>
          <Field label="When Made (Etsy)">
            <SelectInput value={form.whenMade ?? ""} options={WHEN_MADE_OPTIONS} onChange={(v) => setField("whenMade", v)} />
            {form.trueVintage && !isVintage(form.whenMade) && (
              <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 4 }}>
                ⚠ Pick a 20+ year era (export will use “{VINTAGE_WHEN_MADE_DEFAULT}”).
              </div>
            )}
          </Field>
          <Field label="Etsy category (handmade / supply)">
            <select className="select" value={form.etsyEligible ?? "none"} onChange={(e) => setField("etsyEligible", e.target.value)}>
              {ETSY_ELIGIBLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {/* Category-dependent / long Nifty dropdowns — free-text + suggestion list
              (Nifty's options vary by category and allow custom-add). */}
          <Field label="Size"><VocabInput value={form.size ?? ""} list={SIZE_OPTIONS} onChange={(v) => setField("size", v)} /></Field>
          {needsInseam(form.itemType ?? null) && (
            <Field label="Inseam (in) — eBay">
              <input className="input" type="number" step="0.5" min="0" placeholder="e.g. 32"
                value={form.inseam ?? ""} onChange={(e) => setField("inseam", e.target.value)} />
            </Field>
          )}
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Measurements (inches, laid flat — added to the description)" group>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {measurementsFor(form.itemType ?? null, form.category ?? null).map((m) => (
                  <label key={m.key} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
                    <span className="muted">{m.label}</span>
                    <input className="input" style={{ width: 96 }} type="number" step="0.5" min="0"
                      value={(form[m.key as keyof Item] as string | null) ?? ""}
                      onChange={(e) => setField(m.key as keyof Item, e.target.value)} />
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <Field label="Department"><VocabInput value={form.department ?? ""} list={DEPARTMENT_OPTIONS} onChange={(v) => setField("department", v)} /></Field>
          <Field label="Pattern"><VocabInput value={form.pattern ?? ""} list={PATTERN_OPTIONS} onChange={(v) => setField("pattern", v)} /></Field>
          <Field label="Material"><VocabInput value={form.material ?? ""} list={MATERIAL_OPTIONS} onChange={(v) => setField("material", v)} /></Field>
          <Field label="Style"><VocabInput value={form.style ?? ""} list={STYLE_OPTIONS} onChange={(v) => setField("style", v)} /></Field>
          <Field label="Fit"><VocabInput value={form.fit ?? ""} list={FIT_OPTIONS} onChange={(v) => setField("fit", v)} /></Field>
          <Field label="Tertiary Color"><SelectInput value={form.tertiaryColor ?? ""} options={COLOR_OPTIONS} onChange={(v) => setField("tertiaryColor", v)} /></Field>
          <Field label="Closure"><input className="input" value={form.closure ?? ""} placeholder="e.g. Full Zip" onChange={(e) => setField("closure", e.target.value)} /></Field>
          <Field label="Neckline / Collar"><input className="input" value={form.neckline ?? ""} placeholder="e.g. Ribbed Collar" onChange={(e) => setField("neckline", e.target.value)} /></Field>
          <Field label="Lining"><input className="input" value={form.lining ?? ""} placeholder="e.g. Quilted" onChange={(e) => setField("lining", e.target.value)} /></Field>
          <Field label="Price ($)">
            <input className="input" type="number" step="0.01" min="0" value={form.listedPrice ?? ""} onChange={(e) => setField("listedPrice", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Item cost ($) — what you paid (for Earnings)">
            <input className="input" type="number" step="0.01" min="0" placeholder="optional" value={form.itemCost ?? ""} onChange={(e) => setField("itemCost", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Ship Weight (oz)">
            <input className="input" type="number" step="1" min="0" value={form.weightOz ?? ""} onChange={(e) => setField("weightOz", e.target.value === "" ? null : Number(e.target.value))} />
            <PackageDetailsNote details={describePackage({ itemType: form.itemType, weightOz: form.weightOz })} />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Graphics / patches — one per line (feeds the description)">
              <textarea className="input" rows={3} placeholder={"embroidered fox mascot\n'No Ruls 1980' patch\npalm tree back print"}
                value={form.graphics ?? ""} onChange={(e) => setField("graphics", e.target.value)} />
            </Field>
          </div>
          <div className={styles.pair}>
            <Field label="Key details — one per line (title keywords)">
              <textarea className="input" rows={2} placeholder={"Patches\nEmbroidered"}
                value={form.keyDetails ?? ""} onChange={(e) => setField("keyDetails", e.target.value)} />
            </Field>
            <Field label="Aesthetic tags — one per line">
              <textarea className="input" rows={2} placeholder={"vintage racing\nstreetwear"}
                value={form.aesthetic ?? ""} onChange={(e) => setField("aesthetic", e.target.value)} />
            </Field>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label={form.customTitle?.trim() ? "Listing Title (custom — used on the next upload)" : "Listing Title (auto-generated — press Edit title to change it)"}>
              <input
                className="input" maxLength={80}
                value={form.customTitle ?? ""}
                placeholder={titlePreview || "auto-generated from the fields above"}
                onChange={(e) => setField("customTitle", e.target.value)}
                style={{ width: "100%", fontWeight: 600, borderColor: form.customTitle?.trim() ? "var(--accent)" : undefined }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap:"wrap", gap:8, marginTop: 5 }}>
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
                  // Without this the generated title is only a PLACEHOLDER: it looks
                  // greyed out and cannot be edited, so optimizing a word meant
                  // retyping all 80 characters by hand. This copies it into the field
                  // to edit. The title stays auto until you actually press it, so an
                  // untouched item still tracks its fields.
                  <button type="button" className="btn" style={{ padding: "2px 10px", fontSize: 12 }} data-sound="none"
                    disabled={!titlePreview}
                    onClick={() => setField("customTitle", titlePreview)}
                    title="Copy the auto-generated title into the box so you can edit it">
                    Edit title
                  </button>
                )}
              </div>
            </Field>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Description">
              <textarea className="input" rows={5} placeholder="Auto-written from the photos at export. Type here to override."
                value={form.description ?? ""} onChange={(e) => setField("description", e.target.value)} />
              {!form.description && (
                <div style={{ marginTop: 6 }}>
                  <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, padding: "9px 11px", background: "var(--panel-2)", borderRadius: 8 }}>{descPreview}</div>
                  <button type="button" className="btn" style={{ marginTop: 7 }} onClick={() => setField("description", descPreview)}>Use this description</button>
                </div>
              )}
            </Field>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Listing notes (public — included in description)">
              <textarea className="input" rows={2} value={form.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} />
            </Field>
          </div>
        </fieldset>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 10px", flexWrap: "wrap" }}>
        <p className={styles.photoIntro}>
          {selecting
            ? "Click photos to select them, then split them into a new item or move them to another SKU."
            : "Drag photos to reorder how they’ll be listed (first = cover by default). Use the buttons to set a cover, rotate, or exclude a shot."}
        </p>
        {/* Batch-recovery toolbar: fix a merged/missed item without re-importing. */}
        {!selecting ? (
          <button className="btn" data-sound="none" disabled={photoBusy || saving} onClick={() => setSelecting(true)}
            title="Select photos to split into a new item or move to another item (fix a merged group)">
            Select photos…
          </button>
        ) : (
          <>
            <span className="chip" style={{ background: "var(--panel-2)" }}>{selected.size} selected</span>
            <button className="btn" onClick={splitSelected} disabled={selected.size === 0 || saving || photoBusy}
              title="Create a NEW item (you pick its SKU) from the selected photos">
              Split into new item…
            </button>
            <button className="btn" onClick={moveSelected} disabled={selected.size === 0 || saving || photoBusy}
              title="Move the selected photos onto an EXISTING item">
              Move to item…
            </button>
            <button className="btn" data-sound="none" onClick={() => { setSelecting(false); setSelected(new Set()); }}>
              Done
            </button>
          </>
        )}
      </div>

      <div className={styles.photos}>
        {listing.map((p, i) => (
          <figure
            key={p.id}
            aria-label={`Photo ${i + 1}`}
            className={"card ptile" + (dragId === p.id ? " dragging" : "")}
            data-dragover={overId === p.id}
            draggable={!selecting && !photoBusy && !saving}
            onClick={selecting && !photoBusy && !saving ? () => toggleSelect(p.id) : undefined}
            onDragStart={selecting ? undefined : () => setDragId(p.id)}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={(e) => { if (selecting) return; e.preventDefault(); if (overId !== p.id) setOverId(p.id); }}
            onDragLeave={() => setOverId((o) => (o === p.id ? null : o))}
            onDrop={selecting ? undefined : () => onDrop(p.id)}
            style={{
              overflow: "hidden", position: "relative",
              cursor: selecting ? "pointer" : "grab",
              outline: selecting && selected.has(p.id) ? "3px solid var(--accent)" : undefined,
            }}
          >
            {selecting && (
              <label className={styles.photoSelect} onClick={event => event.stopPropagation()}>
                <input type="checkbox" aria-label={`Select photo ${i + 1}`} checked={selected.has(p.id)} disabled={photoBusy || saving} onChange={() => toggleSelect(p.id)} />
              </label>
            )}
            <div style={{ position: "absolute", top: 6, left: 6, zIndex: 2, display: "flex", alignItems: "center", gap: 4, background: "var(--panel)", padding: "2px 7px", borderRadius: 7, fontSize: 12, fontWeight: 700 }}>
              <GripVertical size={12} /> {i + 1}
            </div>
            {p.isCover && (
              <span style={{ position: "absolute", top: 6, right: selecting ? 56 : 6, zIndex: 2, background: "var(--panel)", padding: "2px 7px", borderRadius: 7, fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>★ Cover</span>
            )}
            {/* Fit the rotated photo inside this frame without cropping its edges. */}
            <div style={{ height: 180, overflow: "hidden", position: "relative", background: "var(--panel-2)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <PhotoImage alt={`Photo ${i + 1} for ${item.sku}`} src={thumbSrc(p)}
                rotation={p.rotation} style={{ opacity:p.includeInListing?1:.45 }} />
              {!p.includeInListing && <span className={styles.excluded}>Excluded from listing</span>}
            </div>
            <div className={styles.photoActions}>
              <IconBtn title="Move left" onClick={() => moveBy(p, -1)} disabled={i === 0 || photoBusy || saving || selecting}><ChevronLeft size={17} /></IconBtn>
              <IconBtn title="Set as cover" disabled={p.isCover || photoBusy || saving || selecting} onClick={() => photoOp(p, { isCover: true })}><Star size={15} color={p.isCover ? "var(--accent)" : undefined} /></IconBtn>
              <IconBtn title="Rotate" disabled={photoBusy || saving || selecting} onClick={() => photoOp(p, { rotation: (p.rotation + 90) % 360 })}><RotateCw size={15} /></IconBtn>
              <IconBtn title={p.includeInListing ? "Exclude from listing" : "Include in listing"} disabled={photoBusy || saving || selecting} onClick={() => photoOp(p, { includeInListing: !p.includeInListing })}>
                {p.includeInListing ? <EyeOff size={15} /> : <Eye size={15} />}
              </IconBtn>
              <IconBtn title="View full size" onClick={() => setLightbox(p)}><Maximize2 size={15} /></IconBtn>
              <IconBtn title="Move right" onClick={() => moveBy(p, 1)} disabled={i === listing.length - 1 || photoBusy || saving || selecting}><ChevronRight size={17} /></IconBtn>
            </div>
          </figure>
        ))}
      </div>

      {!listing.length && <p className="muted">This item has no listing photos.</p>}

      {marker && (
        <div style={{ marginTop: 26 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px" }} className="muted">SKU marker (internal — never listed)</h2>
          <div className={`card ${styles.marker}`}>
            <span style={{ position: "absolute", top: 5, left: 5, background: "var(--panel)", padding: "1px 6px", borderRadius: 5, fontSize: 10 }}>SKU</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <div style={{height:150}}><PhotoImage alt={`SKU marker for ${item.sku}`} src={thumbSrc(marker)}
              rotation={marker.rotation} /></div>
            <button type="button" className="btn" style={{width:'100%'}} onClick={() => setLightbox(marker)} aria-label="View SKU marker full size">View marker <Maximize2 size={15} /></button>
          </div>
        </div>
      )}

      {lightbox && <PhotoViewer photos={viewerPhotos} photoId={lightbox.id} sku={item.sku}
        onSelect={photoId => { const photo = viewerPhotos.find(value => value.id === photoId); if (photo) setLightbox(photo); }} onClose={() => setLightbox(null)} />}

      <PromptDialog spec={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

function Field({ label, children, group = false }: { label: string; children: React.ReactNode; group?: boolean }) {
  if (group) return <fieldset className={styles.group}><legend>{label}</legend>{children}</fieldset>;
  return (
    <label className={styles.field}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
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

// Strict dropdown whose value must be one Nifty accepts. If the saved value isn't in
// the canonical list (e.g. an older custom value), it's shown so it isn't silently lost.
function SelectInput({ value, options, onChange, placeholder }: { value: string; options: readonly string[]; onChange: (v: string) => void; placeholder?: string }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ?? "—"}</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function IconBtn({ children, onClick, title, disabled }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} className={styles.photoButton}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      >
      {children}
    </button>
  );
}

function NotFound() {
  return (
    <div>
      <Link href="/inventory" className="btn" style={{ marginBottom: 16 }}><ArrowLeft size={16} /> Inventory</Link>
      <div className="card" style={{ padding: 40, textAlign: "center" }}>
        <p className="muted">Item not found.</p>
      </div>
    </div>
  );
}
