import { localDraftDatabase } from './itemDrafts.ts';

export interface MarketplaceForms {
  ebayBrowser: { enabled: boolean; autoPost: boolean; shippingPolicyName: string; returnPolicyName: string; paymentPolicyName: string; generalAdRate: number | null };
  etsy: { enabled: boolean; autoPost: boolean; shippingProfileName: string; autoRenew: boolean };
  mercari: { enabled: boolean; autoPost: boolean; unisexDepartment: 'Men' | 'Women'; shippingMode: 'buyer_label' | 'ship_on_own' };
  depopBrands: { brands: string };
  mercariBrands: { brands: string };
}
export type MarketplaceDraftScope = keyof MarketplaceForms;
export type MarketplaceValue = string | number | boolean | null;
export type MarketplaceValues = Record<string, MarketplaceValue>;
const fields = {
  ebayBrowser: ['enabled','autoPost','shippingPolicyName','returnPolicyName','paymentPolicyName','generalAdRate'],
  etsy: ['enabled','autoPost','shippingProfileName','autoRenew'],
  mercari: ['enabled','autoPost','unisexDepartment','shippingMode'],
  depopBrands: ['brands'], mercariBrands: ['brands'],
} satisfies Record<MarketplaceDraftScope, string[]>;
export const marketplaceDraftNames: Record<MarketplaceDraftScope, string> = {
  ebayBrowser: 'eBay settings', etsy: 'Etsy settings', mercari: 'Mercari settings',
  depopBrands: 'Depop brand preferences', mercariBrands: 'Mercari brand preferences',
};
export const marketplaceDraftLabels: Record<string, string> = { enabled:'Posting enabled', autoPost:'Publish after filling',
  shippingPolicyName:'Shipping policy', returnPolicyName:'Return policy', paymentPolicyName:'Payment policy',
  generalAdRate:'General promotion rate', shippingProfileName:'Shipping profile', autoRenew:'Automatic renewal',
  unisexDepartment:'Unisex department', shippingMode:'Shipping method', brands:'Brands allowed to use Other' };
const scopeValid = (value: unknown): value is MarketplaceDraftScope => typeof value === 'string' && Object.hasOwn(fields, value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const brandList = (value: string) => [...new Set(value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))];
function validValue(scope: MarketplaceDraftScope, field: string, value: unknown): value is MarketplaceValue {
  if (!fields[scope].includes(field)) return false;
  if (['enabled','autoPost','autoRenew'].includes(field)) return typeof value === 'boolean';
  if (field === 'generalAdRate') return value === null || typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (field === 'unisexDepartment') return ['Men','Women'].includes(value);
  if (field === 'shippingMode') return ['buyer_label','ship_on_own'].includes(value);
  return value.length <= (field === 'brands' ? 100_000 : 200);
}
function canonical(field: string, value: MarketplaceValue) {
  return field === 'brands' ? JSON.stringify(brandList(String(value))) : typeof value === 'string' ? value.trim() : value;
}
export const sameMarketplaceValue = (field: string, a: MarketplaceValue, b: MarketplaceValue) => canonical(field,a) === canonical(field,b);
export function marketplaceDraftKey(workspace: string, scope: MarketplaceDraftScope) {
  if (typeof workspace !== 'string' || !workspace.trim() || !scopeValid(scope)) throw Error('The settings workspace could not be confirmed. Reload Settings.');
  return `market-preferences:v1:${encodeURIComponent(workspace)}:${scope}`;
}
export function marketplaceForm<K extends MarketplaceDraftScope>(scope: K, publish: unknown): MarketplaceForms[K] {
  if (!scopeValid(scope) || !object(publish)) throw Error('Saved marketplace preferences could not be confirmed.');
  const group = scope === 'depopBrands' ? 'depop' : scope === 'mercariBrands' ? 'mercari' : scope;
  const raw = publish[group];
  if (!object(raw)) throw Error('Saved marketplace preferences could not be confirmed.');
  let source: Record<string, unknown> = raw;
  if (scope.endsWith('Brands')) {
    if (!Array.isArray(raw.unlistedBrands) || raw.unlistedBrands.some(v=>typeof v !== 'string')) throw Error('Saved brand preferences could not be confirmed.');
    source = { brands: raw.unlistedBrands.join('\n') };
  }
  const result: MarketplaceValues = {};
  for (const field of fields[scope]) {
    if (!validValue(scope,field,source[field])) throw Error('Saved marketplace preferences are incomplete. Reload before editing.');
    result[field] = source[field];
  }
  // Projection is deliberate: another panel's values and legacy credentials must
  // never enter this form, its local draft, or a later save.
  return result as unknown as MarketplaceForms[K];
}
export interface MarketplaceDraft {
  key: string; version: 1; workspace: string; scope: MarketplaceDraftScope; revision: string; savedAt: number;
  baseline: MarketplaceValues; changes: MarketplaceValues;
}
export function makeMarketplaceDraft(workspace: string, scope: MarketplaceDraftScope, saved: MarketplaceValues, form: MarketplaceValues, prior: MarketplaceDraft | null = null): MarketplaceDraft {
  const key = marketplaceDraftKey(workspace,scope);
  if (prior && prior.key !== key) throw Error('This draft belongs to a different workspace.');
  const changes: MarketplaceValues = {}, baseline: MarketplaceValues = {};
  for (const field of fields[scope]) if (!sameMarketplaceValue(field,saved[field],form[field])) {
    changes[field] = form[field]; baseline[field] = prior && Object.hasOwn(prior.changes,field) ? prior.baseline[field] : saved[field];
  }
  return { key, version:1, workspace, scope, revision:prior?.revision ?? '', savedAt:Date.now(), baseline, changes };
}
export function parseMarketplaceDraft(value: unknown, workspace: string, scope: MarketplaceDraftScope): MarketplaceDraft | null {
  if (value == null) return null;
  const d = value as MarketplaceDraft;
  if (!object(d) || d.key !== marketplaceDraftKey(workspace,scope) || d.workspace !== workspace || d.scope !== scope || d.version !== 1
    || typeof d.revision !== 'string' || !Number.isFinite(d.savedAt) || !object(d.baseline) || !object(d.changes)
    || Object.keys(d.baseline).length !== Object.keys(d.changes).length
    || ![d.baseline,d.changes].every(values=>Object.entries(values).every(([field,v])=>validValue(scope,field,v)))
    || Object.keys(d.changes).some(field=>!Object.hasOwn(d.baseline,field))) throw Error('This local marketplace draft could not be read. Its stored copy has been kept.');
  return d;
}
export function marketplaceDraftConflicts(saved: MarketplaceValues, draft: MarketplaceDraft | null) {
  return Object.keys(draft?.changes ?? {}).filter(field=>!sameMarketplaceValue(field,saved[field],draft!.baseline[field])
    && !sameMarketplaceValue(field,saved[field],draft!.changes[field]));
}
export function recoverMarketplaceDraft(saved: MarketplaceValues, draft: MarketplaceDraft | null) {
  if (!draft) return null;
  const keys=Object.keys(draft.changes).filter(field=>!sameMarketplaceValue(field,saved[field],draft.changes[field]));
  return {...draft,baseline:Object.fromEntries(keys.map(k=>[k,draft.baseline[k]])),changes:Object.fromEntries(keys.map(k=>[k,draft.changes[k]]))};
}
export function marketplacePatch(draft: MarketplaceDraft) {
  const group=draft.scope==='depopBrands'?'depop':draft.scope==='mercariBrands'?'mercari':draft.scope;
  const patch=Object.fromEntries(Object.entries(draft.changes).map(([field,value])=>field==='brands'
    ? ['unlistedBrands',brandList(String(value))] : [field,typeof value==='string'?value.trim():value]));
  return { [group]:patch, marketplaceDraftExpectation:{workspace:draft.workspace,scope:draft.scope,values:draft.baseline} };
}
export class MarketplacePreferencesConflict extends Error {}
/** Called inside the existing settings transaction; stale forms cannot change a
 * new workspace or silently replace a later edit to the same preference. */
export function checkMarketplaceExpectation(workspace: string, publish: unknown, body: Record<string, unknown>) {
  if (!Object.hasOwn(body,'marketplaceDraftExpectation')) return;
  const expected=body.marketplaceDraftExpectation;
  if (!object(expected) || typeof expected.workspace!=='string' || !scopeValid(expected.scope) || !object(expected.values)
    || !Object.keys(expected.values).length) throw new MarketplacePreferencesConflict('The marketplace preference comparison is incomplete. Reload Settings.');
  const scope=expected.scope, group=scope==='depopBrands'?'depop':scope==='mercariBrands'?'mercari':scope;
  if (workspace!==expected.workspace) throw new MarketplacePreferencesConflict('The workspace changed. Reload Settings before saving.');
  const patch=body[group];
  if (!object(patch) || Object.keys(body).some(k=>k!==group&&k!=='marketplaceDraftExpectation')
    || Object.keys(patch).length!==Object.keys(expected.values).length
    || Object.entries(expected.values).some(([field,value])=>{
      const wire=field==='brands'?'unlistedBrands':field;
      return !validValue(scope,field,value)||!Object.hasOwn(patch,wire)||(field==='brands'
        ? !Array.isArray(patch.unlistedBrands)||patch.unlistedBrands.some(v=>typeof v!=='string') : !validValue(scope,field,patch[field]));
    }))
    throw new MarketplacePreferencesConflict('The marketplace preference comparison does not match this change. Reload Settings.');
  const current=marketplaceForm(scope,publish) as unknown as MarketplaceValues;
  if (Object.entries(expected.values).some(([field,value])=>!sameMarketplaceValue(field,current[field],value as MarketplaceValue)))
    throw new MarketplacePreferencesConflict('Saved marketplace preferences changed. Reload and review your draft before saving.');
}
export class MarketplaceDraftConflict extends Error {
  latest: MarketplaceDraft | null;
  constructor(latest: MarketplaceDraft | null) { super('Another window changed this marketplace draft. Choose which edits to keep.'); this.latest=latest; }
}
export async function readMarketplaceDraft(workspace: string, scope: MarketplaceDraftScope): Promise<MarketplaceDraft|null> {
  const db=await localDraftDatabase();
  return new Promise((resolve,reject)=>{const r=db.transaction('drafts','readonly').objectStore('drafts').get(marketplaceDraftKey(workspace,scope));
    r.onsuccess=()=>{try{resolve(parseMarketplaceDraft(r.result,workspace,scope));}catch(e){reject(e);}};r.onerror=()=>reject(Error('Local marketplace draft recovery is unavailable.'));});
}
export async function writeMarketplaceDraft(workspace:string,scope:MarketplaceDraftScope,value:MarketplaceDraft|null,revision:string|null):Promise<MarketplaceDraft|null> {
  const db=await localDraftDatabase();
  return new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite',{durability:'strict'}),store=tx.objectStore('drafts');let next:MarketplaceDraft|null=null,failure:unknown;
    const r=store.get(marketplaceDraftKey(workspace,scope));r.onsuccess=()=>{try{
      const current=parseMarketplaceDraft(r.result,workspace,scope);if((current?.revision??null)!==revision)throw new MarketplaceDraftConflict(current);
      next=value?{...value,revision:crypto.randomUUID(),savedAt:Date.now()}:null;
      if(next){parseMarketplaceDraft(next,workspace,scope);store.put(next);}else store.delete(marketplaceDraftKey(workspace,scope));
    }catch(e){failure=e;tx.abort();}};
    tx.oncomplete=()=>resolve(next);tx.onabort=()=>reject(failure??Error('The marketplace draft could not be kept on this device. Save before leaving.'));tx.onerror=()=>{};
  });
}
