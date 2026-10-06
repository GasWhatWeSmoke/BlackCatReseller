"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, Package, Share2, BadgeDollarSign, Settings, Volume2, VolumeX, ArrowUpRight, ListChecks, RefreshCw } from "lucide-react";
import { isMuted, toggleMuted, playSound, SOUND_CHANGED_EVENT } from "@/lib/sound";
import { SHIP_QUEUE_CHANGED, shippingCount } from "@/lib/shipQueue";
import { usePolledRead } from './usePolledRead';
import { CatMark } from "@/components/CatMark";
import styles from "./AppShell.module.css";

const links = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, tone: "lime", routes: ["/"] },
  { href: "/inventory", label: "Inventory", icon: Package, tone: "violet", routes: ["/inventory", "/review"] },
  { href: "/ready", label: "Crosslisting", icon: Share2, tone: "blue", routes: ["/ready", "/past-uploads", "/listings"] },
  { href: "/sales", label: "Sales", icon: BadgeDollarSign, tone: "mint", routes: ["/sales", "/earnings"] },
  { href: "/settings", label: "Settings", icon: Settings, tone: "neutral", routes: ["/settings", "/setup"] },
];

async function readShipping(signal: AbortSignal) {
  const response = await fetch('/api/ship-queue', { signal });
  const data = await response.json();
  if (!response.ok) throw Error(data?.error || 'The fulfillment count could not be refreshed.');
  return shippingCount(data);
}

export function Nav() {
  const pathname = usePathname();
  const [muted, setMuted] = useState(false);
  const shipping = usePolledRead(readShipping, 90000);
  const toShip = shipping.data?.count ?? null;
  const refreshShipping = shipping.load;
  useEffect(() => {
    setMuted(isMuted());
    const sync = () => setMuted(isMuted());
    window.addEventListener(SOUND_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SOUND_CHANGED_EVENT, sync);
  }, []);
  useEffect(() => {
    void refreshShipping(false);
  }, [pathname, refreshShipping]);
  useEffect(() => {
    const refresh = () => { void refreshShipping(); };
    window.addEventListener(SHIP_QUEUE_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener(SHIP_QUEUE_CHANGED, refresh); window.removeEventListener('focus', refresh); };
  }, [refreshShipping]);
  const shippingLabel = shipping.error
    ? `Sales, fulfillment count unavailable${toShip === null ? '' : `; last known ${toShip} items awaiting fulfillment`}`
    : toShip === null ? 'Sales, fulfillment count loading' : toShip > 0 ? `Sales, ${toShip} items awaiting fulfillment` : 'Sales';
  const shippingBadge = toShip === null ? shipping.error ? '?' : '…' : `${toShip > 999 ? '999+' : toShip}${shipping.error ? '?' : ''}`;
  const inventory = pathname.startsWith("/inventory") || pathname.startsWith("/review");
  return <aside className={styles.sidebar}>
    <Link className={styles.brand} href="/" aria-label="Black Cat home">
      <span className={styles.brandMark}><CatMark size={32} blink /></span>
      <span className={styles.brandName}>BLACK CAT<small>RESELLER WORKSPACE</small></span>
    </Link>
    <div className={styles.navLabel}>WORKSPACE</div>
    <nav className={styles.nav} aria-label="Main navigation">
      {links.map(({ href, label, icon: Icon, tone, routes }) => {
        const active = routes.some(route => route === "/" ? pathname === "/" : pathname.startsWith(route));
        return <Link key={href} href={href} className={styles.navLink} data-tone={tone} aria-label={href === '/sales' ? shippingLabel : label} aria-current={active ? pathname === href ? "page" : "location" : undefined} title={href === '/sales' ? shippingLabel : label}>
          <Icon size={20} /><span className={styles.navText}>{label}</span>
          {href === '/sales' && (toShip === null || toShip > 0 || shipping.error) && <span className={`${styles.count} ${shipping.error ? styles.countStale : ''}`} aria-hidden="true">{shippingBadge}</span>}
        </Link>;
      })}
      {shipping.error && <button className={styles.shippingRefresh} onClick={() => void refreshShipping()} disabled={shipping.refreshing} aria-label="Refresh fulfillment count" title={`${shippingLabel}. Refresh the recorded fulfillment count.`}>
        <RefreshCw size={16} aria-hidden="true" /><span className={styles.navText}>{shipping.refreshing ? 'Refreshing fulfillment…' : 'Refresh fulfillment count'}</span>
      </button>}
    </nav>
    {inventory && <nav className={styles.subnav} aria-label="Inventory navigation">
      <Link href="/inventory" className={styles.inventoryHome} aria-current={pathname === "/inventory" ? "page" : undefined}>All inventory</Link>
      <Link href="/review" aria-label="Review queue" title="Review queue" aria-current={pathname === "/review" ? "page" : undefined}><ListChecks size={18} /><span className={styles.subnavText}>Review queue</span></Link>
    </nav>}
    <Link href="/" className={styles.addPhotos}><span>Add your next batch</span><ArrowUpRight size={17} /></Link>
    <div className={styles.sidebarFooter}>
      <div className={styles.localBadge}><span /> Local workspace</div>
      <button className={styles.sound} data-sound="none" onClick={() => { const next = toggleMuted(); if (!next) playSound("click"); }} aria-label={muted ? "Turn interface sounds on" : "Turn interface sounds off"}>
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}<span>{muted ? "Sounds off" : "Sounds on"}</span>
      </button>
      <span className={styles.version}>Black Cat · v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"} · Beta</span>
    </div>
  </aside>;
}
