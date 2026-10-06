"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Search, Heart, BookmarkPlus } from "lucide-react";
import { toast } from "sonner";
import { researchQuery, researchLinks } from "@/lib/priceResearch";
import styles from "./PriceResearch.module.css";
type Comparable = { id: number; title: string; url: string; kind: "sold" | "active"; price: number; observedAt: string; interest: number | null; interestKind: string | null };
type Past = { id: number; sku: string; brand: string; itemType: string; size: string | null; salePrice: number; platformSold: string | null };
export function PriceResearch({ item, onPrice }: { item: { id: number; brand?: string | null; model?: string | null; itemType?: string | null; size?: string | null }; onPrice: (price: number) => void }) {
  const suggested = researchQuery(item);
  const [query, setQuery] = useState(suggested);
  const [data, setData] = useState<{ comparables: Comparable[]; past: Past[] }>({ comparables: [], past: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(""); const [title, setTitle] = useState(""); const [price, setPrice] = useState("");
  const [kind, setKind] = useState(""); const [interest, setInterest] = useState(""); const [interestKind, setInterestKind] = useState("watchers");
  useEffect(() => { setQuery(suggested); }, [suggested]);
  const load = useCallback(async () => {
    try { const response = await fetch(`/api/items/${item.id}/price-research?${new URLSearchParams({ brand: item.brand ?? "", itemType: item.itemType ?? "" })}`);
      if (!response.ok) throw new Error("Price references could not load."); setData(await response.json()); setError(null);
    } catch (error) { setError((error as Error).message); }
  }, [item.id, item.brand, item.itemType]);
  useEffect(() => { const timer = setTimeout(() => void load(), 350); return () => clearTimeout(timer); }, [load]);
  const links = researchLinks(query);
  async function readListing() {
    setBusy(true); setError(null);
    try { const response = await fetch("/api/research/listing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not inspect the listing");
      setTitle(result.title); setPrice(result.price == null ? "" : String(result.price));
      setKind(result.kind === "sold" || result.kind === "active" ? result.kind : "");
      setInterest(result.interest == null ? "" : String(result.interest)); setInterestKind("watchers");
      toast.message("Listing read. Confirm the price type and comparable details before saving.");
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try { const response = await fetch(`/api/items/${item.id}/price-research`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title, price: Number(price), kind, interest: interest === "" ? null : Number(interest), interestKind }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); await load(); toast.success("Comparable saved"); setUrl(""); setTitle(""); setPrice(""); setInterest(""); setKind("");
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <section className={styles.research} data-review-research aria-label="Price research">
    <header><Search size={18} /><h3>Price with evidence</h3><span>eBay first</span></header>
    <label className={styles.search}>Search for this item<input className="input" aria-label="Comparable search terms" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className={styles.links}><a className="btn" href={links.sold} target="_blank" rel="noreferrer">Sold listings <ExternalLink size={13} /></a><a className="btn" href={links.active} target="_blank" rel="noreferrer">Asking prices <ExternalLink size={13} /></a><a href={links.research} target="_blank" rel="noreferrer">eBay Product Research ↗</a></div>
    <p className="muted">Compare the actual brand, model, condition, and size. Asking prices and sold prices stay separate.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!!data.past.length && <div className={styles.comparables}><h4>Your past sales · same brand and type</h4>{data.past.map(row => <div key={row.id}><Link href={`/inventory/${row.id}`}>#{row.sku} · {row.itemType} {row.size}</Link><span>{row.platformSold ?? "Platform unrecorded"}</span><button className="btn" onClick={() => onPrice(row.salePrice)}>Use ${row.salePrice.toFixed(2)}</button></div>)}</div>}
    {!!data.comparables.length && <div className={styles.comparables}>{data.comparables.map(row => <article key={row.id}><span className={styles.kind} data-kind={row.kind}>{row.kind === "sold" ? "Sold price" : "Asking price"}</span><a href={row.url} target="_blank" rel="noreferrer">{row.title} ↗</a><div><strong>${row.price.toFixed(2)}</strong><span>{row.interest == null ? "Interest not reported" : `${row.interest} ${row.interestKind}`}</span><button className="btn" onClick={() => onPrice(row.price)}>Use price</button></div><small>Confirmed by you · {new Date(row.observedAt).toLocaleDateString()}</small></article>)}</div>}
    <details><summary><BookmarkPlus size={16} /> Save an actual comparable</summary><fieldset disabled={busy}>
      <label>Listing URL<input className="input" value={url} onChange={event => { setUrl(event.target.value); setTitle(""); setPrice(""); setKind(""); setInterest(""); }} placeholder="https://www.ebay.com/itm/…" /></label>
      <button className="btn" onClick={() => void readListing()} disabled={!url}>{busy ? "Working…" : "Read eBay listing"}</button>
      <label>Listing title<input className="input" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <div className={styles.pair}><label>Price shown · USD<input className="input" type="number" min="0.01" step="0.01" value={price} onChange={event => setPrice(event.target.value)} /></label><label>Price type<select className="select" value={kind} onChange={event => setKind(event.target.value)}><option value="">Choose price type</option><option value="active">Asking price</option><option value="sold">Verified sold price</option></select></label></div>
      <div className={styles.pair}><label>Visible interest · optional<input className="input" type="number" min="0" step="1" value={interest} onChange={event => setInterest(event.target.value)} /></label><label>Count type<select className="select" value={interestKind} onChange={event => setInterestKind(event.target.value)}><option value="watchers">Watchers</option><option value="likes">Likes</option></select></label></div>
      <p className="muted"><Heart size={12} /> Record interest only when shown. For an accepted offer, use <a href="https://www.ebay.com/help/selling/selling-tools/research?id=4853" target="_blank" rel="noreferrer">eBay Product Research</a> to check the actual sold amount.</p>
      <button className="btn" disabled={!kind || !title.trim() || !url.trim() || !Number.isFinite(Number(price)) || Number(price) <= 0} onClick={() => void save()}>Confirm & save comparable</button>
    </fieldset></details>
  </section>;
}
