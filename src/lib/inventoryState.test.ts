import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryState, inventoryStateFilter } from './inventoryState.ts';
import { stripRetiredSettings } from './types.ts';
import { applicableTo, missingMarketplaceWhere } from './publish/applicable.ts';

test('existing approved storage values display real marketplace state without changing history',()=>{
  const item={status:'Ready for Nifty',marketplaceListings:[{status:'published'}]};
  assert.equal(inventoryState(item),'Listed');
  assert.equal(item.status,'Ready for Nifty');
  assert.equal(inventoryState({...item,status:'Sold'}),'Sold');
  assert.equal(inventoryState({...item,status:'Archived'}),'Archived');
  assert.equal(inventoryState({status:'Ready for Nifty'}),'Ready');
  assert.equal(inventoryState({status:'Ready'}),'Ready');
  assert.equal(inventoryState({status:'Uploaded to Nifty'}),'Previously listed');
  assert.deepEqual(inventoryStateFilter('Ready'),{status:{in:['Ready','Ready for Nifty']},marketplaceListings:{none:{status:'published'}}});
});

test('non-vintage Etsy exclusions do not make completed inventory look unfinished',()=>{
  assert.equal(applicableTo({trueVintage:false},'etsy'),false);
  assert.equal(applicableTo({trueVintage:true},'etsy'),true);
  assert.equal(applicableTo({trueVintage:false},'ebay'),true);
  assert.deepEqual(missingMarketplaceWhere(['etsy']),{OR:[{trueVintage:true,marketplaceListings:{none:{marketplace:'etsy',status:'published'}}}]});
  assert.deepEqual(missingMarketplaceWhere([]),{id:{in:[]}});
});

test('retired integration settings are ignored while native posting preferences stay intact',()=>{
  const input={niftyUploadUrl:'https://retired.invalid',niftySelectors:{},syncEnabled:true,marketEnabled:true,depopBoost:false,
    publish:{depop:{enabled:true,boostListings:true}},mercariShipFrom:{zip:'01234'},publishAbortAfterConsecutiveFailures:5};
  const result=stripRetiredSettings(input);
  for(const field of ['niftyUploadUrl','niftySelectors','syncEnabled','marketEnabled','depopBoost'])assert.equal(field in result,false);
  assert.deepEqual(result.publish,input.publish);
  assert.deepEqual(result.mercariShipFrom,input.mercariShipFrom);
  assert.equal(result.publishAbortAfterConsecutiveFailures,5);
  assert.equal(input.syncEnabled,true);
});
