"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Camera,Loader2,Package} from 'lucide-react';
import {toast} from 'sonner';
import {estimatePrice} from '@/lib/listing';
import {playSound} from '@/lib/sound';
import {withExpectedItemValues} from '@/lib/itemEdits';
import {listItemDrafts,draftIdentity,type ItemDraft,type DraftItem} from '@/lib/itemDrafts';
import {pricingConfig,type PriceConfig} from '@/lib/pricingDraft';
import {fetchPricingIndex,fetchPricingRows,recoverPricingIndex} from '@/lib/pricingClient';
import type {PricingIndex,PricingRow} from '@/lib/pricingRead';
import {PriceEditor,type PriceSaveResult,type PricingItem} from './PriceEditor';
import {useItemDraft} from './useItemDraft';
import {DraftRecovery} from './DraftRecovery';
import styles from './PricingTable.module.css';
type PriceRow=PricingRow;
type Navigate=(action:()=>void)=>void;
const identity=(item:PricingIndex)=>`${item.id}:${item.createdAt}`;

export function PricingTable({onCount,onNavigation}:{onCount:(count:number)=>void;onNavigation?:(navigate:Navigate|null)=>void}){
  const router=useRouter(),[index,setIndex]=useState<PricingIndex[]>([]),[rows,setRows]=useState<PriceRow[]>([]),[cfg,setCfg]=useState<PriceConfig|null>(null);
  const [unavailable,setUnavailable]=useState<{draft:ItemDraft;reason:string}[]>([]),[unavailablePage,setUnavailablePage]=useState(1);
  const [page,setPage]=useState(1),[query,setQuery]=useState(''),[q,setQ]=useState(''),[expanded,setExpanded]=useState<number|null>(null);
  const [metadataLoading,setMetadataLoading]=useState(true),[indexFresh,setIndexFresh]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[navigationError,setNavigationError]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0),[saved,setSaved]=useState(new Set<string>()),[focusId,setFocusId]=useState<number|null>(null),[lensBusy,setLensBusy]=useState(new Set<number>());
  const savedRef=useRef(saved),inputs=useRef<Record<number,HTMLInputElement|null>>({}),alive=useRef(true),metadataRead=useRef<AbortController|null>(null);
  const busyKeys=useRef(new Set<string>()),unsafeKeys=useRef(new Set<string>()),queued=useRef<(()=>void)|null>(null),[busy,setBusy]=useState(false),advanceAfter=useRef<number|null>(null);
  const onSafety=useCallback((key:string,pending:boolean,unsafe?:boolean)=>{
    if(pending)busyKeys.current.add(key);else busyKeys.current.delete(key);
    if(unsafe===true)unsafeKeys.current.add(key);else if(unsafe===false)unsafeKeys.current.delete(key);
    setBusy(!!busyKeys.current.size);
    queueMicrotask(()=>{if(!alive.current||busyKeys.current.size||!queued.current)return;const action=queued.current;queued.current=null;
      if(unsafeKeys.current.size){setNavigationError('Keep this page open until the local price drafts can be saved.');return;}setNavigationError(null);action();});
  },[]);
  const navigate=useCallback<Navigate>(action=>{
    if(busyKeys.current.size){queued.current=action;return;}
    if(unsafeKeys.current.size){setNavigationError('Keep this page open until the local price drafts can be saved.');return;}
    setNavigationError(null);action();
  },[]);
  useEffect(()=>{onNavigation?.(navigate);return()=>onNavigation?.(null);},[navigate,onNavigation]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;metadataRead.current?.abort();queued.current=null;};},[]);
  useEffect(()=>{
    const guard=(event:BeforeUnloadEvent)=>{if(busyKeys.current.size||unsafeKeys.current.size){event.preventDefault();event.returnValue='';}};
    const link=(event:MouseEvent)=>{if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||!busyKeys.current.size&&!unsafeKeys.current.size)return;
      const anchor=(event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement|null;if(!anchor||anchor.target==='_blank'||anchor.hasAttribute('download'))return;
      const url=new URL(anchor.href,location.href);if(url.origin!==location.origin)return;event.preventDefault();event.stopPropagation();navigate(()=>router.push(url.pathname+url.search+url.hash));};
    window.addEventListener('beforeunload',guard);document.addEventListener('click',link,true);return()=>{window.removeEventListener('beforeunload',guard);document.removeEventListener('click',link,true);};
  },[navigate,router]);
  const loadIndex=useCallback(async()=>{
    metadataRead.current?.abort();const controller=new AbortController();metadataRead.current=controller;setMetadataLoading(true);setIndexFresh(false);setError(null);
    try{
      const [data,response,drafts]=await Promise.all([fetchPricingIndex(controller.signal),fetch('/api/settings',{signal:controller.signal,cache:'no-store'}),listItemDrafts('pricing')]);
      if(!response.ok)throw Error('Pricing settings could not load.');const config=pricingConfig((await response.json()).settings);
      const recovered=await recoverPricingIndex(data.items,drafts,async ids=>(await fetchPricingIndex(controller.signal,ids)).items);
      if(controller.signal.aborted||!alive.current)return;
      setIndex(recovered.rows);setUnavailable(recovered.unavailable);setCfg(config);setIndexFresh(true);savedRef.current=new Set();setSaved(savedRef.current);setAttempt(value=>value+1);
      onCount(recovered.rows.length+recovered.unavailable.length);
    }catch(failure){if(!controller.signal.aborted&&alive.current)setError(failure instanceof Error?failure.message:'Pricing could not load.');}
    finally{if(metadataRead.current===controller&&alive.current)setMetadataLoading(false);}
  },[onCount]);
  useEffect(()=>{void loadIndex();},[loadIndex]);
  useEffect(()=>{if(query.trim()===q)return;const timer=setTimeout(()=>navigate(()=>{setQ(query.trim());setPage(1);}),250);return()=>clearTimeout(timer);},[query,q,navigate]);
  const filtered=index.filter(item=>item.sku.toLowerCase().includes(q.toLowerCase())),pages=Math.max(1,Math.ceil(filtered.length/50)),shownPage=Math.min(page,pages);
  const selected=filtered.slice((shownPage-1)*50,shownPage*50),key=selected.map(identity).join('|');
  const current=useRef({key,fresh:false});current.current.key=key;
  const [loadedKey,setLoadedKey]=useState<string|null>(null);
  current.current.fresh=loadedKey===key&&indexFresh&&!metadataLoading&&!loading&&!error;
  useEffect(()=>{if(page!==shownPage)setPage(shownPage);},[page,shownPage]);
  useEffect(()=>{
    if(metadataLoading||!indexFresh||!cfg)return;
    const controller=new AbortController();setLoading(true);setError(null);current.current.fresh=false;
    const requested=[...selected];
    void fetchPricingRows(controller.signal,requested.map(item=>item.id)).then(result=>{
      if(controller.signal.aborted||!alive.current)return;
      if(result.items.length!==requested.length||result.items.some(row=>!requested.some(item=>item.id===row.id&&item.createdAt===row.createdAt)))throw Error('An item on this page changed or is unavailable. Refresh the pricing queue; local drafts are kept.');
      setRows(result.items);setLoadedKey(key);
    }).catch(failure=>{if(!controller.signal.aborted&&alive.current)setError(failure instanceof Error?failure.message:'Pricing details could not load.');})
      .finally(()=>{if(!controller.signal.aborted&&alive.current)setLoading(false);});
    return()=>controller.abort();
    // Selection identities, rather than recreated arrays, own each detail read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,attempt,metadataLoading,indexFresh,cfg]);
  const remaining=index.filter(item=>!saved.has(identity(item))).length+unavailable.length;
  useEffect(()=>{if(!metadataLoading&&cfg&&!error)onCount(remaining);},[remaining,onCount,metadataLoading,cfg,error]);
  const scope=useRef({filtered,shownPage});scope.current={filtered,shownPage};
  function nextAfter(id:number){
    const position=rows.findIndex(row=>row.id===id);
    for(let offset=1;offset<rows.length;offset++){const row=rows[(position+offset)%rows.length],input=inputs.current[row.id];if(!savedRef.current.has(identity(row))&&input&&!input.disabled){input.focus();return;}}
    advanceAfter.current=id;
  }
  function savedRow(row:PriceRow,ok:boolean,item?:PricingItem){
    const token=identity(row),next=new Set(savedRef.current);if(ok)next.add(token);else next.delete(token);
    if(next.size!==savedRef.current.size||next.has(token)!==savedRef.current.has(token)){savedRef.current=next;setSaved(next);}
    if(ok&&item){setRows(previous=>previous.map(value=>value.id===row.id?{...value,...item,photos:value.photos}:value));playSound('save');}
    if(!ok&&advanceAfter.current===row.id)advanceAfter.current=null;
    if(ok&&advanceAfter.current===row.id){advanceAfter.current=null;if(queued.current)return;navigate(()=>{
      const list=scope.current.filtered,start=list.findIndex(value=>value.id===row.id);
      for(let offset=1;offset<=list.length;offset++){const at=(start+offset)%list.length,target=list[at];if(!savedRef.current.has(identity(target))){setFocusId(target.id);setPage(Math.floor(at/50)+1);return;}}
    });}
  }
  async function savePrice(row:PriceRow,price:number,expected:Record<string,unknown>):Promise<PriceSaveResult>{
    const response=await fetch(`/api/items/${row.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(withExpectedItemValues(expected,{listedPrice:price}))});
    const result=await response.json().catch(()=>null);if(!response.ok||!result?.item)throw Error(result?.error||'Price did not save. Your draft is kept; refresh to compare saved values.');return result;
  }
  async function lensLookup(row:PriceRow){if(lensBusy.has(row.id))return;setLensBusy(previous=>new Set(previous).add(row.id));try{await openLens(row);}finally{if(alive.current)setLensBusy(previous=>{const next=new Set(previous);next.delete(row.id);return next;});}}
  const missingPages=Math.max(1,Math.ceil(unavailable.length/10)),missingPage=Math.min(unavailablePage,missingPages);
  const pageControls=(bottom=false)=>pages>1?<nav className={styles.pages} aria-label={bottom?'More pricing pages':'Pricing pages'}>
    <button className="btn" data-draft-navigation disabled={loading||metadataLoading||shownPage<=1} onClick={()=>navigate(()=>setPage(shownPage-1))}>Previous prices</button>
    <span>Page {shownPage} of {pages} · {filtered.length} matching items</span>
    <button className="btn" data-draft-navigation disabled={loading||metadataLoading||shownPage>=pages} onClick={()=>navigate(()=>setPage(shownPage+1))}>Next prices</button>
  </nav>:null;
  return <div className={styles.workspace}>
    <div className={styles.header}><h1>Pricing</h1><span className={styles.caption}>{cfg?`${remaining} unfinished`:'Loading pricing…'}</span></div>
    <p className={styles.caption}>Enter saves the price and advances to the next unfinished item. {cfg?.style!=='off'&&cfg?`Whole-number entries use .99 (${cfg.style==='down'?'25 → 24.99':'25 → 25.99'}); typed decimals stay as entered. `:''}Pricing does not replace individual review. Auto Run can pick up items already marked Ready.</p>
    <div className={styles.tools}><label>Find pricing SKU <input className="input" aria-label="Find pricing SKU" value={query} maxLength={32} onChange={event=>setQuery(event.target.value)}/></label><button className="btn" data-draft-navigation onClick={()=>navigate(()=>void loadIndex())}>Refresh pricing</button></div>
    {busy&&<p role="status" className={styles.caption}>Saving prices… Requested page or mode changes will continue after saving.</p>}
    {(error||navigationError)&&<p role="alert" className={styles.error}>{error||navigationError} <button className="btn" data-draft-navigation onClick={()=>navigate(()=>void loadIndex())}>Retry pricing</button></p>}
    {!error&&(metadataLoading||loading)&&<p role="status" className={styles.caption}>Loading pricing details. Existing drafts are kept.</p>}
    {unavailable.slice((missingPage-1)*10,missingPage*10).map(entry=><UnavailablePriceDraft key={entry.draft.key} {...entry} onCleared={()=>setUnavailable(previous=>previous.filter(value=>value.draft.key!==entry.draft.key))}/>)}
    {missingPages>1&&<nav className={styles.pages} aria-label="Unavailable price drafts"><button className="btn" data-draft-navigation disabled={missingPage<=1} onClick={()=>navigate(()=>setUnavailablePage(missingPage-1))}>Previous drafts</button><span>{unavailable.length} unavailable draft items · Page {missingPage}/{missingPages}</span><button className="btn" data-draft-navigation disabled={missingPage>=missingPages} onClick={()=>navigate(()=>setUnavailablePage(missingPage+1))}>Next drafts</button></nav>}
    {pageControls()}
    {cfg&&loadedKey===key&&<div className={`card ${styles.tableWrap}`}><table className={styles.table}><thead><tr><th>Photos</th><th>SKU</th><th>Item</th><th>Status</th><th>Price</th></tr></thead><tbody>
      {rows.map(row=><PriceRowGroup key={identity(row)} row={row} config={cfg} expanded={expanded===row.id} onToggle={()=>setExpanded(previous=>previous===row.id?null:row.id)}
        saved={saved.has(identity(row))} lensBusy={lensBusy.has(row.id)} onLens={()=>void lensLookup(row)} savePrice={(price,expected)=>savePrice(row,price,expected)}
        onSaved={(ok,item)=>savedRow(row,ok,item)} onNext={()=>nextAfter(row.id)} onSafety={onSafety} isCurrent={()=>current.current.fresh&&current.current.key===key}
        focusWhenReady={focusId===row.id} onFocused={()=>setFocusId(null)} inputRef={element=>{inputs.current[row.id]=element;}}/>)}
    </tbody></table></div>}
    {!metadataLoading&&!loading&&!error&&!filtered.length&&<p className={styles.caption}>{q?'No pricing items match this SKU.':'No items need pricing here. Review and approval requirements still apply.'}</p>}
    {pageControls(true)}
  </div>;
}

function PriceRowGroup({row,config,expanded,onToggle,saved,lensBusy,onLens,...editor}:{row:PriceRow;config:PriceConfig;expanded:boolean;onToggle:()=>void;saved:boolean;lensBusy:boolean;onLens:()=>void}&Omit<React.ComponentProps<typeof PriceEditor>,'item'|'config'|'suggestion'>){
  const photo=row.photos[0],thumb=photo?`/api/thumb?path=${encodeURIComponent(photo.thumbPath??photo.storedPath)}&full=${encodeURIComponent(photo.storedPath)}`:null;
  return <><tr className={styles.row} style={{opacity:saved?0.65:1}}>
    <td><button className={styles.photoToggle} aria-label={`Show photos for ${row.sku}`} aria-expanded={expanded} onClick={onToggle}>{thumb?<img src={thumb} alt="" loading="lazy"/>:<Package size={24}/>}</button></td>
    <td data-label="SKU"><strong>{row.sku}</strong></td><td data-label="Item">{[row.brand!=='Unknown'?row.brand:null,row.itemType,row.size,row.condition].filter(Boolean).join(' · ')||'—'}</td>
    <td data-label="Status"><span className="chip">{row.status==='Ready for Nifty'?'Ready':row.status}</span></td>
    <td data-label="Price"><button className="btn" disabled={lensBusy} onClick={onLens} title="Look up the cover photo with Google Lens">{lensBusy?<Loader2 size={13}/>:<Camera size={13}/>} {lensBusy?'Looking…':'Lens'}</button>
      <PriceEditor item={row} config={config} suggestion={estimatePrice(row.itemType)} {...editor}/></td>
  </tr>{expanded&&<tr className={styles.gallery}><td colSpan={5}><p className={styles.caption}>Cover and up to seven more photos. <a href={`/inventory/${row.id}`}>Open the full item</a> to inspect every photo.</p><div className={styles.photos}>{row.photos.map(photo=><img key={photo.id} alt="" src={`/api/thumb?path=${encodeURIComponent(photo.thumbPath??photo.storedPath)}&full=${encodeURIComponent(photo.storedPath)}`} style={{transform:`rotate(${photo.rotation}deg)`}}/>)}</div></td></tr>}</>;
}

type NativeBridge = {
  openExternal?: (u: string) => Promise<boolean>;
  copyImage?: (p: string) => Promise<boolean>;
};
const native = () => (window as Window & { blackcat?: NativeBridge }).blackcat;

function openUrl(url: string) {
  const n = native();
  if (n?.openExternal) n.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

// Google Lens. Two modes:
//  1) ONE-CLICK (settings.lensPublicUpload on): the server resolves the item's CURRENT
//     cover (fresh from the DB, so a just-changed cover is honored), downscales it, uploads
//     it to a temporary public host (auto-deletes in 1h), and Lens opens with results.
//  2) Private fallback (toggle off / upload failed): the photo is copied to the clipboard
//     and Lens opens — paste (Ctrl+V) and go. Nothing leaves the machine until the paste.
async function openLens(r: PriceRow) {
  const cover = r.photos.find((p) => p.isCover && !p.isMarker) ?? r.photos.find((p) => !p.isMarker);
  if (!cover) { toast.error("This item has no listing photo yet."); return; }

  try {
    const res = await fetch("/api/lens", { method: "POST", body: JSON.stringify({ itemId: r.id }) });
    const j = await res.json().catch(() => null);
    if (j?.ok && j.lensUrl) {
      openUrl(j.lensUrl);           // one click — Lens loads the photo itself
      return;
    }
    if (j && !j.disabled) toast.message("Temp upload failed — falling back to copy & paste.");
  } catch { /* endpoint unreachable — fall back */ }

  const n = native();
  if (!n?.copyImage) {
    toast.message("Lens copy needs the desktop app — opening Lens; add the photo by hand.");
    openUrl("https://lens.google.com/");
    return;
  }
  const ok = await n.copyImage(cover.storedPath);
  openUrl("https://lens.google.com/");
  if (ok) toast.success("Photo copied — press Ctrl+V on the Google Lens tab.", { duration: 8000 });
  else toast.error("Could not copy the photo — drag it into Lens instead.");
}

function UnavailablePriceDraft({ draft, reason, onCleared }: { draft: ItemDraft; reason: string; onCleared: () => void }) {
  const identity = draftIdentity(draft.key, "pricing");
  const item = { ...draft.baseline, ...identity, status: String(draft.baseline.status) } as DraftItem;
  const recovery = useItemDraft("pricing", item, () => {});
  const reported = useRef(false);
  useEffect(() => { if (recovery.ready && !recovery.dirty && !reported.current) { reported.current = true; onCleared(); } }, [recovery.ready, recovery.dirty, onCleared]);
  if (recovery.ready && !recovery.dirty) return null;
  return <div className="card" style={{ padding: 14, marginBottom: 12 }}>
    <p role="alert">Item #{identity.id}: {reason}</p>
    <p>Unfinished price: {String(draft.changes.listedPrice ?? "Cleared")}</p>
    <DraftRecovery recovery={recovery} item={item} />
  </div>;
}
