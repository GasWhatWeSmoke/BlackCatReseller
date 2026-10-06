# Actual Settings form + IndexedDB; unrelated account/maintenance panels are inert.
import copy,json,subprocess,tempfile,shutil
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2];base=Path(tempfile.mkdtemp(prefix='blackcat-settings-recovery-'));print(str(base),flush=True)
subprocess.run(['node',str(root/'tests/workflow/settings-draft.cjs'),str(base)],cwd=root,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
defaults=json.loads((root/'config/defaults.json').read_text(encoding='utf-8'))['defaults']
state={};calls=[];errors=[];external=[]
def reset():
 state.clear();state.update(saved={**copy.deepcopy(defaults),'dataRoot':'C:/settings-fixture','priceWarnMin':5,
  'publish':{'ebay':{'clientSecret':'DO-NOT-PERSIST'}},'lastSyncSummary':'DO-NOT-PERSIST'},mode='ok')
def call(source,msg):
 calls.append(msg)
 if msg['url']=='/api/settings':
  if msg['method']=='PUT':
   assert set(msg['body'])<=set(defaults)|{'dataRoot'},msg
   assert 'publish' not in msg['body'] and 'lastSyncSummary' not in msg['body']
   if state['mode']!='fail':state['saved'].update(msg['body'])
   if state['mode']!='ok':return {'status':503,'body':{'error':'Synthetic save failure'}}
  return {'status':200,'body':{'settings':copy.deepcopy(state['saved'])}}
 if msg['url']=='/api/ship-queue':return {'status':200,'body':{'count':0}}
 if msg['url']=='/api/vision':return {'status':200,'body':{'status':{'kind':'ready','serverReady':True}}}
 raise AssertionError(msg)
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/p).read_text(encoding='utf-8') for p in ['globals.css','depth.css']).replace('@import "tailwindcss";','')
html='<meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+(base/'settings.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
proof={'actualSettingsForm':True,'realIndexedDB':True,'companionPanelsStubbed':True,'noServer':True,'phases':[]}
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
 def context(blocked=False,persistent=None):
  ctx=pw.chromium.launch_persistent_context(str(persistent),headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe',viewport={'width':1320,'height':880},reduced_motion='reduce') if persistent else browser.new_context(viewport={'width':1320,'height':880},reduced_motion='reduce')
  ctx.expose_binding('workflowCall',call)
  if blocked:ctx.add_init_script("Object.defineProperty(window,'indexedDB',{value:{open(){throw Error('Draft storage blocked for fixture')}}})")
  def route(r):
   if r.request.resource_type=='document' and r.request.url.startswith('http://127.0.0.1:42095/'):r.fulfill(body=html,content_type='text/html')
   else:external.append(r.request.url);r.abort()
  ctx.route('**/*',route);return ctx
 def opened(ctx):
  page=ctx.new_page();page.on('dialog',lambda d:d.accept());page.on('pageerror',lambda e:errors.append(str(e)));page.goto('http://127.0.0.1:42095/settings');pricing(page);return page
 def pricing(page):
  summary=page.locator('summary').filter(has_text='Pricing');summary.click()
  expect(field(page)).to_be_enabled()
 def field(page):return page.get_by_role('spinbutton',name='Pricing: Warn below ($)',exact=True)
 def save(page):return page.get_by_role('button',name='Save general preferences',exact=True)
 def kept(page):expect(page.get_by_text('Your draft is kept on this device and will return after a reload.',exact=True)).to_be_visible()
 def writes():return len([row for row in calls if row['method']=='PUT'])

 reset();ctx=context();p=opened(ctx);other=p.evaluate('()=>window.seedOtherDraft()');start=writes();field(p).fill('42');kept(p)
 assert 'DO-NOT-PERSIST' not in p.evaluate('()=>readSettingsDraft().then(JSON.stringify)')
 p.reload();pricing(p);expect(field(p)).to_have_value('42');assert state['saved']['priceWarnMin']==5 and writes()==start
 p.get_by_role('link',name='Dashboard',exact=True).click();p.get_by_role('link',name='Return to Settings',exact=True).click();pricing(p);expect(field(p)).to_have_value('42')
 p.close();p=opened(ctx);expect(field(p)).to_have_value('42')
 proof['phases'].append('reload, navigation and a new window recover unsaved edits without applying them or storing account data')
 state['saved']['priceWarnMin']=10;p.reload();pricing(p);expect(field(p)).to_have_value('42');expect(save(p)).to_be_disabled()
 p.get_by_text('Low-price warning',exact=True).click();expect(p.get_by_text('10',exact=True)).to_be_visible();expect(p.get_by_text('42',exact=True)).to_be_visible()
 for width in [1320,320]:
  p.set_viewport_size({'width':width,'height':880});p.evaluate('window.scrollTo(0,0)');assert p.evaluate('document.documentElement.scrollWidth')<=width
  p.screenshot(path=str(base/f'conflict-{width}.png'),full_page=True)
 p.set_viewport_size({'width':1320,'height':880})
 p.get_by_role('button',name='Keep recovered edits for review',exact=True).click();kept(p);assert state['saved']['priceWarnMin']==10
 save(p).click();expect(p.get_by_role('region',name='General preferences draft')).not_to_be_visible();assert state['saved']['priceWarnMin']==42
 proof['phases'].append('changed saved preferences require review; keeping a recovered draft still requires explicit Save')
 p.evaluate('window.holdSettingsSave=true');field(p).fill('50');kept(p);save(p).click();p.wait_for_function('!!window.releaseSettingsSave')
 p.get_by_role('link',name='Dashboard',exact=True).click();expect(p.get_by_role('heading',name='Settings',exact=True)).to_be_visible()
 field(p).fill('55');p.evaluate('window.holdSettingsSave=false;window.releaseSettingsSave()');expect(save(p)).to_be_enabled();kept(p)
 assert state['saved']['priceWarnMin']==50;p.reload();pricing(p);expect(field(p)).to_have_value('55')
 proof['phases'].append('edits typed during a pending save survive its receipt and another reload')
 state['mode']='fail';save(p).click();expect(p.get_by_text('Synthetic save failure',exact=False)).to_be_visible();p.reload();pricing(p);expect(field(p)).to_have_value('55');assert state['saved']['priceWarnMin']==50
 state['mode']='apply-fail';before=writes();save(p).click();expect(p.get_by_text('Synthetic save failure',exact=False)).to_be_visible();p.reload();pricing(p);expect(field(p)).to_have_value('55')
 expect(p.get_by_role('region',name='General preferences draft')).not_to_be_visible();assert writes()==before+1 and state['saved']['priceWarnMin']==55
 proof['phases'].append('failed saves retain drafts; a lost success response is reconciled on reload without replay')
 state['mode']='ok';field(p).fill('60');kept(p);p.get_by_role('button',name='Discard unsaved preferences',exact=True).click();expect(field(p)).to_have_value('55');assert state['saved']['priceWarnMin']==55
 for width in [1320,768,390,320]:
  p.set_viewport_size({'width':width,'height':880});field(p).fill('61');kept(p);assert p.evaluate('document.documentElement.scrollWidth')<=width
  p.evaluate('window.scrollTo(0,0)');p.screenshot(path=str(base/f'settings-{width}.png'),full_page=True)
 assert p.evaluate('()=>window.readOtherDraft()')==other
 proof['phases'].append('settings saves and discards preserve an existing item-review draft in the shared store')
 ctx.close()

 reset();ctx=context();first=opened(ctx);second=opened(ctx)
 field(first).fill('42');kept(first);field(second).fill('77');expect(save(second)).to_be_disabled()
 expect(second.get_by_text('Another window changed the settings draft.',exact=False)).to_be_visible();assert state['saved']['priceWarnMin']==5
 second.get_by_role('button',name='Keep this window’s draft',exact=True).click();kept(second)
 save(first).click();expect(save(first)).to_be_disabled();first.get_by_role('button',name='Use the other window’s draft',exact=True).click();expect(field(first)).to_have_value('77')
 save(first).click();expect(first.get_by_role('region',name='General preferences draft')).not_to_be_visible();assert state['saved']['priceWarnMin']==77
 # The other window has now saved: adopting its empty draft must reload server values.
 field(second).fill('88');expect(save(second)).to_be_disabled()
 second.get_by_role('button',name='Use the other window’s draft',exact=True).click();expect(field(second)).to_have_value('77')
 proof['phases'].append('cross-window compare/write conflict preserves both visible forms and requires an explicit choice')
 ctx.close()

 reset();ctx=context(blocked=True);p=opened(ctx);field(p).fill('42');expect(p.get_by_text('Save general preferences before leaving to keep the edits shown here.',exact=True)).to_be_visible()
 p.get_by_role('link',name='Dashboard',exact=True).click();expect(field(p)).to_have_value('42')
 save(p).click();expect(save(p)).to_be_enabled();assert state['saved']['priceWarnMin']==42
 p.get_by_role('link',name='Dashboard',exact=True).click();expect(p.get_by_role('link',name='Return to Settings')).to_be_visible()
 proof['phases'].append('unavailable local storage warns and protects unsaved work while allowing explicit settings saves')
 ctx.close()

 reset();ctx=context();p=opened(ctx)
 p.evaluate("""() => new Promise((resolve,reject)=>{const req=indexedDB.open('blackcat-item-drafts',1);req.onsuccess=()=>{const db=req.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({key:'settings:general:v1',version:999,kept:'unreadable fixture'});tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}})""")
 p.reload();pricing(p);expect(field(p)).to_have_value('5');expect(p.get_by_text('Its stored copy has been kept.',exact=False)).to_be_visible()
 field(p).fill('42');save(p).click();expect(save(p)).to_be_enabled();assert state['saved']['priceWarnMin']==42
 raw=p.evaluate("""() => new Promise(resolve=>{const req=indexedDB.open('blackcat-item-drafts',1);req.onsuccess=()=>{const db=req.result,r=db.transaction('drafts','readonly').objectStore('drafts').get('settings:general:v1');r.onsuccess=()=>{db.close();resolve(r.result)}}})""")
 assert raw=={'key':'settings:general:v1','version':999,'kept':'unreadable fixture'}
 proof['phases'].append('malformed stored drafts remain untouched; fresh saved preferences can still be edited and explicitly saved')
 ctx.close()

 reset();ctx=context();p=opened(ctx)
 p.evaluate("""() => {const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(value?.key==='settings:general:v1')throw new DOMException('Synthetic quota failure','QuotaExceededError');return original.call(this,value,...args)}}""")
 field(p).fill('42');expect(p.get_by_text('Synthetic quota failure',exact=False)).to_be_visible()
 p.get_by_role('link',name='Dashboard',exact=True).click();expect(field(p)).to_have_value('42')
 save(p).click();expect(save(p)).to_be_enabled();assert state['saved']['priceWarnMin']==42
 proof['phases'].append('a draft-write failure blocks unsafe navigation but does not prevent an explicit settings save')
 ctx.close()

 reset();profile=base/'profile';ctx=context(persistent=profile);p=opened(ctx);field(p).fill('42');kept(p);ctx.close()
 ctx=context(persistent=profile);p=opened(ctx);expect(field(p)).to_have_value('42');assert state['saved']['priceWarnMin']==5;ctx.close()
 assert profile.resolve().is_relative_to(base.resolve()) and profile.resolve()!=base.resolve();shutil.rmtree(profile)
 proof['phases'].append('unsaved preferences survive a full browser process shutdown and restart in an isolated profile')
 browser.close()
assert not errors,errors;assert not external,external
proof.update(browserErrors=errors,externalRequests=external,requests=len(calls),explicitSaves=writes());(base/'proof.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof),flush=True)
