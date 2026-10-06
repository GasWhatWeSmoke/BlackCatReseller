"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from 'sonner';
import { useItemDraft } from "./useItemDraft";
import { DraftRecovery } from "./DraftRecovery";
import { priceDecision, pricingEligible, type PriceConfig } from "@/lib/pricingDraft";
import type { DraftItem } from "@/lib/itemDrafts";

export interface PricingItem extends DraftItem { sku: string; listedPrice: number | null; niftyStatus?: string }
export interface PriceSaveResult { item: PricingItem; priceWarning?: string }

export function PriceEditor({ item, config, suggestion, savePrice, onSaved, onNext, inputRef, onSafety, isCurrent, focusWhenReady, onFocused }: {
  item: PricingItem; config: PriceConfig; suggestion: number | null;
  savePrice: (price: number, expected: Record<string, unknown>) => Promise<PriceSaveResult>;
  onSaved: (saved: boolean, item?: PricingItem) => void; onNext: () => void;
  inputRef?: (element: HTMLInputElement | null) => void;
  onSafety?: (key:string,busy:boolean,unsafe?:boolean)=>void;
  isCurrent?:()=>boolean;
  focusWhenReady?:boolean;onFocused?:()=>void;
}) {
  const [value, setValue] = useState(item.listedPrice == null || item.listedPrice <= 0 ? "" : item.listedPrice.toFixed(2));
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [confirmPrice, setConfirmPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const inputElement=useRef<HTMLInputElement|null>(null),savedCallback=useRef(onSaved),focusedCallback=useRef(onFocused);
  savedCallback.current=onSaved;focusedCallback.current=onFocused;
  const recovery = useItemDraft("pricing", item, changes => {
    if (Object.hasOwn(changes, "listedPrice")) {
      setValue(changes.listedPrice == null ? "" : String(changes.listedPrice));
      setConfirmation(null); setConfirmPrice(null); setError(null);
      const complete = !recovery.hasEdit("listedPrice") && (item.listedPrice ?? 0) > 0;
      setSaved(complete); onSaved(complete);
    }
  });
  const eligible = pricingEligible(item);
  const currentView=isCurrent?.()!==false;
  const key=`${item.id}:${item.createdAt}`;
  useEffect(()=>{onSafety?.(key,saving,!recovery.canLeave);return()=>onSafety?.(key,false,false);},[key,saving,recovery.canLeave,onSafety]);
  useEffect(()=>{
    if(recovery.ready&&!recovery.dirty&&!saving){const complete=(item.listedPrice??0)>0;setValue(complete?item.listedPrice!.toFixed(2):'');setSaved(complete);savedCallback.current(complete);}
    // Draft recovery owns raw text on discard/conflict resolution; only a new
    // saved-price observation or initial readiness synchronizes this input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[item.listedPrice,recovery.ready]);
  useEffect(()=>{if(focusWhenReady&&recovery.ready&&!saving&&eligible&&currentView){inputElement.current?.focus();focusedCallback.current?.();}},[focusWhenReady,recovery.ready,saving,eligible,currentView]);

  function change(raw: string) {
    if (!recovery.ready || recovery.discarding || pending.current) return;
    if (!recovery.change({ listedPrice: raw })) return;
    setValue(raw); setConfirmation(null); setConfirmPrice(null); setError(null); setSaved(false); onSaved(false);
  }

  async function commit(advance: boolean, explicit: boolean) {
    if (!eligible || !recovery.canSave || pending.current || !recovery.dirty || isCurrent?.()===false) return;
    // Blurring never supplies the second confirmation for an unusual amount.
    const decision = priceDecision(value, config, explicit ? confirmation : null);
    if (decision.kind === "empty") return;
    if (decision.kind === "invalid") { setError(decision.message); return; }
    if (decision.kind === "confirm") { setConfirmation(decision.token); setConfirmPrice(decision.price); return; }
    pending.current = true; setSaving(true); setError(null);
    onSafety?.(key,true,!recovery.canLeave);
    try {
      const token = await recovery.prepareSave();
      if (advance) onNext();
      const result = await savePrice(decision.price, token.expected);
      if (result.item.id !== item.id || result.item.createdAt !== item.createdAt || result.item.listedPrice !== decision.price)
        throw new Error("The saved price could not be confirmed. Your draft has been kept.");
      await recovery.saved(token, result.item);
      setValue(decision.price.toFixed(2)); setConfirmation(null); setConfirmPrice(null); setSaved(true); onSaved(true, result.item);
      toast.dismiss(`price-feedback-${item.id}`);
      if (result.priceWarning) {setError(result.priceWarning);toast.warning(result.priceWarning,{id:`price-feedback-${item.id}`,duration:8000});}
    } catch (failure) { const message=failure instanceof Error?failure.message:'Price did not save. Your draft is still here.';setError(message);toast.error(`Price ${item.sku}: ${message}`,{id:`price-feedback-${item.id}`,duration:8000}); }
    finally { pending.current = false; setSaving(false); onSafety?.(key,false); }
  }

  return <div data-price-editor={item.id}>
    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
      {!value.trim() && !saved && suggestion != null && <button className="btn" disabled={!recovery.ready || recovery.discarding || !eligible}
        title={`Fill suggested price for ${item.sku}; review it before saving`} onClick={() => change(String(suggestion))}>~${suggestion}</button>}
      <span className="muted">$</span>
      <input ref={element=>{inputElement.current=element;inputRef?.(element);}} className="input" aria-label={`Price for ${item.sku}`} type="text" inputMode="decimal" maxLength={32}
        disabled={!recovery.ready || recovery.discarding || saving || !eligible || isCurrent?.()===false} value={value}
        style={{ width: 96, borderColor: confirmPrice != null ? "var(--warn)" : undefined }}
        onChange={event => change(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void commit(true, true); } }}
        onBlur={event => {
          // Clicking a recovery/control button must not save the value on the way there.
          if ((event.relatedTarget as Element | null)?.closest("[data-price-editor]")?.getAttribute("data-price-editor") === String(item.id)) return;
          if (value.trim()) void commit(false, false);
        }} />
      <button className="btn" disabled={saving || !recovery.canSave || !eligible || !recovery.dirty || isCurrent?.()===false} onClick={() => void commit(false, true)}>Save price</button>
      {saving && <span role="status"><Loader2 size={15} className="spin" /> Saving price…</span>}
      {saved && !saving && <span role="status" style={{ color: "var(--ok)" }}><CheckCircle2 size={15} /> Saved</span>}
    </div>
    {confirmPrice != null && <p role="alert" style={{ color: "var(--warn)", fontSize: 12 }}>Unusual price: ${confirmPrice.toFixed(2)}. Press Enter or Save price again to confirm.</p>}
    {error && <p role="alert" style={{ color: "var(--warn)", fontSize: 12 }}>{error}</p>}
    {!eligible && <p role="status">This item is now {item.status}. Pricing cannot change it here. Review the item in the <a href={`/inventory/${item.id}`}>full editor</a> or discard this local draft.</p>}
    <DraftRecovery recovery={recovery} item={item} compact disabled={saving} />
  </div>;
}
