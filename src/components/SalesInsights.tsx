"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, DollarSign, TrendingUp, Boxes, Loader2, AlertTriangle } from "lucide-react";
import { CatMark } from "@/components/CatMark";
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { earningsView,type EarningsView } from '@/lib/earningsView';
import { usePolledRead } from './usePolledRead';
import { CostEditor,nextCostObservation } from './CostEditor';
import { CostDrafts,useCostDraftCount } from './CostDrafts';
import styles from './SalesInsights.module.css';
import { averageItemSalePrice } from '@/lib/dashboardSales';

type SalesSeries = EarningsView['salesSeries'];

const RANGES: { label: string; days: string }[] = [
  { label: "Week", days: "7" }, { label: "Month", days: "30" }, { label: "90 days", days: "90" }, { label: "Lifetime", days: "all" },
];
const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const monthLabel = (p: string) => {
  const [y, m] = p.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
};

export default function EarningsPage() {
  const router=useRouter();
  const [days, setDays] = useState("7");
  const [page,setPage]=useState(1),[search,setSearch]=useState(''),[q,setQ]=useState(''),[showDrafts,setShowDrafts]=useState(false);
  const [syncing, setSyncing] = useState(false);
  const busyKeys=useRef(new Set<string>()),unsafeKeys=useRef(new Set<string>()),queued=useRef<{filter?:()=>void;view?:()=>void}>({}),active=useRef(true),syncRef=useRef(false);
  const [safety,setSafety]=useState({busy:false,unsafe:false}),[navigationError,setNavigationError]=useState<string|null>(null);
  const onSafety=useCallback((key:string,busy:boolean,unsafe?:boolean)=>{
    if(busy)busyKeys.current.add(key);else busyKeys.current.delete(key);
    if(unsafe===true)unsafeKeys.current.add(key);else if(unsafe===false)unsafeKeys.current.delete(key);
    setSafety(previous=>previous.busy===!!busyKeys.current.size&&previous.unsafe===!!unsafeKeys.current.size?previous:{busy:!!busyKeys.current.size,unsafe:!!unsafeKeys.current.size});
    queueMicrotask(()=>{
      if(!active.current||busyKeys.current.size||!Object.keys(queued.current).length)return;
      const actions=queued.current;queued.current={};
      if(unsafeKeys.current.size){setNavigationError('Keep this view open until the local cost drafts can be saved.');return;}
      setNavigationError(null);actions.filter?.();actions.view?.();
    });
  },[]);
  function navigate(action:()=>void,kind:'filter'|'view'='view'){
    if(busyKeys.current.size){queued.current[kind]=action;return;}
    if(unsafeKeys.current.size){setNavigationError('Keep this view open until the local cost drafts can be saved.');return;}
    setNavigationError(null);action();
  }
  useEffect(()=>{active.current=true;return()=>{active.current=false;queued.current={};};},[]);
  useEffect(()=>{
    const link=(event:MouseEvent)=>{
      if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||(!busyKeys.current.size&&!unsafeKeys.current.size))return;
      const anchor=(event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement|null;
      if(!anchor||anchor.target==='_blank'||anchor.hasAttribute('download'))return;
      const url=new URL(anchor.href,location.href);if(url.origin!==location.origin)return;
      event.preventDefault();event.stopPropagation();navigate(()=>router.push(url.pathname+url.search+url.hash));
    };
    document.addEventListener('click',link,true);return()=>document.removeEventListener('click',link,true);
  },[router]);
  useEffect(()=>{if(!safety.busy&&!safety.unsafe)return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[safety]);
  useEffect(()=>{if(search.trim()===q)return;const timer=setTimeout(()=>navigate(()=>{setQ(search.trim());setPage(1);},'filter'),250);return()=>clearTimeout(timer);},[search,q]);
  const read=useCallback(async(signal:AbortSignal)=>{
    const readVersion=nextCostObservation();
    const response=await fetch(`/api/earnings?${new URLSearchParams({days,page:String(page),q})}`,{signal,cache:'no-store'});
    if(!response.ok)throw Error('Could not load earnings. Try again.');
    const data=earningsView(await response.json());
    if(data.range.days!==(days==='all'?null:Number(days))||data.detail.q!==q)throw Error('The returned earnings do not match this view. Refresh to continue.');
    return {...data,requestedPage:page,readVersion};
  },[days,page,q]);
  const view=usePolledRead(read,null),loadError=view.error,loading=view.refreshing;
  const data=view.data?.range.days===(days==='all'?null:Number(days))?view.data:null;
  const key=JSON.stringify([days,page,q,showDrafts]),current=useRef({key,data,error:loadError});current.current={key,data,error:loadError};
  const refreshEpoch=useRef(0),latestLoad=useRef(view.load);latestLoad.current=view.load;
  const load=useCallback(async()=>{
    if(!active.current)return false;
    let epoch=++refreshEpoch.current,result=await latestLoad.current();
    while(!result&&active.current&&epoch!==refreshEpoch.current){epoch=refreshEpoch.current;result=await latestLoad.current(false);}
    return result;
  },[]);
  const drafts=useCostDraftCount();
  useEffect(() => {
    if(view.fresh&&data&&data.requestedPage===page&&data.detail.q===q&&data.detail.page!==page)setPage(data.detail.page);
  },[view.fresh,data,page,q]);

  async function syncSales() {
    if(syncRef.current||busyKeys.current.size||unsafeKeys.current.size)return;
    syncRef.current=true;
    setSyncing(true);
    const t = toast.loading("Checking marketplace sales…");
    try {
      const r = await fetch("/api/sync", { method: "POST" });
      const j = await r.json();
      if (r.ok&&j?.ok===true) {
        toast.success(
          typeof j.summary==='string'?j.summary:'Sales check acknowledged. Refreshing figures.',
          { id: t },
        );
        await load();
      } else {
        toast.error(`Sync failed: ${j.error ?? "unknown"}`, { id: t, duration: 8000 });
      }
      if (!j.ok) await load();
    } catch (e) { toast.error(`Sync failed: ${e instanceof Error ? e.message : String(e)}`, { id: t }); }
    finally { syncRef.current=false;setSyncing(false); }
  }

  const t = data?.totals;
  const profitEstimated = data?.estimates.profit;
  const incomeMissing = !!data?.shippingIncomeGaps.count;
  const profitIncomplete = !!data?.shippingIncomeGaps.costedCount;
  const noCostedSales = !!t && t.count > 0 && t.costMissingCount === t.count;
  return (
    <div className={styles.workspace}>
      <div className={styles.header}>
        <h2>Sales insights</h2>
        <div className={styles.actions}>
          <div className={styles.ranges} role="group" aria-label="Sales period">
            {RANGES.map((r) => (
              <button key={r.days} aria-pressed={days===r.days} onClick={() => navigate(()=>{setDays(r.days);setPage(1);})} data-sound="none">
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={syncSales} disabled={syncing||safety.busy||safety.unsafe}>
            {syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Sync sales
          </button>
        </div>
      </div>
      <div className={styles.actions}><button className="btn" aria-pressed={showDrafts} onClick={()=>navigate(()=>setShowDrafts(value=>!value))}>{showDrafts?'Show sales details':`Unfinished costs (${drafts.ready?drafts.drafts.length:'…'})`}</button><button className="btn" onClick={()=>navigate(()=>void load())}>Refresh figures</button></div>
      {(navigationError||drafts.error)&&<p role="alert" className={styles.error}>{navigationError||drafts.error}</p>}
      {safety.busy&&<p role="status" className={styles.caption}>Saving cost edits… Page changes will continue after saving.</p>}
      {data&&loading&&<p role="status" className={styles.caption}>Refreshing figures. Your unfinished cost inputs stay in place.</p>}

      {data?.lastSyncSummary && (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 16px" }}>
          Last sync: {data.lastSyncSummary}{data.lastSyncAt ? ` (${new Date(data.lastSyncAt).toLocaleString()})` : ""}
        </p>
      )}

      {loadError && <div role="alert" className="card" style={{ padding: 16, marginBottom: 16, borderColor: "var(--warn)" }}>
        {loadError} {data && "Previously loaded figures are still shown."}
        <button className="btn" onClick={() => void load()} disabled={loading}>Retry earnings</button>
      </div>}
      {loading && !data ? (
        <div className="card" style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} className="spin" /></div>
      ) : loadError && !data ? null : !t || !data || (data.sellThrough.soldCount === 0 && !data.returnCosts?.count) ? (
        <div className="card" style={{ padding: 44, textAlign: "center" }}>
          <CatMark size={44} blink />
          <p className="muted" style={{ margin: "12px 0 0" }}>
            No sold items yet. When items sell, hit <strong>Sync sales</strong> and realized profit shows up here.
          </p>
        </div>
      ) : (
        <>
          {!!data.returnCosts?.count&&<p className="card" style={{padding:14,fontSize:12}}>Includes {money(data.returnCosts.total)} in unrecovered return fees and postage recorded in this period. <a href="/sales/returns">View return history ↗</a></p>}
          {incomeMissing&&<p role="note" aria-label="Missing shipping income" className={styles.error}>
            Shipping income is not recorded for {data.shippingIncomeGaps.count} sale(s) in this period. Figures marked † count that missing income as $0 and are incomplete.
            {' '}Recorded $0.00 is shown separately from “Not recorded.” {profitIncomplete&&`${data.shippingIncomeGaps.costedCount} of these sales are included in profit.`}
          </p>}
          {/* View 1: headline totals. Revenue is GROSS (what buyers actually paid you:
              item prices + shipping you collected); shipping shows both sides of the
              postage money so shipping profit/loss is visible at a glance. */}
          <div className={styles.summary}>
            <Stat label={incomeMissing?'Revenue †':'Revenue'} value={money(t.revenue)} icon={<DollarSign size={16} />}
              sub={`items ${money(t.itemPriceTotal)} + shipping ${money(t.shippingIncome)}`} />
            <Stat label="Average item sale price" value={money(averageItemSalePrice({itemSales:t.itemPriceTotal,itemsSold:t.count,missingSalePrices:0}))} sub={`${t.count} recorded prices; shipping excluded`} />
            <Stat label={data.estimates.fees?'Fees ≈':'Fees'} value={money(t.fees)} sub="marketplace" />
            <Stat label={`${data.estimates.shipping?'Shipping profit ≈':'Shipping profit'}${incomeMissing?' †':''}`} value={money(t.shippingProfit)}
              sub={`collected ${money(t.shippingIncome)} − labels ${money(t.shipping)}`} />
            {/* Always computable: what the sales banked after fees + labels, before
                item costs — the number that never goes blank while costs are unentered. */}
            <Stat label={`${data.estimates.fees||data.estimates.shipping?'Net revenue ≈':'Net revenue'}${incomeMissing?' †':''}`} value={money(t.revenueAfterFees)} sub="after fees + labels" />
            <Stat label="Item cost" value={money(t.cogs)} sub="COGS" />
            <Stat label={profitIncomplete ? `Profit · incomplete${profitEstimated?' ≈':''} †` : profitEstimated ? "Estimated profit" : "Net profit"} value={money(noCostedSales && !data.returnCosts?.count ? null : t.netProfit)} icon={<TrendingUp size={16} />} accent
              sub={t.costMissingCount > 0 ? `${t.costMissingCount} sale(s) excluded: cost missing` : undefined} />
            <Stat label={`${profitEstimated?'Margin ≈':'Margin'}${profitIncomplete?' †':''}`} value={t.marginPct == null ? "—" : `${t.marginPct.toFixed(1)}%`} sub="Sales with recorded item costs" />
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 22px" }}>
            {t.count} sold item(s) in range.
            {t.costMissingCount > 0 && (
              <span style={{ color: "var(--warn)" }}>
                {" "}<AlertTriangle size={12} style={{ verticalAlign: -2 }} /> {t.costMissingCount} item(s) have no cost yet — their rows show <em>net revenue</em> (amber) in the Net column. Enter a cost to include them in profit; fees and postage may still be estimates.
              </span>
            )}
          </p>

          {/* View 2: items sold over time */}
          <div className={`card ${styles.panel}`}>
            <h3>
              Items sold per {data!.salesSeries.bucket}
              <span className="muted" style={{ fontWeight: 500, fontSize: 12, marginLeft: 8 }}>{t.count} in range</span>
            </h3>
            <SalesChart series={data!.salesSeries} />
            <details><summary>Chart values</summary><div className={styles.tableScroll} style={{maxHeight:220}} tabIndex={0} role="region" aria-label="Sales chart values"><table className={styles.table}><thead><tr><th>Date</th><th>Items sold</th></tr></thead><tbody>{data.salesSeries.points.map(point=><tr key={point.date}><td>{point.date}</td><td>{point.count}</td></tr>)}</tbody></table></div></details>
          </div>

          <div className={styles.pair}>
            {/* View 3: per-platform */}
            <div className={`card ${styles.panel}`}>
              <h3>By platform</h3>
              <div className={styles.tableScroll} role="region" aria-label="Marketplace totals" tabIndex={0}><table className={styles.table}>
                <thead><tr className="muted" style={{ textAlign: "left", fontSize: 11 }}>
                  <th style={{ padding: "4px 0" }}>Platform</th><th>Sold</th><th>Revenue</th><th>Fees</th>
                  <th title="Shipping received minus label costs">Ship +/−</th>
                  <th style={{ textAlign: "right" }}>Net</th>
                </tr></thead>
                <tbody>
                  {data!.byPlatform.map((p) => (
                    <tr key={p.platform} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 0", fontWeight: 600 }}>{p.platform}</td>
                      <td>{p.count}</td><td>{money(p.revenue)}{!!data.shippingIncomeGaps.byPlatform[p.platform].count&&<MissingIncomeMark/>}</td><td>{money(p.fees)}{data.platformEstimates[p.platform].fees&&<sup title="Includes estimates">≈</sup>}</td>
                      <td style={{ color: p.shippingProfit > 0 ? "var(--ok)" : p.shippingProfit < 0 ? "var(--danger)" : "var(--muted)" }}>
                        {p.shippingProfit === 0 ? "$0.00" : `${p.shippingProfit > 0 ? "+" : ""}${money(p.shippingProfit)}`}
                        {data.platformEstimates[p.platform].shipping&&<sup title="Includes estimates">≈</sup>}
                        {!!data.shippingIncomeGaps.byPlatform[p.platform].count&&<MissingIncomeMark/>}
                      </td>
                      <td style={{ textAlign: "right", color: p.netProfit != null && p.netProfit >= 0 ? "var(--ok)" : undefined }}>{money(p.netProfit)}{data.platformEstimates[p.platform].profit&&<sup title="Includes estimates">≈</sup>}{!!data.shippingIncomeGaps.byPlatform[p.platform].costedCount&&<MissingIncomeMark/>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>

            {/* View 4: sell-through + aged */}
            <div className={`card ${styles.panel}`}>
              <h3>Lifetime sell-through</h3>
              <div style={{ display: "flex", gap: 22, marginBottom: 14, flexWrap: "wrap" }}>
                <Mini label="Sell-through" value={data!.sellThrough.sellThroughPct == null ? "—" : `${data!.sellThrough.sellThroughPct.toFixed(0)}%`} sub={`${data!.sellThrough.soldCount}/${data!.sellThrough.listedCount} listed`} />
                <Mini label="Avg days to sell" value={data!.sellThrough.avgDaysToSell == null ? "—" : String(data!.sellThrough.avgDaysToSell)} />
                <Mini label="Current open listings" value={String(data!.sellThrough.openCount)} icon={<Boxes size={14} />} />
              </div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Oldest unsold listings</div>
              <div className={styles.tableScroll} style={{ maxHeight: 180 }} role="region" aria-label="Oldest open listings" tabIndex={0}>
                <table className={styles.table}>
                  <thead><tr><th>SKU</th><th>Item</th><th>Price</th><th>Age</th></tr></thead>
                  <tbody>
                    {data!.sellThrough.aged.length === 0 && <tr><td className="muted" style={{ padding: 8 }}>No open listings.</td></tr>}
                    {data!.sellThrough.aged.map((a) => (
                      <tr key={a.sku} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "5px 0", fontWeight: 600 }}>{a.sku}</td>
                        <td className="muted">{a.itemType ?? "—"}</td>
                        <td>{money(a.listedPrice)}</td>
                        <td style={{ textAlign: "right", color: a.daysListed >= 60 ? "var(--warn)" : "var(--muted)" }}>{a.daysListed}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sold items detail */}
          {!showDrafts&&<div className={`card ${styles.panel}`}>
            <h3>Sold items ({data.detail.total})</h3>
            <label className={styles.search}>Find sold SKU<input className="input" value={search} maxLength={32} onChange={event=>setSearch(event.target.value)} placeholder="Inventory number"/></label>
            <p className={styles.caption}>Totals and charts cover the entire selected period. SKU search and pages affect only the detail rows.</p>
            <DetailPages detail={data.detail} busy={loading||search.trim()!==q} onPage={value=>navigate(()=>setPage(value))}/>
            <div className={styles.tableScroll} role="region" aria-label="Sold item details" tabIndex={0}><table role="table" className={`${styles.table} ${styles.detailsTable}`}>
              <thead><tr className="muted" style={{ textAlign: "left", fontSize: 11 }}>
                <th style={{ padding: "4px 0" }}>SKU</th><th>Sold</th><th>Platform</th>
                <th title="What the item itself sold for">Item $</th>
                <th title="Shipping the buyer paid that reached YOUR payout (synced from sale receipts)">Ship in</th>
                <th>Fees</th>
                <th title="What the shipping label cost you">Label</th>
                <th>Cost</th><th style={{ textAlign: "right" }}>Net</th>
              </tr></thead>
              <tbody>
                {data!.soldItems.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ padding: 10 }}>{q?'No sold items match this SKU.':'No sales in this range — try a longer range.'}</td></tr>
                )}
                {data!.soldItems.map((s) => (
                  <tr key={`${s.id}:${s.createdAt}`}>
                    <td data-label="SKU" style={{fontWeight:600}}><Link href={`/inventory/${s.id}`}>{s.sku}</Link></td>
                    <td data-label="Sold" className="muted">{s.dateSold ? new Date(s.dateSold).toLocaleDateString() : "—"}</td>
                    <td data-label="Platform">{s.platform}</td>
                    <td data-label="Item price">{money(s.itemPrice)}</td>
                    <td data-label="Shipping in" style={{ color: s.shippingIncomeMissing ? 'var(--warn)' : s.shippingIncome > 0 ? "var(--ok)" : "var(--muted)" }}>{s.shippingIncomeMissing ? 'Not recorded' : money(s.shippingIncome)}</td>
                    <td data-label="Fees" title={s.feesEstimated ? "estimated" : "actual"}>{money(s.fees)}{s.feesEstimated && <sup style={{ color: "var(--warn)" }}>≈</sup>}</td>
                    <td data-label="Label" title={s.shippingEstimated ? "estimated" : "actual"}>{money(s.shipping)}{s.shippingEstimated && <sup style={{ color: "var(--warn)" }}>≈</sup>}</td>
                    <td data-label="Cost"><CostEditor item={{...s,readVersion:data.readVersion}} isCurrent={()=>active.current&&current.current.key===key&&current.current.data?.requestedPage===page&&current.current.data.detail.q===q} onRefresh={load} onSafety={onSafety}/></td>
                    {/* Cost entered -> true net profit (green/red). No cost yet -> NET
                        REVENUE (amber, before cost) so the row is never a dead "—". */}
                    {s.costMissing ? (
                      <td data-label="Net" title="Revenue after fees and postage, before item cost. May include estimates."
                        style={{ textAlign: "right", color: "var(--warn)" }}>
                        {money(s.revenueAfterFees)}<sup>*</sup>{(s.feesEstimated||s.shippingEstimated)&&<sup>≈</sup>}{s.shippingIncomeMissing&&<MissingIncomeMark/>}
                      </td>
                    ) : (
                      <td data-label="Net" style={{ textAlign: "right", color: (s.netProfit ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>{money(s.netProfit)}{(s.feesEstimated||s.shippingEstimated)&&<sup title="Estimated profit">≈</sup>}{s.shippingIncomeMissing&&<MissingIncomeMark/>}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table></div>
            <DetailPages detail={data.detail} busy={loading||search.trim()!==q} onPage={value=>navigate(()=>setPage(value))} bottom/>
            <p className="muted" style={{ fontSize: 11, margin: "10px 0 0" }}>
              Net = Item $ + Ship in − Fees − Label − Cost. Enter or click away to save a cost; unfinished inputs stay on this device.
              <span style={{ color: "var(--warn)" }}> Net-revenue*</span> excludes unknown item costs. ≈ marks amounts that include fee or postage estimates.
              {' '}† marks incomplete figures that count unrecorded shipping income as $0.
            </p>
          </div>}
        </>
      )}
      {showDrafts&&<section className={`card ${styles.panel}`} aria-label="Unfinished cost edits"><h3>Unfinished cost edits</h3><CostDrafts drafts={drafts.drafts} ready={drafts.ready} onSafety={onSafety} navigate={navigate} onFigures={load}/></section>}
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function MissingIncomeMark(){return <sup title="Incomplete: shipping income not recorded" aria-label="Incomplete: shipping income not recorded">†</sup>;}

function DetailPages({detail,busy,onPage,bottom=false}:{detail:EarningsView['detail'];busy:boolean;onPage:(page:number)=>void;bottom?:boolean}){
  return <nav className={styles.pagination} aria-label={bottom?'More sales detail pages':'Sales detail pages'}><button className="btn" disabled={busy||detail.page<=1} onClick={()=>onPage(detail.page-1)}>Previous sales</button><span>Page {detail.page} / {detail.pages} · {detail.total} matching sales</span><button className="btn" disabled={busy||detail.page>=detail.pages} onClick={()=>onPage(detail.page+1)}>Next sales</button></nav>;
}

function Stat({ label, value, sub, icon, accent }: { label: string; value: string; sub?: string; icon?: React.ReactNode; accent?: boolean }) {
  return (
    <div className="card" style={{ padding: 14, borderColor: accent ? "var(--accent)" : undefined }}>
      <div className="muted" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>{icon}{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: accent ? "var(--accent)" : undefined }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 10 }}>{sub}</div>}
    </div>
  );
}
function Mini({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>{icon}{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 10 }}>{sub}</div>}
    </div>
  );
}

// Dependency-free SVG bar chart: items sold per day/week/month in the cat-eye green.
// Zero buckets come pre-filled from the API so quiet days read as real gaps.
function SalesChart({ series }: { series: SalesSeries }) {
  const rows = series.points;
  const chart=useRef<SVGSVGElement|null>(null),[width,setWidth]=useState(760),hasRows=rows.length>0;
  useEffect(()=>{
    const element=chart.current;if(!element)return;
    const measure=()=>setWidth(Math.max(160,Math.floor(element.getBoundingClientRect().width)));
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[hasRows]);
  if (!rows.length) return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No data.</p>;
  const W = width, H = 190, bottom = 28;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const pad=Math.min(Math.max(32,String(max).length*7+10),W/3);
  const bw = (W - pad * 2) / rows.length;
  const innerH = H - bottom - 16;
  const y = (v: number) => H - bottom - (v / max) * innerH;
  const labelCount=Math.min(rows.length,Math.min(8,Math.max(2,Math.floor((W-pad*2)/80))));
  const labels=new Set(Array.from({length:labelCount},(_,i)=>labelCount===1?0:Math.round(i*(rows.length-1)/(labelCount-1))));
  const fmt = (dateKey: string, long = false) => {
    if (series.bucket === "month") return monthLabel(dateKey);
    const d = new Date(`${dateKey}T12:00:00`);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    if (series.bucket === "week") return long ? `week of ${md}` : `wk ${md}`;
    if (rows.length <= 7 || long) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${md}`;
    return md;
  };
  // integer y-gridlines (cap at 5 lines so big maxes stay clean)
  const step = Math.max(1, Math.ceil(max / 5));
  const grid: number[] = [];
  for (let v = step; v <= max; v += step) grid.push(v);
  return (
    <svg ref={chart} role="img" aria-label={`Items sold per ${series.bucket}`} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height:H }}>
      {grid.map((v) => (
        <g key={v}>
          <line x1={pad} y1={y(v)} x2={W - pad} y2={y(v)} stroke="var(--border)" strokeDasharray="3 5" />
          <text x={pad - 5} y={y(v) + 3} textAnchor="end" fontSize={12} fill="var(--muted)">{v}</text>
        </g>
      ))}
      <line x1={pad} y1={H - bottom} x2={W - pad} y2={H - bottom} stroke="var(--border)" />
      {rows.map((r, i) => {
        const x = pad + i * bw;
        const barW = Math.min(44, bw * 0.68);
        const cx = x + bw / 2;
        return (
          <g key={r.date}>
            {r.count > 0 && (
              <rect x={cx - barW / 2} y={y(r.count)} width={barW} height={H - bottom - y(r.count)} fill="var(--accent)" rx={3}>
                <title>{`${fmt(r.date, true)} — ${r.count} sold`}</title>
              </rect>
            )}
            {r.count > 0 && rows.length <= 31 && bw>=36 && (
              <text x={cx} y={y(r.count) - 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--accent)">{r.count}</text>
            )}
            {labels.has(i) && (
              <text x={cx} y={H - 7} textAnchor="middle" fontSize={12} fill="var(--muted)">{fmt(r.date)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
