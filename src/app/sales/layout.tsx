"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect,useState } from "react";
import { BadgeDollarSign } from "lucide-react";
import styles from "@/app/ready/upload.module.css";
export default function SalesLayout({ children }: { children:React.ReactNode }) {
  const pathname=usePathname();
  const [pending,setPending]=useState(0);
  useEffect(()=>{const load=()=>fetch('/api/sales/returns').then(r=>r.ok?r.json():null).then(data=>{if(data)setPending(data.pending);}).catch(()=>{});void load();const timer=setInterval(load,15000);return()=>clearInterval(timer);},[]);
  return <div className={styles.workspace}>
    <header className={styles.header}><div><div className={styles.eyebrow} style={{color:'var(--mint)'}}><BadgeDollarSign size={15}/> THE PAYOFF</div><h1>Sales</h1><p className="muted">Your sales, shipping queue, and earnings in one place.</p></div></header>
    <nav className={styles.tabs} aria-label="Sales sections">{[{href:'/sales',label:'Orders & shipping'},{href:'/sales/returns',label:`Returns${pending?` (${pending})`:''}`},{href:'/sales/insights',label:'Insights'}].map(tab=><Link key={tab.href} href={tab.href} aria-current={pathname===tab.href?'page':undefined}>{tab.label}</Link>)}</nav>
    {children}
  </div>;
}
