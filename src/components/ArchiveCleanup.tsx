"use client";
import { useEffect,useRef,useState } from 'react';
import { Archive } from 'lucide-react';
import { toast } from 'sonner';
import { archivePreview,archiveResult,type ArchivePreview,type ArchiveResult } from '@/lib/archiveCleanupView';

export function ArchiveCleanup({savedPath,settingsKey,dirty}:{savedPath:string;settingsKey:string;dirty:boolean}){
  const [preview,setPreview]=useState<ArchivePreview|null>(null),[result,setResult]=useState<ArchiveResult|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<'preview'|'apply'|null>(null);
  const working=useRef(false),generation=useRef(0),alive=useRef(true),controller=useRef<AbortController|null>(null),review=useRef<ArchivePreview|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;controller.current?.abort();};},[]);
  useEffect(()=>{generation.current++;review.current=null;setPreview(null);setResult(null);setError(null);controller.current?.abort();},[settingsKey,dirty]);
  useEffect(()=>{if(busy!=='apply')return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[busy]);
  async function inspect(){
    if(working.current||dirty)return;working.current=true;setBusy('preview');setError(null);setResult(null);setPreview(null);review.current=null;
    const version=++generation.current,request=new AbortController();controller.current=request;
    try{
      const response=await fetch('/api/maintenance/clear-archive',{method:'POST',headers:{'Content-Type':'application/json'},signal:request.signal,body:JSON.stringify({action:'preview',expectedArchivePath:savedPath})});
      const data=await response.json();if(!response.ok)throw Error(data?.error||'Could not review the archive.');
      const confirmed=archivePreview(data);if(confirmed.requestedPath!==savedPath)throw Error('The archive preview does not match the saved location. Review it again.');if(!alive.current||version!==generation.current)return;
      review.current=confirmed;setPreview(confirmed);
    }catch(error){if(alive.current&&version===generation.current&&!request.signal.aborted)setError(error instanceof Error?error.message:'Could not review the archive.');}
    finally{working.current=false;if(alive.current)setBusy(null);}
  }
  async function apply(){
    const plan=review.current;if(working.current||dirty||!plan?.files)return;
    working.current=true;
    try{if(!window.confirm(`Permanently delete ${plan.files} unreferenced JPEG, PNG or WebP files from:\n\n${plan.path}\n\nProtected, linked and unsupported entries are kept. Deleted originals cannot be recovered from this archive. This cannot be undone.`)){working.current=false;return;}}
    catch{working.current=false;setError('The confirmation could not open. No cleanup was requested.');return;}
    review.current=null;setPreview(null);setBusy('apply');setError(null);setResult(null);
    const notice=toast.loading('Removing reviewed archive photos…');
    try{
      const response=await fetch('/api/maintenance/clear-archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'apply',expectedArchivePath:savedPath,token:plan.token})});
      const data=await response.json();if(!response.ok)throw Error(data?.error||'Archive cleanup could not be confirmed.');
      const confirmed=archiveResult(data,plan);if(alive.current)setResult(confirmed);
      const message=`Archive cleanup: ${confirmed.removed} photos removed, ${confirmed.changed} changed files kept, ${confirmed.missing} already absent, ${confirmed.failed} failed or unconfirmed.`;
      if(confirmed.failed)toast.warning(message,{id:notice,duration:10000});else toast.success(message,{id:notice});
    }catch(error){const message=error instanceof Error?error.message:'Archive cleanup could not be confirmed. Review the remaining files before retrying.';if(alive.current)setError(message);toast.error(message,{id:notice,duration:10000});}
    finally{working.current=false;if(alive.current)setBusy(null);}
  }
  return <section aria-label="Archive photo cleanup" style={{minWidth:0,fontSize:13}}>
    <p className="muted" style={{overflowWrap:'anywhere'}}>Saved archive: <strong>{savedPath||'Not configured'}</strong></p>
    <p className="muted">Review unreferenced JPEG, PNG and WebP originals before deleting them. Other file types, linked entries and files used by inventory or unresolved work are kept.</p>
    {dirty&&<p role="status">Save your folder preferences before reviewing archive cleanup.</p>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button className="btn" disabled={!!busy||dirty||!savedPath} onClick={()=>void inspect()}><Archive size={15}/>{busy==='preview'?'Reviewing archive…':'Review archive cleanup'}</button>
      {!!preview?.files&&<button className="btn btn-danger" disabled={!!busy||dirty} onClick={()=>void apply()}>Delete {preview.files} reviewed archive files</button>}</div>
    {busy==='apply'&&<p role="status">Removing only the reviewed archive photos…</p>}
    {error&&<p role="alert" style={{color:'var(--warn)',overflowWrap:'anywhere'}}>{error}</p>}
    {preview&&<div style={{marginTop:12}}><p>{preview.files} removable photo files · {(preview.bytes/1048576).toFixed(1)} MB of files · {preview.retained} protected or unsupported entries kept.</p>
      {preview.missing&&<p>The saved archive folder does not exist. There is nothing to remove.</p>}
      {preview.examples.length>0&&<details><summary>Previewed files{preview.files>preview.examples.length?' (first 20)':''}</summary><ul>{preview.examples.map(file=><li key={file} style={{overflowWrap:'anywhere'}}>{file}</li>)}</ul></details>}
      {preview.retainedExamples.length>0&&<details><summary>Entries that will be kept{preview.retained>preview.retainedExamples.length?' (first 20)':''}</summary><ul>{preview.retainedExamples.map(row=><li key={row.path} style={{overflowWrap:'anywhere'}}>{row.path}: {row.reason}</li>)}</ul></details>}
    </div>}
    {result&&<div role="status"><p style={{overflowWrap:'anywhere'}}>Cleanup location: {result.path}</p><p>Confirmed removed: {result.removed} photo files. Already absent: {result.missing}. Changed and kept: {result.changed}. Failed or unconfirmed removals: {result.failed}. Protected or unsupported entries kept: {result.retained}.</p>
      {!!result.notes.length&&<ul>{result.notes.map(row=><li key={row.path} style={{overflowWrap:'anywhere'}}>{row.path}: {row.reason}</li>)}</ul>}
      <p>Review the archive again to see what remains.</p></div>}
  </section>;
}
