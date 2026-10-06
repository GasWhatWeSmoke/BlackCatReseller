"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { marketplaceDraftKey, marketplaceDraftNames, marketplaceForm, makeMarketplaceDraft, marketplaceDraftConflicts,
  marketplacePatch, readMarketplaceDraft, recoverMarketplaceDraft, writeMarketplaceDraft, MarketplaceDraftConflict,
  sameMarketplaceValue,
  type MarketplaceDraft, type MarketplaceDraftScope, type MarketplaceForms, type MarketplaceValues } from '@/lib/marketplaceDrafts';

interface Context {
  workspace:string; scope:MarketplaceDraftScope; saved:MarketplaceValues|null; form:MarketplaceValues|null;
  draft:MarketplaceDraft|null; revision:string|null; other:MarketplaceDraft|null|undefined;
  ready:boolean; readable:boolean; busy:boolean; writing:number; pending:Promise<void>;
  error:string|null; storageError:string|null; controller:AbortController;
}
const note=(error:unknown)=>error instanceof Error?error.message:'Marketplace preferences could not be confirmed.';
const WAIT_NOTICE='Wait for the current operation, or save these preferences before leaving.';
function clearWaitNotice(ctx:Context) {
  if(ctx.error===WAIT_NOTICE&&!ctx.busy&&!ctx.writing&&!ctx.storageError&&ctx.other===undefined)ctx.error=null;
}
export function useMarketplaceDraft<K extends MarketplaceDraftScope>(workspace:string,scope:K) {
  const active=useRef<Context|null>(null),[,render]=useState(0),[attempt,setAttempt]=useState(0);
  const redraw=useCallback((ctx:Context)=>{if(active.current===ctx)render(n=>n+1);},[]);
  const persist=useCallback((ctx:Context,draft:MarketplaceDraft)=>{
    ctx.draft=draft;
    if(!ctx.readable||ctx.other!==undefined){redraw(ctx);return;}
    ctx.writing++;
    ctx.pending=ctx.pending.then(async()=>{
      if(ctx.other!==undefined)return;
      try{const saved=await writeMarketplaceDraft(ctx.workspace,ctx.scope,draft,ctx.revision);ctx.revision=saved!.revision;
        if(ctx.draft===draft)ctx.draft=saved;ctx.storageError=null;
      }catch(error){ctx.storageError=note(error);if(error instanceof MarketplaceDraftConflict)ctx.other=error.latest;}
    }).finally(()=>{ctx.writing--;clearWaitNotice(ctx);redraw(ctx);});redraw(ctx);
  },[redraw]);
  const readSaved=useCallback(async(ctx:Context)=>{
    const r=await fetch('/api/publish/settings',{signal:ctx.controller.signal,cache:'no-store'}),body=await r.json();
    if(!r.ok)throw Error(body?.error||'Could not load marketplace preferences.');
    if(body.workspace!==ctx.workspace)throw Error('The workspace changed or could not be confirmed. Reload Settings before saving.');
    return marketplaceForm(ctx.scope,body.publish) as unknown as MarketplaceValues;
  },[]);
  const observe=useCallback((ctx:Context,saved:MarketplaceValues)=>{
    ctx.saved=saved;const previous=ctx.draft;ctx.draft=recoverMarketplaceDraft(saved,previous);
    ctx.form={...saved,...ctx.draft?.changes};
    if(previous&&JSON.stringify(previous)!==JSON.stringify(ctx.draft))persist(ctx,ctx.draft!);
    redraw(ctx);
  },[persist,redraw]);
  useEffect(()=>{
    const ctx:Context={workspace,scope,saved:null,form:null,draft:null,revision:null,other:undefined,ready:false,readable:false,
      busy:false,writing:0,pending:Promise.resolve(),error:null,storageError:null,controller:new AbortController()};
    active.current=ctx;redraw(ctx);
    void(async()=>{
      try{
        marketplaceDraftKey(workspace,scope);const saved=await readSaved(ctx);if(active.current!==ctx)return;
        ctx.saved=saved;ctx.form=saved;
        try{ctx.draft=await readMarketplaceDraft(workspace,scope);ctx.revision=ctx.draft?.revision??null;ctx.readable=true;}
        catch(error){ctx.storageError=`${note(error)} Automatic recovery is unavailable; stored drafts are kept.`;}
        if(active.current!==ctx)return;observe(ctx,saved);ctx.ready=true;
      }catch(error){if(!ctx.controller.signal.aborted)ctx.error=note(error);}
      redraw(ctx);
    })();
    return()=>{ctx.controller.abort();if(active.current===ctx)active.current=null;};
  },[workspace,scope,attempt,readSaved,observe,redraw]);
  useEffect(()=>{
    const unsafe=()=>{const ctx=active.current;return !!ctx&&(ctx.busy||ctx.writing>0||
      !!Object.keys(ctx.draft?.changes??{}).length&&(!!ctx.storageError||ctx.other!==undefined));};
    const unload=(event:BeforeUnloadEvent)=>{if(unsafe()){event.preventDefault();event.returnValue='';}};
    const navigation=(event:MouseEvent)=>{
      const link=(event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement|null;
      if(!link||link.target==='_blank'||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||!unsafe())return;
      event.preventDefault();event.stopPropagation();const ctx=active.current;
      if(ctx){ctx.error=WAIT_NOTICE;redraw(ctx);}
    };
    window.addEventListener('beforeunload',unload);document.addEventListener('click',navigation,true);
    return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('click',navigation,true);};
  },[redraw]);
  async function resolve(action:'discard'|'keepRecovered'|'keepMine'|'useOther') {
    const ctx=active.current;if(!ctx?.ready||ctx.busy||!ctx.saved||!ctx.form)return;
    ctx.busy=true;ctx.error=null;redraw(ctx);
    try{
      await ctx.pending;
      if(action==='keepMine'||action==='useOther'){
        const latest=await readMarketplaceDraft(ctx.workspace,ctx.scope);
        if(action==='keepMine'){
          ctx.draft=await writeMarketplaceDraft(ctx.workspace,ctx.scope,ctx.draft??makeMarketplaceDraft(ctx.workspace,ctx.scope,ctx.saved,ctx.form),latest?.revision??null);
          ctx.revision=ctx.draft!.revision;
        }else{ctx.draft=latest;ctx.revision=latest?.revision??null;}
        ctx.other=undefined;ctx.storageError=null;
        observe(ctx,await readSaved(ctx));
      }else if(ctx.other===undefined){
        if(action==='discard'){
          const saved=await readSaved(ctx);
          if(ctx.readable){await writeMarketplaceDraft(ctx.workspace,ctx.scope,null,ctx.revision);ctx.revision=null;ctx.storageError=null;}
          ctx.draft=null;ctx.saved=saved;ctx.form=saved;
        }else{
          // The owner must see any further change before rebasing the draft.
          const shown=ctx.saved,saved=await readSaved(ctx);
          if(Object.keys(ctx.draft?.changes??{}).some(field=>!sameMarketplaceValue(field,shown![field],saved[field]))){
            observe(ctx,saved);ctx.error='Saved preferences changed again. Review the current differences before keeping this draft.';return;
          }
          ctx.saved=saved;
          ctx.form={...saved,...ctx.draft?.changes};persist(ctx,makeMarketplaceDraft(ctx.workspace,ctx.scope,saved,ctx.form));
        }
      }
    }catch(error){ctx.error=note(error);if(error instanceof MarketplaceDraftConflict){ctx.other=error.latest;ctx.storageError=note(error);}}
    finally{ctx.busy=false;clearWaitNotice(ctx);redraw(ctx);}
  }
  async function save() {
    const ctx=active.current;if(!ctx?.ready||ctx.busy||!ctx.saved||!ctx.form)return;
    ctx.busy=true;ctx.error=null;redraw(ctx);
    try{
      await ctx.pending;
      if(ctx.readable){const latest=await readMarketplaceDraft(ctx.workspace,ctx.scope);if((latest?.revision??null)!==ctx.revision)throw new MarketplaceDraftConflict(latest);}
      if(ctx.other!==undefined)throw Error('Resolve the other window’s draft before saving.');
      observe(ctx,await readSaved(ctx));
      if(active.current!==ctx)throw Error('This settings workspace changed before saving.');
      if(marketplaceDraftConflicts(ctx.saved!,ctx.draft).length)throw Error('Saved preferences changed. Review the differences before saving.');
      const draft=ctx.draft??makeMarketplaceDraft(ctx.workspace,ctx.scope,ctx.saved!,ctx.form!);
      if(!Object.keys(draft.changes).length){toast.message(`${marketplaceDraftNames[scope]} are already saved`);return;}
      const r=await fetch('/api/publish/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(marketplacePatch(draft))});
      const body=await r.json();
      if(!r.ok){if(r.status===409)observe(ctx,await readSaved(ctx));throw Error(body?.error||'Saving preferences could not be confirmed.');}
      if(body.workspace!==ctx.workspace)throw Error('The saved workspace could not be confirmed. Reload Settings before another save.');
      const confirmed=marketplaceForm(ctx.scope,body.publish) as unknown as MarketplaceValues;
      if(Object.entries(draft.changes).some(([field,value])=>!sameMarketplaceValue(field,value,confirmed[field])))
        throw Error('The save response did not confirm the requested values. Your draft is kept; reload before another save.');
      ctx.saved=confirmed;ctx.form=confirmed;ctx.error=null;persist(ctx,makeMarketplaceDraft(ctx.workspace,ctx.scope,confirmed,confirmed));
      toast.success(`${marketplaceDraftNames[scope]} saved`);
    }catch(error){ctx.error=note(error);if(error instanceof MarketplaceDraftConflict){ctx.other=error.latest;ctx.storageError=note(error);}toast.error(ctx.error);}
    finally{ctx.busy=false;clearWaitNotice(ctx);redraw(ctx);}
  }
  const ctx=active.current,belongs=ctx?.workspace===workspace&&ctx.scope===scope;
  const current=belongs?ctx:null,conflicts=current?.saved?marketplaceDraftConflicts(current.saved,current.draft):[];
  return {scope,name:marketplaceDraftNames[scope],form:(current?.form??null) as MarketplaceForms[K]|null,saved:current?.saved??null,
    draft:current?.draft??null,error:current?.error??null,storageError:current?.storageError??null,
    ready:!!current?.ready,busy:!!current?.busy,writing:!!current?.writing,dirty:!!Object.keys(current?.draft?.changes??{}).length,
    otherWindow:current?.other!==undefined,conflicts,saveDisabled:!current?.ready||!!current.busy||current.other!==undefined||!!conflicts.length,
    reload:()=>setAttempt(n=>n+1),save,resolve,
    change(form:MarketplaceForms[K]){if(current?.ready&&!current.busy){current.form=form as unknown as MarketplaceValues;
      persist(current,makeMarketplaceDraft(workspace,scope,current.saved!,current.form,current.draft));}},
  };
}
export type MarketplaceRecovery = ReturnType<typeof useMarketplaceDraft>;
