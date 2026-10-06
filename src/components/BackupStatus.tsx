"use client";
import { useRef,useState } from "react";
import { ShieldCheck,Archive,RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { usePolledRead } from './usePolledRead';

interface BackupView { health:{lastError?:string|null}; latest:{name:string;createdAt:string}|null; count:number }
async function readBackups(signal:AbortSignal):Promise<BackupView> {
  const response=await fetch('/api/backups',{signal,cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Error(data?.error||'Could not read backup status.');
  if(!data?.health||typeof data.health!=='object'||Array.isArray(data.health)
    ||data.health.lastError!=null&&typeof data.health.lastError!=='string'
    ||!Number.isSafeInteger(data.count)||data.count<0
    ||(data.latest===null?data.count!==0:!data.latest||data.count===0||typeof data.latest.name!=='string'||!Number.isFinite(Date.parse(data.latest.createdAt))))
    throw Error('Backup status is incomplete. Refresh before creating or verifying a backup.');
  return data;
}
export function BackupStatus(){
  const view=usePolledRead(readBackups,null);
  const {data,error,load}=view;
  const [busy,setBusy]=useState(false),[actionError,setActionError]=useState<string|null>(null),[proof,setProof]=useState<string|null>(null);
  const running=useRef(false);
  async function run(action:'create'|'verify') {
    if(running.current||!view.isFresh()||(action==='verify'&&!data?.latest))return;
    running.current=true;setBusy(true);setProof(null);setActionError(null);view.invalidate();
    try {
      const response=await fetch('/api/backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
      const result=await response.json();
      if(action==='verify'&&result?.ok===false&&result.restoredToTemporaryCopy===true&&typeof result.integrity==='boolean'
        &&[result.foreignKeyViolations,result.missingPhotos,result.missingThumbnails].every(value=>Number.isSafeInteger(value)&&value>=0))
        throw Error(`Backup-copy check found ${result.missingPhotos} missing photos, ${result.missingThumbnails} missing thumbnails and ${result.foreignKeyViolations} broken database references.${result.integrity?'':' Database integrity failed.'} Live inventory was not replaced.`);
      if(!response.ok||result?.ok!==true)throw Error(result?.error||'The backup action could not be confirmed. Refresh its status before trying again.');
      if(action==='verify') {
        if(result.restoredToTemporaryCopy!==true||result.integrity!==true||result.foreignKeyViolations!==0||result.missingPhotos!==0||result.missingThumbnails!==0
          ||![result.items,result.photos].every(value=>Number.isSafeInteger(value)&&value>=0))
          throw Error('The backup-copy verification returned incomplete results. A successful restore check has not been confirmed.');
        setProof(`Temporary restore checked: ${result.items} items, ${result.photos} photos, all references present.`);
      } else toast.success('Backup created');
    }catch(error){setActionError(error instanceof Error?error.message:'The backup action could not be confirmed.');}
    finally{await load();running.current=false;setBusy(false);}
  }
  return <section className="card" style={{padding:22}} aria-label="Backup health"><h3 style={{display:'flex',gap:9,alignItems:'center',marginTop:0}}><ShieldCheck size={19}/> Backup & recovery</h3>
    <p>{data?.latest?`Latest database backup: ${new Date(data.latest.createdAt).toLocaleString()}`:data?'No database backups found.':error?'Backup status is unavailable.':'Checking backups…'}</p>
    <p className="muted" style={{fontSize:12}}>{data?`${data.count} backups available. `:''}Verification restores a temporary database copy and checks its records and photo references. It never replaces live inventory. Photos still need their own independent backup.</p>
    {data&&!view.fresh&&<p role="status">Showing the last loaded backup information until it can be refreshed.</p>}
    {(error||actionError||data?.health.lastError)&&<p role="alert" style={{color:'var(--warn)'}}>{error||actionError||data?.health.lastError}</p>}
    {proof&&<p role="status" style={{color:'var(--mint)'}}>{proof}</p>}
    <div style={{display:'flex',gap:10,flexWrap:'wrap'}}><button className="btn" disabled={busy} onClick={()=>void load()}>Refresh backup status</button><button className="btn" disabled={busy||!view.fresh} onClick={()=>void run('create')}><Archive size={16}/>{busy?'Working…':'Back up now'}</button><button className="btn" disabled={busy||!view.fresh||!data?.latest} onClick={()=>void run('verify')}><RefreshCw size={16}/> Verify a backup copy</button></div>
  </section>;
}
