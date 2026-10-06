import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { readSchema } from './schema-manifest.mjs';
import { planSchemaSync,reconcileSchema,validateSchemaManifest } from './schema-sync.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const original='CREATE TABLE "Item" ("id" INTEGER NOT NULL PRIMARY KEY, "sku" TEXT NOT NULL);';
const wanted='CREATE TABLE "Item" ("id" INTEGER NOT NULL PRIMARY KEY, "sku" TEXT NOT NULL, "notes" TEXT, "quantity" INTEGER NOT NULL DEFAULT 0);';

function create(file,sql){const db=new DatabaseSync(file);try{db.exec(sql);}finally{db.close();}}
async function fixture(t,liveSql=original,expectedSql=wanted){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-schema-regression-')),file=path.join(root,'live.db'),expectedFile=path.join(root,'expected.db');
  create(file,liveSql);create(expectedFile,expectedSql);
  const db=new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')}}});
  t.after(async()=>{await db.$disconnect();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('blackcat-schema-regression-'));fs.rmSync(root,{recursive:true,force:true});});
  const messages=[],logger={log:value=>messages.push(value),error:value=>messages.push(value)};
  return {db,file,root,expected:readSchema(expectedFile),logger,messages};
}

test('existing definition drift blocks all additive work and preserves the database',async t=>{
  const fixtureData=await fixture(t,'CREATE TABLE "Item" ("id" TEXT, "sku" TEXT DEFAULT \'old\'); CREATE INDEX "sku_idx" ON "Item"("id");',
    'CREATE TABLE "Item" ("id" INTEGER NOT NULL PRIMARY KEY, "sku" TEXT NOT NULL DEFAULT \'new\', "notes" TEXT); CREATE UNIQUE INDEX "sku_idx" ON "Item"("sku"); CREATE INDEX "notes_idx" ON "Item"("notes");');
  const {db,file,expected,logger,messages}=fixtureData,before=fs.readFileSync(file),plan=planSchemaSync(expected,readSchema(file));
  assert.ok(plan.drift.some(row=>row.column==='id'&&row.reason.includes('declared type')&&row.reason.includes('primary-key')));
  assert.ok(plan.drift.some(row=>row.column==='sku'&&row.reason.includes('default')));
  assert.ok(plan.drift.some(row=>row.index==='sku_idx'&&row.reason.includes('differs')));
  assert.ok(plan.drift.some(row=>row.index==='notes_idx'&&row.reason.includes('missing')));
  assert.equal(await reconcileSchema(db,expected,{logger}),2);
  assert.deepEqual(fs.readFileSync(file),before);assert.ok(messages.some(row=>row.includes('no schema changes applied')));assert.ok(!messages.some(row=>row.includes('schema-sync: applied')));
});

test('dry-run is read-only and successful additions preserve existing values and replay cleanly',async t=>{
  const {db,file,expected,logger,messages}=await fixture(t,original+"INSERT INTO Item VALUES (1,'fixture value');");
  const before=fs.readFileSync(file);assert.equal(await reconcileSchema(db,expected,{dryRun:true,logger}),0);
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(messages.filter(row=>row.includes('WOULD RUN')).length,2);
  messages.length=0;assert.equal(await reconcileSchema(db,expected,{logger}),0);assert.equal(messages.filter(row=>row.includes('schema-sync: applied')).length,2);
  assert.deepEqual(await db.$queryRawUnsafe('SELECT id,sku,notes,quantity FROM Item'),[{id:1,sku:'fixture value',notes:null,quantity:0}]);
  const after=fs.readFileSync(file);messages.length=0;assert.equal(await reconcileSchema(db,expected,{logger}),0);
  assert.deepEqual(fs.readFileSync(file),after);assert.equal(messages.filter(row=>row.includes('schema-sync: applied')).length,0);
});

test('an execution failure rolls back prior schema steps without reporting them as applied',async t=>{
  const {db,file,expected,logger,messages}=await fixture(t,original+"INSERT INTO Item VALUES (1,'preserved');");
  const before=readSchema(file);let writes=0;
  const failing={$queryRawUnsafe:(...args)=>db.$queryRawUnsafe(...args),$transaction:fn=>db.$transaction(tx=>fn({$queryRawUnsafe:(...args)=>tx.$queryRawUnsafe(...args),$executeRawUnsafe:(...args)=>{
    if(++writes===2)throw Error('Injected second statement failure');return tx.$executeRawUnsafe(...args);
  }}))};
  await assert.rejects(reconcileSchema(failing,expected,{logger}),/Injected second/);
  assert.equal(writes,2);assert.deepEqual(readSchema(file),before);assert.deepEqual(await db.$queryRawUnsafe('SELECT * FROM Item'),[{id:1,sku:'preserved'}]);
  assert.ok(!messages.some(row=>row.includes('schema-sync: applied')));
});

test('new tables retain their indexes while unsupported new column constraints require review',async t=>{
  const {db,file,expected,logger}=await fixture(t,original,original+'CREATE TABLE "Receipt" ("id" INTEGER NOT NULL PRIMARY KEY,"reference" TEXT); CREATE UNIQUE INDEX "receipt_ref" ON "Receipt"("reference");');
  assert.equal(await reconcileSchema(db,expected,{logger}),0);assert.ok(readSchema(file).indexes.some(row=>row.name==='receipt_ref'));
  for(const change of [{name:'otherKey',type:'INTEGER',notnull:true,dflt:null,pk:true},{name:'stamp',type:'DATETIME',notnull:true,dflt:'CURRENT_TIMESTAMP',pk:false},
    {name:'value',type:'TEXT',notnull:true,dflt:'NULL',pk:false}]){
    const next=structuredClone(expected);next.tables.Item.columns.push(change);
    const plan=planSchemaSync(next,readSchema(file));assert.equal(plan.statements.length,0);assert.equal(plan.refusals.length,1);
    assert.equal(await reconcileSchema(db,next,{logger}),2);
  }
});

test('formatting normalization preserves literal differences and missing manifest metadata cannot report success',async t=>{
  const {file,expected}=await fixture(t,original+'CREATE INDEX "sku_idx" ON "Item"("sku") WHERE "sku" = \'A B\';',original+'CREATE INDEX "sku_idx" ON "Item"("sku") WHERE "sku" = \'A B\';');
  const live=readSchema(file);live.indexes[0].sql=live.indexes[0].sql.replace('CREATE INDEX','create\n index').replace(' ON ',' /* formatting */ on ')+';';
  assert.deepEqual(planSchemaSync(expected,live).drift,[]);live.indexes[0].sql=live.indexes[0].sql.replace("'A B'","'a b'");
  assert.equal(planSchemaSync(expected,live).drift.length,1);assert.ok(planSchemaSync(expected,{tables:live.tables}).drift.some(row=>row.reason.includes('unavailable')));
  for(const broken of [null,{}, {tables:{},indexes:[]},{...expected,tableCount:99},{...expected,indexes:null},
    {...expected,tables:{Item:{...expected.tables.Item,columns:[{name:'id'}]}}}])assert.throws(()=>validateSchemaManifest(broken));
});

test('CLI rejects a mistyped dry-run without changing the file and reports configuration errors with failure status',async t=>{
  const {root}=await fixture(t),file=path.join(root,'cli.db');fs.copyFileSync(path.join(project,'config/template.db'),file);
  const db=new DatabaseSync(file);db.exec('ALTER TABLE "Item" DROP COLUMN "notes"');db.close();
  const run=(args,url='file:'+file.replaceAll('\\','/'))=>spawnSync(process.execPath,[path.join(project,'scripts/schema-sync.mjs'),...args],{cwd:project,env:{...process.env,DATABASE_URL:url},encoding:'utf8',windowsHide:true,timeout:30000});
  const before=fs.readFileSync(file),typo=run(['--dry-rnu']);assert.equal(typo.status,2);assert.match(typo.stderr,/Usage:/);assert.deepEqual(fs.readFileSync(file),before);
  const dry=run(['--dry-run']);assert.equal(dry.status,0,dry.stderr);assert.match(dry.stdout,/WOULD RUN/);assert.deepEqual(fs.readFileSync(file),before);
  const failure=run(['--dry-run'],'invalid-local-fixture');assert.equal(failure.status,2);assert.match(failure.stderr,/schema-sync:/);
  const isolatedScript=path.join(root,'scripts/schema-sync.mjs');fs.mkdirSync(path.dirname(isolatedScript));fs.copyFileSync(path.join(project,'scripts/schema-sync.mjs'),isolatedScript);
  const missing=spawnSync(process.execPath,[isolatedScript,'--dry-run'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(missing.status,2);assert.match(missing.stderr,/schema-manifest.json is missing/);
});

test('added columns cannot silently lose inline or table-level integrity constraints',async t=>{
  const parent='CREATE TABLE "Parent" ("id" INTEGER NOT NULL PRIMARY KEY);';
  for(const definition of ['"extra" INTEGER REFERENCES "Parent"("id")','"extra" TEXT UNIQUE','"extra" INTEGER CHECK ("extra">=0)',
    '"extra" TEXT COLLATE NOCASE','"extra" INTEGER, CONSTRAINT "link" FOREIGN KEY ("extra") REFERENCES "Parent"("id")',
    '"extra" TEXT, UNIQUE ("extra")','"extra" INTEGER, CONSTRAINT "valid" CHECK ("extra">=0)']){
    const {db,file,expected,logger}=await fixture(t,parent+original,parent+'CREATE TABLE "Item" ("id" INTEGER NOT NULL PRIMARY KEY,"sku" TEXT NOT NULL,'+definition+');');
    const before=fs.readFileSync(file),plan=planSchemaSync(expected,readSchema(file));
    assert.equal(plan.statements.length,0,definition);assert.ok(plan.refusals.some(row=>row.reason.includes('constraint')),definition);
    assert.equal(await reconcileSchema(db,expected,{logger}),2);assert.deepEqual(fs.readFileSync(file),before);
  }
  const {db,expected,logger}=await fixture(t,original,wanted.replace('"notes" TEXT',`"notes" TEXT DEFAULT 'CHECK, UNIQUE, REFERENCES'`));
  assert.equal(await reconcileSchema(db,expected,{logger}),0);
});

test('the shipped manifest preserves every template table, column flag, default and explicit index definition',()=>{
  const actual=readSchema(path.join(project,'config/template.db'));
  const expected=JSON.parse(fs.readFileSync(path.join(project,'config/schema-manifest.json'),'utf8'));
  validateSchemaManifest(expected);assert.equal(expected.tableCount,Object.keys(actual.tables).length);
  assert.deepEqual(expected.tables,actual.tables);assert.deepEqual(expected.indexes,actual.indexes);
});

test('an existing empty database reports incomplete setup instead of successful reconciliation',async t=>{
  const {db,file,expected,logger,messages}=await fixture(t,'');const before=fs.readFileSync(file);
  assert.equal(await reconcileSchema(db,expected,{logger}),2);assert.deepEqual(fs.readFileSync(file),before);
  assert.ok(messages.some(message=>message.includes('initial setup is incomplete')));
  assert.deepEqual(readSchema(file).tables,{});
});
