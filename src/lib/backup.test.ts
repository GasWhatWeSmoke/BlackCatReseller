import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
import * as health from './backupHealth.ts';

const source=ts.transpileModule(fs.readFileSync(new URL('./backup.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText;
function loadBackup(settings:()=>Promise<unknown>,db:unknown,env:Record<string,string|undefined>={}) {
  const dependencies:Record<string,unknown>={'node:fs':fs,'node:path':path,'./db':{prisma:db},'./settings':{getRequiredSettings:settings},'./backupHealth':health};
  const context=vm.createContext({process:{env},console:{log:()=>{},warn:()=>{}}});
  const exports:Record<string,unknown>={};
  vm.compileFunction(source,['exports','require'],{parsingContext:context})(exports,(name:string)=>{
    assert.ok(name in dependencies,`Unexpected backup dependency ${name}`);return dependencies[name];
  });
  return exports.backupDatabase as (reason:string)=>Promise<string|null>;
}

test('unreadable backup settings cannot create a default backup or prune existing copies, and recovery uses the saved folder',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-backup-required-'));
  const database=path.join(root,'live.db');fs.copyFileSync('config/template.db',database);
  const db=new PrismaClient({datasources:{db:{url:`file:${database.replaceAll('\\','/')}`}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  await db.appSettings.create({data:{id:1,data:'{"preserve":"original"}'}});
  const folder=path.join(root,'saved-backups');fs.mkdirSync(folder);
  const old=path.join(folder,'black-cat-2000-01-01.db');fs.writeFileSync(old,'keep until a confirmed new backup');
  let unavailable=true,reads=0;
  const backup=loadBackup(async()=>{reads++;if(unavailable)throw Error('settings unavailable');return {dataRoot:root,backupsPath:folder,backupRetention:1};},db);
  assert.equal(await backup('manual'),null);
  assert.equal(reads,1);assert.deepEqual(fs.readdirSync(folder),[path.basename(old)]);
  assert.equal(fs.readFileSync(old,'utf8'),'keep until a confirmed new backup');
  assert.equal(fs.existsSync(path.join(root,'backup-health.json')),false);
  unavailable=false;
  const one=backup('manual'),two=backup('startup');assert.equal(one,two,'concurrent backup requests share the same work');
  const file=await one;assert.ok(file);assert.equal(path.dirname(file),folder);assert.equal(reads,2);
  assert.deepEqual(fs.readdirSync(folder),[path.basename(file)]);
  const copy=new PrismaClient({datasources:{db:{url:`file:${file.replaceAll('\\','/')}`}}});
  try {assert.equal((await copy.appSettings.findUniqueOrThrow({where:{id:1}})).data,'{"preserve":"original"}');}
  finally {await copy.$disconnect();}
  assert.equal((await db.appSettings.findUniqueOrThrow({where:{id:1}})).data,'{"preserve":"original"}');
  assert.equal(health.backupHealth(root).fileName,path.basename(file));
});

test('preview and production-build backup guards run before settings or database work',async()=>{
  for(const env of [{BLACKCAT_PREVIEW:'1'},{NEXT_PHASE:'phase-production-build'}]){
    let reads=0;
    const backup=loadBackup(async()=>{reads++;throw Error('must not read settings');},{},env);
    assert.equal(await backup('manual'),null);assert.equal(reads,0);
  }
});
