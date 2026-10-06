import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMainFileMatchers, getFileMatchers, copyFiles } from 'app-builder-lib/out/fileMatcher.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const support=['init-db.mjs','schema-sync.mjs','setup-local-vision.ps1','setup-local-vision-q6.ps1','hardware-report.mjs','relocate_sqlite_paths.py'];
const required=['electron/main.js','electron/localVisionServer.js','build/icon.png','build/tray.png','.next/BUILD_ID','.next/server/app/page.js','.next/static/chunk.js',
  'config/template.db','config/defaults.json','config/schema-manifest.json','config/normalization.json','config/local-vision.json','config/local-vision-q6-benchmark.json',
  'worker/setup.ps1','worker/requirements.txt','worker/black_cat_worker/__main__.py','SETUP_FRIENDS.md','package.json',
  'prisma/schema.prisma','prisma/migrations/fixture/migration.sql','prisma/migrations/migration_lock.toml',...support.map(name=>'scripts/'+name),
  ...['manifest.json','background.mjs','controller.mjs','policy.mjs','inspect.mjs','app-link.js','README.md'].map(name=>'extensions/marketplace-bridge/'+name)];
const excluded=['scripts/reset.mjs','scripts/backfill-weight.mjs','scripts/requeue-after-nifty-cleanup.mjs','scripts/future-maintenance.mjs',
  'scripts/run-tests.mjs','scripts/e2e/seed_settings.py','electron/main.test.js','.next/cache/webpack/cache.pack','.next/trace',
  'config/private.db','config/.env','data/black-cat.db','var/archive/photo.jpg','worker/tests/test_safety.py',
  'worker/.venv/Scripts/python.exe','worker/python/python/python.exe','worker/black_cat_worker/__pycache__/x.pyc','node_modules/.cache/tool/cache.bin',
  'worker/black_cat_worker/scrub_props.py','extensions/marketplace-bridge/private.log','extensions/marketplace-bridge/.env',
  'electron/.env','electron/private.db','electron/debug.log','worker/.env','worker/black_cat_worker/.env',
  'worker/black_cat_worker/session.json','worker/black_cat_worker/debug.log','worker/black_cat_worker/private.db',
  'worker/black_cat_worker/__pycache__/cached.py','prisma/dev.db','prisma/.env','prisma/migrations/private.db'];

test('the installed builder copies runtime support but excludes developer tools, private data and caches from every destination',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'blackcat-package-files-')),source=path.join(temp,'source'),destination=path.join(temp,'output');
  t.after(async()=>{assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('blackcat-package-files-'));await fs.rm(temp,{recursive:true,force:true});});
  const inputs=[...required,...excluded,'scripts/Setup Black Cat Agent.cmd','scripts/Setup Optional Local AI.cmd',
    'BETA-TEN-ITEMS.md','public/beta-labels.html','node_modules/.prisma/client/query_engine-windows.dll.node'];
  for(const name of inputs){const file=path.join(source,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`inert fixture: ${name}`);}
  const resources=path.join(destination,'resources'),app=path.join(resources,'app'),expand=value=>value;
  const info={projectDir:source,buildResourcesDir:'build',config:manifest.build,isPrepackedAppAsar:false,debugLogger:{isEnabled:false}};
  const main=getMainFileMatchers(source,app,expand,manifest.build.win,{info},destination,false);
  const options={defaultSrc:source,macroExpander:expand,customBuildOptions:manifest.build.win,globalOutDir:destination};
  await copyFiles(main,null,false);
  await copyFiles(getFileMatchers(manifest.build,'extraResources',resources,options),null,false);
  await copyFiles(getFileMatchers(manifest.build,'extraFiles',destination,options),null,false);
  for(const name of required)assert.equal(await fs.readFile(path.join(app,name),'utf8'),`inert fixture: ${name}`,name);
  for(const name of excluded){
    for(const base of [app,resources,destination])assert.equal(await fs.access(path.join(base,name)).then(()=>true,()=>false),false,`Must not ship ${path.relative(destination,path.join(base,name))}`);
  }
  assert.equal(await fs.readFile(path.join(destination,'Setup Black Cat Agent.cmd'),'utf8'),'inert fixture: scripts/Setup Black Cat Agent.cmd');
  assert.equal(await fs.readFile(path.join(destination,'READ ME FIRST - Setup.md'),'utf8'),'inert fixture: SETUP_FRIENDS.md');
  assert.equal(await fs.readFile(path.join(destination,'BETA-TEN-ITEMS.md'),'utf8'),'inert fixture: BETA-TEN-ITEMS.md');
  assert.equal(await fs.readFile(path.join(destination,'BETA-TEN-LABELS.html'),'utf8'),'inert fixture: public/beta-labels.html');
  assert.equal(await fs.readFile(path.join(destination,'Setup Optional Local AI.cmd'),'utf8'),'inert fixture: scripts/Setup Optional Local AI.cmd');
  assert.equal(await fs.readFile(path.join(app,'public/beta-labels.html'),'utf8'),'inert fixture: public/beta-labels.html');
  assert.ok(manifest.build.extraResources.some(entry=>entry.from==='public/beta-labels.html'&&entry.to==='app/public/beta-labels.html'),
    'The in-app print page needs an explicit resource copy because extraFiles excludes its source from the normal app copy');
  assert.equal(await fs.readFile(path.join(app,'node_modules/.prisma/client/query_engine-windows.dll.node'),'utf8'),'inert fixture: node_modules/.prisma/client/query_engine-windows.dll.node');
  for(const name of inputs)assert.equal(await fs.readFile(path.join(source,name),'utf8'),`inert fixture: ${name}`);
  for(const name of support)assert.ok((await fs.stat(path.join(root,'scripts',name))).isFile(),`Missing runtime support ${name}`);
  t.diagnostic(`${required.length} runtime paths retained; ${excluded.length} excluded paths checked across three destinations; source bytes unchanged`);
});

test('actual worker sources retain every native entry and helper while the offline database repair stays out of the package',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'blackcat-package-workers-')),source=path.join(temp,'source'),destination=path.join(temp,'output');
  t.after(async()=>{assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('blackcat-package-workers-'));await fs.rm(temp,{recursive:true,force:true});});
  const worker=path.join(root,'worker/black_cat_worker'),names=(await fs.readdir(worker,{withFileTypes:true}))
    .filter(entry=>entry.isFile()&&/\.(?:py|[cm]?js)$/.test(entry.name)).map(entry=>entry.name);
  const entries=['process','reenrich_batch','export','verify_backup','research_listing','marketplace_login','open_browser_link','chrome_session'];
  for(const platform of ['ebay','depop','poshmark','mercari','etsy'])entries.push('post_'+platform,'end_'+platform,platform+'_sales');
  for(const name of entries)assert.ok(names.includes(name+'.py'),`Missing actual native entry ${name}`);
  const inputs=new Map();
  for(const name of names){const bytes=await fs.readFile(path.join(worker,name));inputs.set(name,bytes);const target=path.join(source,'worker/black_cat_worker',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
  const app=path.join(destination,'resources/app'),info={projectDir:source,buildResourcesDir:'build',config:manifest.build,isPrepackedAppAsar:false,debugLogger:{isEnabled:false}};
  await copyFiles(getMainFileMatchers(source,app,value=>value,manifest.build.win,{info},destination,false),null,false);
  for(const [name,bytes] of inputs){
    const target=path.join(app,'worker/black_cat_worker',name);
    if(name==='scrub_props.py')assert.equal(await fs.access(target).then(()=>true,()=>false),false);
    else assert.deepEqual(await fs.readFile(target),bytes,`Runtime source changed: ${name}`);
    assert.deepEqual(await fs.readFile(path.join(worker,name)),bytes,`Source checkout changed: ${name}`);
  }
  t.diagnostic(`${entries.length} native entry modules and ${names.length-1} actual worker files retained byte-for-byte; repair CLI retained only in source`);
});

test('actual Electron helpers and Chrome widget sources survive packaging byte-for-byte',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'blackcat-package-desktop-')),source=path.join(temp,'source'),destination=path.join(temp,'output');
  t.after(async()=>{assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('blackcat-package-desktop-'));await fs.rm(temp,{recursive:true,force:true});});
  const names=[];
  for(const folder of ['electron','extensions/marketplace-bridge']) {
    for(const entry of await fs.readdir(path.join(root,folder),{withFileTypes:true})) {
      if(!entry.isFile()||/\.test\./.test(entry.name))continue;
      if(/\.(?:[cm]?js)$/.test(entry.name)||folder.startsWith('extensions/')&&['manifest.json','README.md'].includes(entry.name))names.push(folder+'/'+entry.name);
    }
  }
  for(const name of ['electron/chromeControl.js','electron/nativeBoundary.js','electron/preload.js',
    'extensions/marketplace-bridge/background.mjs','extensions/marketplace-bridge/app-link.js'])assert.ok(names.includes(name),name);
  const bytes=new Map();
  for(const name of names){const value=await fs.readFile(path.join(root,name));bytes.set(name,value);await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),value);}
  const app=path.join(destination,'resources/app'),info={projectDir:source,buildResourcesDir:'build',config:manifest.build,isPrepackedAppAsar:false,debugLogger:{isEnabled:false}};
  await copyFiles(getMainFileMatchers(source,app,value=>value,manifest.build.win,{info},destination,false),null,false);
  for(const [name,value] of bytes){assert.deepEqual(await fs.readFile(path.join(app,name)),value,name);assert.deepEqual(await fs.readFile(path.join(root,name)),value,`Source changed: ${name}`);}
  const widget=JSON.parse(await fs.readFile(path.join(app,'extensions/marketplace-bridge/manifest.json'),'utf8'));
  for(const entry of [widget.background.service_worker,...widget.content_scripts.flatMap(value=>value.js)])assert.ok(bytes.has('extensions/marketplace-bridge/'+entry),entry);
  t.diagnostic(`${names.length} actual desktop/widget source and manifest files retained; declared extension entries present; source bytes unchanged`);
});
