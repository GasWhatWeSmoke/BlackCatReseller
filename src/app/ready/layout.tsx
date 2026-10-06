"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Share2, ArrowUpRight } from "lucide-react";
import styles from "./upload.module.css";

const tabs = [{ href: "/ready", label: "Queue & Auto Run" }, { href: "/ready/activity", label: "Run activity" },
  { href: "/ready/recovery", label: "Needs attention" },
  { href: "/ready/history", label: "Listing history" }];

export default function UploadLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <div className={styles.workspace}>
    <header className={styles.header}>
      <div><div className={styles.eyebrow}><Share2 size={15} /> ONE PIECE · EVERY MARKETPLACE</div>
        <h1>Crosslisting</h1><p className="muted">Process photos on the Dashboard. Review your pieces, then let Auto Run list them.</p></div>
      <Link className="btn" href="/">Add photos on Dashboard <ArrowUpRight size={15} /></Link>
    </header>
    <nav className={styles.tabs} aria-label="Crosslisting sections">
      {tabs.map(tab => <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? "page" : undefined}>{tab.label}</Link>)}
    </nav>
    {children}
    <footer className={styles.footer}>Manage marketplace connections and sale monitoring in <Link href="/settings#marketplaces">Settings</Link>.</footer>
  </div>;
}
