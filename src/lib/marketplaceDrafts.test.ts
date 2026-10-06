import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { updateSettingsRow } from './settingsStore.ts';
import { marketplaceForm, marketplaceDraftKey, makeMarketplaceDraft, parseMarketplaceDraft, marketplaceDraftConflicts,
  recoverMarketplaceDraft, marketplacePatch, checkMarketplaceExpectation } from './marketplaceDrafts.ts';
const workspace='C:/market-fixture';
const publish=()=>({ebayBrowser:{enabled:true,autoPost:true,shippingPolicyName:'Standard',returnPolicyName:'Returns',paymentPolicyName:'Payment',generalAdRate:null},
  etsy:{enabled:true,autoPost:false,shippingProfileName:'Parcel',autoRenew:false},
  mercari:{enabled:true,autoPost:false,unisexDepartment:'Women',shippingMode:'buyer_label',unlistedBrands:['Original']},
  depop:{enabled:true,autoPost:false,unlistedBrands:['Original'],boostListings:false},
  ebay:{clientSecret:'DO-NOT-STORE',refreshToken:'DO-NOT-STORE'}});
test('each form projects its own fields and never copies credentials or a companion brand list',()=>{
  const value=publish();
  assert.deepEqual(Object.keys(marketplaceForm('mercari',value)),['enabled','autoPost','unisexDepartment','shippingMode']);
  assert.equal(marketplaceForm('depopBrands',value).brands,'Original');
  for(const scope of ['ebayBrowser','etsy','mercari','depopBrands','mercariBrands'] as const){
    assert.ok(!JSON.stringify(marketplaceForm(scope,value)).includes('DO-NOT-STORE'));
    assert.throws(()=>marketplaceForm(scope,{}));
  }
  assert.throws(()=>marketplaceForm('ebayBrowser',{ebayBrowser:{...value.ebayBrowser,enabled:'true'}}));
});
test('local drafts bind workspace and section and retain the original comparison values',()=>{
  const original=marketplaceForm('ebayBrowser',publish());
  const draft=makeMarketplaceDraft(workspace,'ebayBrowser',original,{...original,shippingPolicyName:'Express'});
  assert.deepEqual(parseMarketplaceDraft(draft,workspace,'ebayBrowser'),draft);
  assert.notEqual(marketplaceDraftKey(workspace,'mercari'),marketplaceDraftKey(workspace,'mercariBrands'));
  assert.throws(()=>parseMarketplaceDraft(draft,'C:/other','ebayBrowser'));
  assert.throws(()=>parseMarketplaceDraft(draft,workspace,'etsy'));
  const current={...original,shippingPolicyName:'New saved policy'};
  const edited=makeMarketplaceDraft(workspace,'ebayBrowser',current,{...current,...draft.changes,returnPolicyName:'New return'},draft);
  assert.equal(edited.baseline.shippingPolicyName,'Standard');
  assert.deepEqual(marketplaceDraftConflicts(current,edited),['shippingPolicyName']);
});
test('trimmed policies and deduplicated brand replies reconcile a lost success response',()=>{
  const original=marketplaceForm('ebayBrowser',publish());
  const draft=makeMarketplaceDraft(workspace,'ebayBrowser',original,{...original,shippingPolicyName:' Express '});
  assert.deepEqual(recoverMarketplaceDraft({...original,shippingPolicyName:'Express'},draft)!.changes,{});
  const brands=marketplaceForm('mercariBrands',publish()),b=makeMarketplaceDraft(workspace,'mercariBrands',brands,{brands:' Nike\nNike\nAdidas\n'});
  assert.deepEqual(marketplacePatch(b).mercari,{unlistedBrands:['Nike','Adidas']});
  assert.deepEqual(recoverMarketplaceDraft({brands:'Nike\nAdidas'},b)!.changes,{});
  const clear=makeMarketplaceDraft(workspace,'mercariBrands',brands,{brands:''});
  assert.deepEqual(marketplacePatch(clear).mercari,{unlistedBrands:[]});
});
test('posting saves are sparse and cannot revoke a separately updated brand approval',()=>{
  const value=publish(),original=marketplaceForm('mercari',value);
  const draft=makeMarketplaceDraft(workspace,'mercari',original,{...original,shippingMode:'ship_on_own'});
  const body=marketplacePatch(draft);assert.deepEqual(body.mercari,{shippingMode:'ship_on_own'});
  value.mercari.unlistedBrands=['Newer approval'];
  assert.doesNotThrow(()=>checkMarketplaceExpectation(workspace,value,body));
  assert.doesNotThrow(()=>checkMarketplaceExpectation(workspace,value,{depop:{boostListings:false}}));
});
test('the existing write rejects stale values, workspace changes and mismatched comparisons',()=>{
  const value=publish(),original=marketplaceForm('ebayBrowser',value);
  const body=marketplacePatch(makeMarketplaceDraft(workspace,'ebayBrowser',original,{...original,shippingPolicyName:'Express'}));
  assert.doesNotThrow(()=>checkMarketplaceExpectation(workspace,value,body));
  assert.throws(()=>checkMarketplaceExpectation('C:/other',value,body),/workspace changed/);
  value.ebayBrowser.shippingPolicyName='Newer';assert.throws(()=>checkMarketplaceExpectation(workspace,value,body),/preferences changed/);
  for(const extra of [{...body,etsy:{enabled:true}},{...body,ebayBrowser:{shippingPolicyName:'Express',enabled:false}},
    {...body,ebayBrowser:{shippingPolicyName:3}},{marketplaceDraftExpectation:{workspace,scope:'ebay',values:{clientSecret:'bad'}},ebay:{clientSecret:'bad'}}])
    assert.throws(()=>checkMarketplaceExpectation(workspace,publish(),extra));
});
test('malformed local drafts cannot add credentials, wrong value types or foreign scopes',()=>{
  const saved=marketplaceForm('ebayBrowser',publish()),draft=makeMarketplaceDraft(workspace,'ebayBrowser',saved,{...saved,enabled:false});
  for(const broken of [{...draft,version:9},{...draft,baseline:{}},{...draft,changes:{enabled:'false'}},
    {...draft,baseline:{clientSecret:''},changes:{clientSecret:'bad'}},{...draft,workspace:'C:/other'}])
    assert.throws(()=>parseMarketplaceDraft(broken,workspace,'ebayBrowser'),/stored copy/);
});
test('comparison runs inside the settings CAS and rolls back stale preference writes',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-market-settings-')),file=path.join(folder,'test.db');fs.copyFileSync('config/template.db',file);
  const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));fs.rmSync(folder,{recursive:true,force:true});});
  const value=publish();await db.appSettings.create({data:{id:1,data:JSON.stringify({dataRoot:workspace,publish:value})}});
  const original=marketplaceForm('mercari',value),body=marketplacePatch(makeMarketplaceDraft(workspace,'mercari',original,{...original,shippingMode:'ship_on_own'}));
  await updateSettingsRow(db,raw=>{const s=JSON.parse(raw!);s.publish.mercari.unlistedBrands=['New'];return{data:JSON.stringify(s),value:s};});
  await updateSettingsRow(db,raw=>{const s=JSON.parse(raw!);checkMarketplaceExpectation(s.dataRoot,s.publish,body);s.publish.mercari={...s.publish.mercari,...body.mercari};return{data:JSON.stringify(s),value:s};});
  const before=(await db.appSettings.findUniqueOrThrow({where:{id:1}})).data;
  assert.deepEqual(JSON.parse(before).publish.mercari.unlistedBrands,['New']);
  await assert.rejects(updateSettingsRow(db,raw=>{const s=JSON.parse(raw!);checkMarketplaceExpectation(s.dataRoot,s.publish,body);throw Error('Must not reach mutation');}),/preferences changed/);
  assert.equal((await db.appSettings.findUniqueOrThrow({where:{id:1}})).data,before);
});
