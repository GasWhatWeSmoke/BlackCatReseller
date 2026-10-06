"use client";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Check } from "lucide-react";
export function AiSuggestions({ itemId, photoIds, current, onApply }: { itemId:number;photoIds:number[];current:Record<string,unknown>;onApply:(field:string,value:string)=>void }) {
  const [rows,setRows]=useState<{field:string;value:string}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  async function check(){
    if(busy)return;setBusy(true);setError(null);controller.current=new AbortController();
    try{const response=await fetch(`/api/items/${itemId}/ai-suggestions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({photoIds}),signal:controller.current.signal});const data=await response.json();if(!response.ok)throw Error(data.error);setRows(data.suggestions??[]);}
    catch(error){if((error as Error).name!=="AbortError")setError((error as Error).message);}finally{setBusy(false);}
  }
  return <section className="card" style={{padding:16}} aria-label="AI suggestions">
    <button className="btn" disabled={busy||!photoIds.length} onClick={()=>void check()}><Sparkles size={16}/>{busy?"Reading the selected photos…":"Recheck label & garment"}</button>
    <p className="muted" style={{fontSize:12,lineHeight:1.6}}>Select a clear label photo above. AI checks that photo and the cover together; you choose which suggestions to use.</p>
    {error&&<p role="alert" style={{color:"var(--warn)",fontSize:12}}>{error}</p>}
    {rows.length>0&&<div style={{display:"grid",gap:8}}>{rows.map(row=><div key={row.field} style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}><span style={{minWidth:75,color:"var(--muted)"}}>{row.field}</span><strong style={{flex:1}}>{row.value}</strong><button className="btn" disabled={current[row.field]===row.value} onClick={()=>onApply(row.field,row.value)}>{current[row.field]===row.value?<Check size={14}/>:"Use"}</button></div>)}</div>}
  </section>;
}
