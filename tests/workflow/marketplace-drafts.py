# Actual five preference forms and IndexedDB; all server reads/saves are synthetic.
import copy,json,subprocess,tempfile,shutil,re
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2];base=Path(tempfile.mkdtemp(prefix='blackcat-market-drafts-'));print(str(base),flush=True)
subprocess.run(['node',str(root/'tests/workflow/marketplace-drafts.cjs'),str(base)],cwd=root,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
initial={'ebayBrowser':{'enabled':False,'autoPost':False,'shippingPolicyName':'Original shipping','returnPolicyName':'Returns','paymentPolicyName':'Payment','generalAdRate':None},'etsy':{'enabled':False,'autoPost':False,'shippingProfileName':'Original profile','autoRenew':False},'mercari':{'enabled':False,'autoPost':False,'unisexDepartment':'Women','shippingMode':'buyer_label','unlistedBrands':['Original Mercari']},'depop':{'enabled':False,'autoPost':False,'boostListings':False,'unlistedBrands':['Original Depop']},'ebay':{'clientSecret':'PRIVATE-SECRET','refreshToken':'PRIVATE-TOKEN'}}
state={};calls=[];errors=[];external=[]
def reset():state.clear();state.update(publish=copy.deepcopy(initial),workspace='C:/market-fixture',mode='ok',race=None)
def canonical(field,value):return list(dict.fromkeys(v.strip() for v in value.splitlines() if v.strip())) if field=='brands' else value.strip() if isinstance(value,str) else value

def call(source,msg):
 calls.append(msg)
 if msg['url']=='/api/ship-queue':return {'status':200,'body':{'count':0}}
 assert msg['url']=='/api/publish/settings',msg
 if msg['method']=='PATCH':
  body=msg['body'];expected=body['marketplaceDraftExpectation'];scope=expected['scope'];group={'depopBrands':'depop','mercariBrands':'mercari'}.get(scope,scope)
  assert set(body)=={group,'marketplaceDraftExpectation'};assert set(body[group])==set('unlistedBrands' if key=='brands' else key for key in expected['values'])
  assert 'PRIVATE' not in json.dumps(body)
  if state['race']:
   key,value=state.pop('race');state['publish'][group][key]=value;state['race']=None
  for field,value in expected['values'].items():
   current=state['publish'][group]['unlistedBrands'] if field=='brands' else state['publish'][group][field]
   if expected['workspace']!=state['workspace'] or canonical(field,value)!=(current if field=='brands' else canonical(field,current)):
    return {'status':409,'body':{'error':'Saved marketplace preferences changed.'}}
  if state['mode'] not in ['fail','wrong-receipt']:
   for key,value in body[group].items():state['publish'][group][key]=list(dict.fromkeys(v.strip() for v in value if v.strip())) if key=='unlistedBrands' else value.strip() if isinstance(value,str) else value
  if state['mode'] in ['fail','apply-fail']:return {'status':503,'body':{'error':'Synthetic save failure'}}
 return {'status':200,'body':{'workspace':state['workspace'],'publish':copy.deepcopy(state['publish'])}}
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/p).read_text(encoding='utf-8') for p in ['globals.css','depth.css']).replace('@import "tailwindcss";','')
html='<meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+(base/'market.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
proof={'sourceRoot':str(root),'actualPreferenceForms':True,'realIndexedDB':True,'noServer':True,'phases':[]}
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
 def context(blocked=False,profile=None):
  ctx=pw.chromium.launch_persistent_context(str(profile),headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe',viewport={'width':1320,'height':880},reduced_motion='reduce') if profile else browser.new_context(viewport={'width':1320,'height':880},reduced_motion='reduce')
  ctx.expose_binding('workflowCall',call)
  if blocked:ctx.add_init_script("Object.defineProperty(window,'indexedDB',{value:{open(){throw Error('Synthetic unavailable draft storage')}}})")
  def route(r):
   if r.request.resource_type=='document' and r.request.url.startswith('http://127.0.0.1:42095/'):r.fulfill(body=html,content_type='text/html')
   else:external.append(r.request.url);r.abort()
  ctx.route('**/*',route);return ctx
 def opened(ctx,suffix=''):
  p=ctx.new_page();p.on('dialog',lambda d:d.accept());p.on('pageerror',lambda e:errors.append(str(e)));p.goto('http://127.0.0.1:42095/settings'+suffix);expect(policy(p)).to_be_enabled();return p
 def region(p,name):return p.get_by_role('region',name=name,exact=True)
 def policy(p):return region(p,'eBay').get_by_role('textbox',name='Shipping policy',exact=True)
 def save(p,name):return region(p,name).get_by_role('button',name='Save '+name+' settings',exact=True)
 def settled(p,name):expect(region(p,name).get_by_text('Draft kept in this workspace.',exact=False)).to_be_visible()
 def brand(p,name):
  r=region(p,name);r.locator('summary').first.click();return r.get_by_role('textbox')
 def stored(p):return p.evaluate("""()=>new Promise(resolve=>{const r=indexedDB.open('blackcat-item-drafts',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('drafts','readonly').objectStore('drafts').getAll();q.onsuccess=()=>{db.close();resolve(q.result)}}})""")
 def writes():return len([row for row in calls if row['method']=='PATCH'])
 reset();ctx=context();p=opened(ctx);before=writes()
 policy(p).fill('Unsaved shipping');region(p,'Etsy').get_by_role('textbox',name='Existing shipping profile').fill('Unsaved profile');region(p,'Mercari').get_by_role('combobox',name='Mercari shipping',exact=True).select_option('ship_on_own')
 region(p,'eBay').get_by_role('checkbox',name='Enable eBay browser posting',exact=True).check();region(p,'eBay').get_by_role('checkbox',name='Promote new eBay listings with General',exact=True).check();region(p,'eBay').get_by_role('checkbox',name=re.compile('^Fill check only')).uncheck()
 region(p,'Etsy').get_by_role('checkbox',name='Automatically renew expired listings every four months',exact=True).check()
 brand(p,'Depop brands').fill('Depop draft');brand(p,'Mercari brands').fill('Mercari draft')
 for name in ['eBay','Etsy','Mercari','Depop brands','Mercari brands']:settled(p,name)
 assert state['publish']==initial and writes()==before;assert 'PRIVATE' not in json.dumps(stored(p));assert len(stored(p))==5
 p.reload();expect(policy(p)).to_have_value('Unsaved shipping');expect(region(p,'Etsy').get_by_role('textbox')).to_have_value('Unsaved profile');expect(region(p,'Mercari').get_by_role('combobox',name='Mercari shipping',exact=True)).to_have_value('ship_on_own')
 expect(brand(p,'Depop brands')).to_have_value('Depop draft');expect(brand(p,'Mercari brands')).to_have_value('Mercari draft')
 expect(region(p,'eBay').get_by_role('checkbox',name='Enable eBay browser posting',exact=True)).to_be_checked();expect(region(p,'eBay').get_by_role('checkbox',name=re.compile('^Fill check only'))).not_to_be_checked()
 expect(region(p,'eBay').get_by_role('spinbutton',name='Fixed ad rate (%)',exact=True)).to_have_value('2');expect(region(p,'Etsy').get_by_role('checkbox',name='Automatically renew expired listings every four months',exact=True)).to_be_checked()
 assert state['publish']==initial and writes()==before
 proof['phases'].append('all five scopes survive reload independently without applying posting, payment or brand changes')
 state['publish']['mercari']['unlistedBrands']=['Newer external approval'];save(p,'Mercari').click();expect(region(p,'Mercari').get_by_role('region',name='Mercari settings draft',exact=True)).not_to_be_visible()
 assert state['publish']['mercari']['unlistedBrands']==['Newer external approval'] and state['publish']['mercari']['shippingMode']=='ship_on_own'
 rb=region(p,'Mercari brands');rb.get_by_role('button',name='Save brand preferences',exact=True).click();expect(rb.get_by_text('Saved preferences changed since this draft started.',exact=False)).to_be_visible();expect(rb.get_by_role('button',name='Save brand preferences',exact=True)).to_be_disabled()
 rb.get_by_role('button',name='Keep recovered edits for review',exact=True).click();settled(p,'Mercari brands');assert state['publish']['mercari']['unlistedBrands']==['Newer external approval']
 rb.get_by_role('button',name='Save brand preferences',exact=True).click();expect(rb.get_by_role('region',name='Mercari brand preferences draft',exact=True)).not_to_be_visible();assert state['publish']['mercari']['unlistedBrands']==['Mercari draft']
 proof['phases'].append('sparse posting saves preserve newer brand approvals; changed brand drafts require review and explicit Save')
 state['mode']='fail';save(p,'eBay').click();expect(region(p,'eBay').get_by_text('Synthetic save failure',exact=False)).to_be_visible();p.reload();expect(policy(p)).to_have_value('Unsaved shipping')
 state['mode']='apply-fail';before=writes();save(p,'eBay').click();expect(region(p,'eBay').get_by_text('Synthetic save failure',exact=False)).to_be_visible();p.reload();expect(policy(p)).to_have_value('Unsaved shipping');expect(region(p,'eBay').get_by_role('region',name='eBay settings draft',exact=True)).not_to_be_visible();assert writes()==before+1
 proof['phases'].append('failed saves retain drafts; lost success replies reconcile without another mutation')
 state['mode']='ok';policy(p).fill('Race draft');settled(p,'eBay');state['race']=('shippingPolicyName','Changed after read');save(p,'eBay').click()
 expect(save(p,'eBay')).to_be_disabled();expect(region(p,'eBay').get_by_text('Saved preferences changed since this draft started.',exact=False)).to_be_visible();assert state['publish']['ebayBrowser']['shippingPolicyName']=='Changed after read'
 state['publish']['ebayBrowser']['shippingPolicyName']='Changed again';region(p,'eBay').get_by_role('button',name='Keep recovered edits for review',exact=True).click();expect(region(p,'eBay').get_by_text('Saved preferences changed again.',exact=False)).to_be_visible();expect(save(p,'eBay')).to_be_disabled()
 region(p,'eBay').get_by_role('button',name='Keep recovered edits for review',exact=True).click();settled(p,'eBay');assert state['publish']['ebayBrowser']['shippingPolicyName']=='Changed again';save(p,'eBay').click();expect(region(p,'eBay').get_by_role('region',name='eBay settings draft',exact=True)).not_to_be_visible();assert state['publish']['ebayBrowser']['shippingPolicyName']=='Race draft'
 proof['phases'].append('a change between fresh read and save is rejected, then requires an explicit reviewed retry')
 p.evaluate('window.holdSave=true');policy(p).fill('Pending save');settled(p,'eBay');save(p,'eBay').click();p.wait_for_function('!!window.releaseSave');expect(policy(p)).to_be_disabled();p.get_by_role('link',name='Dashboard',exact=True).click();expect(policy(p)).to_be_visible();p.evaluate('window.holdSave=false;window.releaseSave()');expect(policy(p)).to_be_enabled()
 expect(region(p,'eBay').get_by_text('Wait for the current operation,',exact=False)).not_to_be_visible()
 region(p,'Etsy').get_by_role('button',name='Discard unsaved preferences',exact=True).click();expect(region(p,'Etsy').get_by_role('textbox')).to_have_value('Original profile')
 for width in [1320,768,390,320]:
  p.set_viewport_size({'width':width,'height':880});policy(p).fill('Layout draft');settled(p,'eBay');assert p.evaluate('document.documentElement.scrollWidth')<=width;p.evaluate('window.scrollTo(0,0)');p.screenshot(path=str(base/f'preferences-{width}.png'))
 proof['phases'].append('pending writes disable editing and unsafe navigation; discard affects only unsaved preferences; four widths fit')
 # Workspace switch cannot restore the other workspace's draft.
 state['workspace']='C:/different';save(p,'eBay').click();expect(region(p,'eBay').get_by_text('The workspace changed or could not be confirmed.',exact=False)).to_be_visible()
 p.goto('http://127.0.0.1:42095/settings?workspace=C:/different');expect(policy(p)).to_have_value('Pending save');assert writes()==before+4
 proof['phases'].append('different workspaces do not inherit drafts')
 ctx.close()
 reset();ctx=context();first=opened(ctx);second=opened(ctx);policy(first).fill('First');settled(first,'eBay');policy(second).fill('Second');expect(save(second,'eBay')).to_be_disabled()
 region(second,'eBay').get_by_role('button',name='Keep this window’s draft',exact=True).click();settled(second,'eBay');save(first,'eBay').click();expect(save(first,'eBay')).to_be_disabled();region(first,'eBay').get_by_role('button',name='Use the other window’s draft',exact=True).click();expect(policy(first)).to_have_value('Second');save(first,'eBay').click();expect(region(first,'eBay').get_by_role('region',name='eBay settings draft',exact=True)).not_to_be_visible()
 proof['phases'].append('cross-window draft revisions prevent silent replacement and require a choice');ctx.close()
 reset();ctx=context(blocked=True);p=opened(ctx);policy(p).fill('Manual save');p.get_by_role('link',name='Dashboard',exact=True).click();expect(policy(p)).to_have_value('Manual save');save(p,'eBay').click();expect(policy(p)).to_be_enabled();assert state['publish']['ebayBrowser']['shippingPolicyName']=='Manual save'
 proof['phases'].append('blocked local storage warns, protects navigation and leaves explicit Save available');ctx.close()
 reset();ctx=context();p=opened(ctx);policy(p).fill('Retained draft');settled(p,'eBay');record=next(row for row in stored(p) if row['scope']=='ebayBrowser');record['version']=99
 p.evaluate("""value=>new Promise(resolve=>{const r=indexedDB.open('blackcat-item-drafts',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(value);tx.oncomplete=()=>{db.close();resolve()}}})""",record)
 p.reload();expect(policy(p)).to_have_value('Original shipping');expect(region(p,'eBay').get_by_text('Its stored copy has been kept.',exact=False)).to_be_visible()
 policy(p).fill('Explicit recovery save');save(p,'eBay').click();expect(policy(p)).to_be_enabled();assert state['publish']['ebayBrowser']['shippingPolicyName']=='Explicit recovery save'
 assert next(row for row in stored(p) if row.get('scope')=='ebayBrowser')==record
 proof['phases'].append('corrupt stored drafts are retained while fresh preferences remain explicitly saveable');ctx.close()
 reset();ctx=context();p=opened(ctx);p.evaluate("""()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(value?.key?.startsWith('market-preferences:'))throw new DOMException('Synthetic quota failure','QuotaExceededError');return put.call(this,value,...args)}}""")
 policy(p).fill('Quota-safe save');expect(region(p,'eBay').get_by_text('Synthetic quota failure',exact=False)).to_be_visible();p.get_by_role('link',name='Dashboard',exact=True).click();expect(policy(p)).to_have_value('Quota-safe save')
 save(p,'eBay').click();expect(policy(p)).to_be_enabled();assert state['publish']['ebayBrowser']['shippingPolicyName']=='Quota-safe save'
 proof['phases'].append('draft write failures guard unsaved navigation without blocking an explicit preference save');ctx.close()
 reset();ctx=context();p=opened(ctx);state['mode']='wrong-receipt';policy(p).fill('Receipt must match');settled(p,'eBay');save(p,'eBay').click()
 expect(region(p,'eBay').get_by_text('The save response did not confirm the requested values.',exact=False)).to_be_visible();assert state['publish']['ebayBrowser']['shippingPolicyName']=='Original shipping'
 p.reload();expect(policy(p)).to_have_value('Receipt must match');proof['phases'].append('a mismatched successful response cannot clear the draft or report saved preferences');ctx.close()
 reset();profile=base/'profile';ctx=context(profile=profile);p=opened(ctx);policy(p).fill('After restart');settled(p,'eBay');ctx.close();ctx=context(profile=profile);p=opened(ctx);expect(policy(p)).to_have_value('After restart');assert state['publish']==initial;ctx.close()
 assert profile.resolve().is_relative_to(base.resolve()) and profile.resolve()!=base.resolve();shutil.rmtree(profile);proof['phases'].append('full browser restart restores drafts without applying them');browser.close()
assert not errors,errors;assert not external,external
proof.update(browserErrors=errors,externalRequests=external,explicitWrites=writes());(base/'proof.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof),flush=True)
