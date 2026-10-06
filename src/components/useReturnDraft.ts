"use client";
import { useEffect,useRef,useState } from 'react';
import { EMPTY_RETURN_INPUTS,readReturnDraft,returnDraftKey,ReturnDraftConflict,writeReturnDraft,type ReturnInputs } from '@/lib/returnDrafts';

interface Context { key:string; values:ReturnInputs; revision:string|null; pending:Promise<void>; ready:boolean; writing:number; error:string|null; conflict:boolean; active:boolean }
export function useReturnDraft(identity:string) {
  const current=useRef<Context|null>(null),[,redraw]=useState(0),[attempt,setAttempt]=useState(0);
  const refresh=(ctx:Context)=>{if(ctx.active)redraw(value=>value+1);};
  useEffect(()=>{
    const ctx:Context={key:returnDraftKey(identity),values:{...EMPTY_RETURN_INPUTS},revision:null,pending:Promise.resolve(),ready:false,writing:0,error:null,conflict:false,active:true};
    current.current=ctx;redraw(value=>value+1);
    void readReturnDraft(ctx.key).then(draft=>{ctx.values=draft?.values??{...EMPTY_RETURN_INPUTS};ctx.revision=draft?.revision??null;ctx.ready=true;refresh(ctx);})
      .catch(error=>{ctx.error=error instanceof Error?error.message:'Could not recover the local return draft.';refresh(ctx);});
    return()=>{ctx.active=false;};
  },[identity,attempt]);
  const ctx=current.current,belongs=ctx?.key===returnDraftKey(identity);
  const dirty=belongs&&Object.values(ctx.values).some(Boolean);
  const unsafe=!!dirty&&(!!ctx?.error||!!ctx?.writing||!!ctx?.conflict);
  useEffect(()=>{
    if(!unsafe)return;
    const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    const linkGuard=(event:MouseEvent)=>{if((event.target as Element)?.closest?.('a[href]')){event.preventDefault();event.stopPropagation();}};
    window.addEventListener('beforeunload',guard);document.addEventListener('click',linkGuard,true);
    return()=>{window.removeEventListener('beforeunload',guard);document.removeEventListener('click',linkGuard,true);};
  },[unsafe]);
  function persist(ctx:Context,values:ReturnInputs) {
    ctx.values=values;ctx.writing++;
    ctx.pending=ctx.pending.then(async()=>{
      if(ctx.conflict)return;
      try {const saved=await writeReturnDraft(ctx.key,values,ctx.revision);ctx.revision=saved.revision;ctx.error=null;}
      catch(error){ctx.error=error instanceof Error?error.message:'Could not keep this return draft.';ctx.conflict=error instanceof ReturnDraftConflict;}
    }).finally(()=>{ctx.writing--;refresh(ctx);});
    refresh(ctx);
  }
  return {
    values:belongs?ctx.values:EMPTY_RETURN_INPUTS,ready:!!belongs&&ctx.ready,error:belongs?ctx.error:null,
    writing:!!belongs&&ctx.writing>0,conflict:!!belongs&&ctx.conflict,canLeave:!unsafe,
    retry:()=>setAttempt(value=>value+1),
    change(patch:Partial<ReturnInputs>){const ctx=current.current;if(!ctx?.ready||ctx.conflict)return;persist(ctx,{...ctx.values,...patch});},
    async choose(keep:boolean){
      const ctx=current.current;if(!ctx)return;
      await ctx.pending;
      try {const latest=await readReturnDraft(ctx.key);ctx.revision=latest?.revision??null;ctx.conflict=false;persist(ctx,keep?ctx.values:latest?.values??{...EMPTY_RETURN_INPUTS});await ctx.pending;}
      catch(error){ctx.error=error instanceof Error?error.message:'Could not read the other draft.';refresh(ctx);}
    },
    async prepare(){
      const ctx=current.current;if(!ctx?.ready)throw Error('Wait for local draft recovery.');
      await ctx.pending;
      const latest=await readReturnDraft(ctx.key);
      if((latest?.revision??null)!==ctx.revision){ctx.conflict=true;ctx.error=new ReturnDraftConflict().message;refresh(ctx);}
      if(ctx.error||ctx.conflict)throw Error(ctx.error||'Review the local draft conflict first.');
      return {...ctx.values};
    },
    async clear(){const ctx=current.current;if(!ctx)return;await ctx.pending;persist(ctx,{...EMPTY_RETURN_INPUTS});await ctx.pending;},
  };
}
