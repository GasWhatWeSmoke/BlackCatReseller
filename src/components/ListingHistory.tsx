"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { RefreshCw, PackageCheck, Undo2, Search, ArrowUpRight, Package } from "lucide-react";
import { MARKETPLACE_NAMES } from "@/lib/publish/platforms";
import { announceShipQueueChanged } from "@/lib/shipQueue";
import { saleDateLabel, type HistoryFilter, type HistoryItem } from "@/lib/pastUploads";
import { historyView } from '@/lib/historyView';
import styles from "./History.module.css";
import { MercariGoal } from "./MercariGoal";
import { usePolledRead } from "./usePolledRead";
import { withExpectedItemValues } from "@/lib/itemEdits";
import { ManualSale } from './ManualSale';

const money = (value:number|null) => value == null ? "Not recorded" : new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(value);
const marketName = (value:string) => MARKETPLACE_NAMES[value as keyof typeof MARKETPLACE_NAMES] ?? value;
export default function ListingHistory({ sales = false }: { sales?:boolean }) {
  const [query,setQuery]=useState(''),[q,setQ]=useState(''),[page,setPage]=useState(1);
  const [filter,setFilter]=useState<HistoryFilter>('all');
  const [busy,setBusy]=useState<number|null>(null),[syncing,setSyncing]=useState(false);
  const writing=useRef(false),syncRef=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setFilter('all');setPage(1);},[sales]);
  useEffect(()=>{if(query.trim()===q)return;const timer=setTimeout(()=>{setQ(query.trim());setPage(1);},250);return()=>clearTimeout(timer);},[query,q]);
  const mode=sales?'sales':'history';
  const readHistory=useCallback(async(signal:AbortSignal)=>{
    const response=await fetch(`/api/past-uploads?${new URLSearchParams({view:mode,filter,q,page:String(page)})}`,{cache:'no-store',signal});
    if(!response.ok)throw Error('Your history could not be loaded. Try refreshing.');
    const result=historyView(await response.json());
    if(result.query.view!==mode||result.query.filter!==filter||result.query.q!==q||result.requestedPage!==page||result.pageSize!==50)throw Error('History does not match the requested view. Refresh to continue.');
    return result;
  },[mode,filter,q,page]);
  const view=usePolledRead(readHistory,15000),{error,load}=view,data=view.data;
  const latestLoad=useRef(load);latestLoad.current=load;
  const refreshCurrent=useCallback(()=>mounted.current?latestLoad.current():Promise.resolve(false),[]);
  const matches=!!data&&data.query.view===mode&&data.query.filter===filter&&data.query.q===q&&data.requestedPage===page;
  const searchPending=query.trim()!==q,canUsePage=matches&&view.fresh&&!searchPending;
  const current=useRef(false);current.current=canUsePage;
  useEffect(()=>{if(matches&&view.fresh&&data&&data.page!==page)setPage(data.page);},[matches,view.fresh,data,page]);
  const shown=data?.items??[],loaded=data!==null;
  async function sync(){
    if(syncRef.current)return;syncRef.current=true;setSyncing(true);
    try{
      const response=await fetch('/api/sync',{method:'POST'}),result=await response.json();
      if(!response.ok)throw Error('Could not confirm the sales check');
      if(result?.ok===true)toast.success(result.summary||'Marketplace sales check completed');
      else toast.warning(result?.summary||result?.error||'Sync needs attention');
      await refreshCurrent();announceShipQueueChanged();
    }catch{toast.error('Could not complete marketplace sync');await refreshCurrent();announceShipQueueChanged();}
    finally{syncRef.current=false;if(mounted.current)setSyncing(false);}
  }
  async function ship(item:HistoryItem,shipped:boolean){
    if(writing.current||!current.current||!view.isFresh()||item.status!=='Sold')return;
    writing.current=true;setBusy(item.id);view.invalidate();
    try{
      const change=withExpectedItemValues({createdAt:item.createdAt,status:item.status,shippedAt:item.shippedAt},{shipped});
      change.expectedValues.updatedAt=item.updatedAt;
      const response=await fetch(`/api/items/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(change)});
      const result=await response.json().catch(()=>null);
      if(!response.ok)throw Error(result?.error||'Fulfillment status could not be saved');
      if(result?.item?.id!==item.id||result.item.createdAt!==item.createdAt||result.item.status!=='Sold'||(shipped?typeof result.item.shippedAt!=='string'||!Number.isFinite(Date.parse(result.item.shippedAt)):result.item.shippedAt!==null))
        throw Error('The fulfillment change could not be confirmed. Refresh history before trying again.');
      announceShipQueueChanged();toast.success(shipped?`${item.sku} ${item.manualSale?.fulfillment==='pickup'?'handed over':'marked shipped'}`:`${item.sku} returned to the fulfillment queue`);
    }catch(error){toast.error(error instanceof Error?error.message:'Could not update fulfillment');}
    finally{await refreshCurrent();writing.current=false;if(mounted.current)setBusy(null);}
  }
  const changePage=(value:number)=>{current.current=false;setPage(value);};
  const pagination=(bottom=false)=>!data||data.pages<=1?null:<nav className={styles.pagination} aria-label={bottom?'More history pages':'History pages'}>
    <button className="btn" disabled={!canUsePage||view.refreshing||busy!==null||!data||data.page<=1} onClick={()=>changePage(data!.page-1)}>Previous page</button>
    <span>{data?`Page ${data.page} of ${data.pages} · ${data.total} matching ${sales?'sales':'items'}`:'Loading page…'}</span>
    <button className="btn" disabled={!canUsePage||view.refreshing||busy!==null||!data||data.page>=data.pages} onClick={()=>changePage(data!.page+1)}>Next page</button>
  </nav>;
  return <section>
    {sales && <MercariGoal />}
    {sales && <ManualSale onChanged={()=>void refreshCurrent()}/>}
    <div className={styles.toolbar}>
      <label className={styles.search}><Search size={17}/><input placeholder={sales ? 'Search sales by SKU, title, or marketplace' : 'Search listing history'} aria-label="Search history" maxLength={200} value={query} onChange={e=>{current.current=false;setQuery(e.target.value);}}/></label>
      <select className="select" aria-label="Filter history" value={filter} onChange={e=>{current.current=false;setFilter(e.target.value as HistoryFilter);setPage(1);}}>
        <option value="all">{sales ? 'All sales' : 'All history'} ({data?.counts.all??'…'})</option>
        {sales ? <><option value="shipping">Needs fulfillment ({data?.counts.shipping??'…'})</option><option value="shipped">Fulfilled</option></> : <><option value="listed">Currently listed</option><option value="sold">Sold</option></>}
        <option value="attention">Removal needs attention</option>
      </select>
      <button className="btn" onClick={()=>void sync()} disabled={syncing}><RefreshCw size={15} className={syncing?'spin':''}/>{syncing?'Checking marketplaces…':'Sync sales'}</button>
      <button className="btn" onClick={()=>void load()} disabled={busy!==null}>Refresh history</button>
    </div>
    {error && <div className={styles.error} role="alert">{error} <button className="btn" onClick={()=>void load()}>Refresh</button></div>}
    {data&&(!matches||searchPending)&&<p className={styles.count} role="status">Showing previous results ({data.query.filter}{data.query.q?`, “${data.query.q}”`:''}). {error?'Refresh to load the requested view.':'Loading your requested view…'}</p>}
    <div className={styles.count} role="status">{loaded ? `${canUsePage ? '' : 'Last loaded: '}${shown.length} of ${data!.total} matching ${sales?'sales':'items'} shown${view.refreshing ? ' · Refreshing…' : ''}` : error ? 'History is unavailable.' : 'Loading your history…'}</div>
    {pagination()}
    <div className={styles.list}>
      {shown.map(item=>{
        const photo=item.photos.find(p=>p.isCover&&!p.isMarker) ?? item.photos.find(p=>!p.isMarker);
        return <article className={`${styles.row} ${sales ? styles.saleRow : ''}`} key={`${item.id}:${item.createdAt}`} data-depth>
          <Link className={styles.photo} href={`/inventory/${item.id}`} aria-label={`Open item ${item.sku}`}>
            {photo ? <img alt="" loading="lazy" src={`/api/thumb?path=${encodeURIComponent(photo.thumbPath??photo.storedPath)}&full=${encodeURIComponent(photo.storedPath)}`} style={{transform:`rotate(${photo.rotation}deg)`}}/> : <Package size={28}/>}
          </Link>
          <div className={styles.details}><div className={styles.sku}><Link href={`/inventory/${item.id}`} aria-label={`Inventory number ${item.sku}`}>{sales ? 'Inventory ' : '#'}{item.sku}</Link><span data-state={item.status==='Sold'?'sold':'listed'}>{sales ? item.manualSale?.fulfillment==='pickup' ? item.shippedAt?'Handed over':'Awaiting pickup' : item.shippedAt?'Shipped':'Needs shipping' : item.displayStatus}</span></div>
            {sales && <Link className={styles.itemName} href={`/inventory/${item.id}`}>{[item.brand,item.itemType,item.color,item.size].filter(Boolean).join(' · ') || 'Item details'}</Link>}
            <Link className={styles.title} href={`/inventory/${item.id}`} title={item.title}>{item.title || 'Item details'}</Link>
            {sales && <div className={styles.saleInfo}><strong className={styles.soldOn}>{item.soldPlatforms.length ? `Sold on ${item.soldPlatforms.join(' · ')}` : 'Sold · marketplace not recorded'}</strong>{item.dateSold && <span className={styles.meta}>{saleDateLabel(item.dateSold)}</span>}</div>}
            <div className={styles.markets}>{item.marketplaceListings.map(listing=>listing.externalUrl ? <a href={listing.externalUrl} target="_blank" rel="noreferrer" key={listing.marketplace} title={`${marketName(listing.marketplace)} · ${listing.status.replaceAll('_',' ')}${listing.price!=null ? ` · ${money(listing.price)}`:''}`}><span data-state={listing.status}/>{marketName(listing.marketplace)}<ArrowUpRight size={11}/></a> : <span key={listing.marketplace}>{marketName(listing.marketplace)} · {listing.status.replaceAll('_',' ')}</span>)}</div>
            {item.removalSummary && <p className={styles.removal} data-attention={item.removalNeedsAttention}>{item.removalSummary}</p>}
          </div>
          <div className={styles.action}>{sales ? <><strong>{money(item.salePrice)}</strong><small>{item.manualSale?.fulfillment==='pickup'?'Pickup · no postage':item.shippingCharged == null ? 'Shipping not recorded' : `+ ${money(item.shippingCharged)} shipping`}</small><button className={`btn ${item.shippedAt?'':'btn-primary'}`} disabled={busy!==null || !canUsePage} onClick={()=>void ship(item,!item.shippedAt)}>{item.shippedAt?<Undo2 size={14}/>:<PackageCheck size={14}/>} {busy===item.id?'Saving…':item.manualSale?.fulfillment==='pickup'?item.shippedAt?'Undo handover':'Mark handed over':item.shippedAt?'Undo shipped':'Mark shipped'}</button></> : <Link className="btn" href={`/inventory/${item.id}`}>View item <ArrowUpRight size={14}/></Link>}</div>
        </article>;
      })}
    </div>
    {pagination(true)}
    {loaded && canUsePage && !shown.length && <div className={styles.empty}><Package size={32}/><h3>{query || filter!=='all' ? 'No matching items' : sales ? 'Your next sale starts here' : 'Your listing history starts here'}</h3><p>{query || filter!=='all'?'Try another search or filter.':'Processed, reviewed pieces are ready for their next chapter.'}</p><Link className="btn" href={sales?'/ready':'/'}>{sales?'Go to Crosslisting':'Add a batch'}</Link></div>}
  </section>;
}
