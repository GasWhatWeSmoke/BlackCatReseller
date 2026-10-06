import { localDraftDatabase } from './itemDrafts.ts';

export interface ReturnInputs { refund:boolean; received:boolean; fees:string; postage:string }
export interface ReturnDraft { version:1; key:string; revision:string; values:ReturnInputs }
export const EMPTY_RETURN_INPUTS:ReturnInputs={refund:false,received:false,fees:'',postage:''};
export function returnDraftKey(identity:string):string {return `return-review:${identity}`;}
function parse(value:unknown,key:string):ReturnDraft|null {
  if(value==null)return null;
  const draft=value as ReturnDraft;
  if(draft.version!==1||draft.key!==key||typeof draft.revision!=='string'||!draft.values
    ||typeof draft.values.refund!=='boolean'||typeof draft.values.received!=='boolean'
    ||[draft.values.fees,draft.values.postage].some(value=>typeof value!=='string'||value.length>40))
    throw Error('This return draft could not be read. Its stored copy has been kept.');
  return draft;
}
export class ReturnDraftConflict extends Error {
  constructor(){super('Another window changed this return draft. Choose which inputs to keep before continuing.');}
}
export async function readReturnDraft(key:string):Promise<ReturnDraft|null> {
  const db=await localDraftDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('drafts','readonly').objectStore('drafts').get(key);
    request.onsuccess=()=>{try{resolve(parse(request.result,key));}catch(error){reject(error);}};
    request.onerror=()=>reject(Error('The local return draft could not be read.'));
  });
}
export async function writeReturnDraft(key:string,values:ReturnInputs,revision:string|null):Promise<ReturnDraft> {
  const db=await localDraftDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('drafts','readwrite',{durability:'strict'}),store=tx.objectStore('drafts');
    let next:ReturnDraft,failure:unknown;
    const request=store.get(key);
    request.onsuccess=()=>{
      try {
        const current=parse(request.result,key);
        if((current?.revision??null)!==revision)throw new ReturnDraftConflict();
        next={version:1,key,revision:crypto.randomUUID(),values:{...values}};parse(next,key);store.put(next);
      }catch(error){failure=error;tx.abort();}
    };
    tx.oncomplete=()=>resolve(next);
    tx.onabort=()=>reject(failure??Error('Your return inputs could not be kept on this device. Keep this page open.'));
    tx.onerror=()=>{};
  });
}
