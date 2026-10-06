import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createSaleMonitor } from './saleMonitor.ts';
import { SALES_MARKETPLACES } from './salesProtocol.ts';

test('monitor service refuses unreadable settings, recovers the saved twice-daily cadence and respects pause',async()=>{
  let unavailable=true,enabled=true,scans=0,removals=0;
  const dependencies:Record<string,unknown>={
    '../db.ts':{prisma:{marketplaceListing:{findMany:async()=>[{marketplace:'depop'}]}}},
    '../settings.ts':{getRequiredSettings:async()=>{if(unavailable)throw Error('saved settings unavailable');return {dataRoot:'fixture',publish:{saleMonitorEnabled:enabled,saleMonitorChecksPerDay:2,depop:{enabled:true}}};}},
    './saleMonitor.ts':{createSaleMonitor},
    './salesPass.ts':{processSalesPass:async()=>{scans++;return {state:'checked',recorded:0};}},
    './removalQueue.ts':{processRemovalQueue:async()=>{removals++;return {busy:false};}},
    './salesProtocol.ts':{SALES_MARKETPLACES},
    './saleMonitorWindow.ts':{saleMonitorWindowOpen:()=>true},
  };
  const source=ts.transpileModule(fs.readFileSync(new URL('./saleMonitorService.ts',import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const exports:Record<string,unknown>={};
  vm.compileFunction(source,['exports','require'],{parsingContext:vm.createContext({})})(exports,(name:string)=>{
    assert.ok(name in dependencies,`Unexpected monitor dependency ${name}`);return dependencies[name];
  });
  const service=(exports.saleMonitorService as ()=>{monitor:ReturnType<typeof createSaleMonitor>})();
  assert.equal(await service.monitor.tick(true),false);
  assert.equal(service.monitor.snapshot().lastError,'saved settings unavailable');
  assert.equal(scans,0);assert.equal(removals,0);
  unavailable=false;assert.equal(await service.monitor.tick(true),true);
  const snapshot=service.monitor.snapshot();
  assert.equal(scans,1);assert.equal(removals,2);assert.equal(snapshot.lastError,null);
  assert.equal(Date.parse(snapshot.nextCheckAt!)-Date.parse(snapshot.lastFinishedAt!),12*60*60*1000);
  // Scheduled discovery stays twice daily while known removals can run between scans.
  assert.equal(await service.monitor.tick(),false);assert.equal(scans,1);assert.equal(removals,3);
  enabled=false;assert.equal(await service.monitor.tick(true),false);assert.equal(scans,1);assert.equal(removals,3);
});
