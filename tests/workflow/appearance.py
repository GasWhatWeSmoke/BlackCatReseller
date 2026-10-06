import json,subprocess,tempfile,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
# Read-only synthetic dashboard data, rendered by the actual app components.
root=Path(__file__).resolve().parents[2];phase=sys.argv[1] if len(sys.argv)>1 else 'appearance'
base=Path(tempfile.mkdtemp(prefix='blackcat-midnight-'+phase+'-'));print(str(base),flush=True)
with (base/'bundle.log').open('w') as out:subprocess.run(['node',str(root/'tests/workflow/bundle.cjs'),str(base)],cwd=root,stdout=out,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/p).read_text(encoding='utf-8') for p in ['globals.css','depth.css']).replace('@import "tailwindcss";','')
html='<meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+(base/'workflow.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
steps=[{'id':s,'title':s,'detail':'Complete','state':'done','blocking':False} for s in ['worker','folders','marketplace-accounts','second-monitor','ebay-policy','vision','first-batch','first-listing']]
data={
'/api/ship-queue':{'count':2},
'/api/stats':{'statusCounts':{'Sold':45,'Listed':106},'problemsOpen':0,'collisionsOpen':0,'readyCount':0,'listedCount':106,'draftCount':0,'soldCount':45,'needsInfo':0,'totalItems':151,'incomingCount':0,'incomingError':None,'lifetimeSales':{'itemSales':826.52,'shippingReceived':80,'totalEarned':906.52,'itemsSold':45,'missingSalePrices':0,'missingShipping':0}},
'/api/collisions':{'total':0,'page':1,'pages':1,'pageSize':25,'collisions':[]},
'/api/problems':{'total':0,'page':1,'pages':1,'pageSize':50,'problems':[]},
'/api/setup':{'steps':steps,'progress':{'done':8,'total':8,'complete':True},'blocking':[],'dismissed':True},
'/api/publish/status':{'run':None,'current':None,'jobs':[]},
'/api/publish/monitor':{'enabled':True,'windowOpen':True,'active':False,'lastError':None,'platforms':{},'nextCheckAt':None},
'/api/publish/recovery':{'items':[{'jobId':393,'sku':'000142','marketplace':'mercari','guidance':{'title':'Account needs attention'}}]},
'/api/publish/mercari-goal':{'tracking':False}}
requests=[];errors=[];external=[]
data['/api/stats']['stockValue']={'activeItems':106,'cost':{'knownTotal':320,'recorded':80,'missing':26},'asking':{'knownTotal':2500,'recorded':100,'missing':6}}
def call(source,msg):
 a=msg['args'];assert a['method']=='GET',a;path=a['url'].split('?')[0];requests.append(path);assert path in data,path
 return {'ok':True,'data':data[path]}
proof={'phase':phase,'actualComponents':True,'syntheticReads':True,'noServer':True,'rows':[],'externalRequests':external,'errors':errors}
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
 context=browser.new_context(reduced_motion='reduce');context.expose_binding('workflowCall',call)
 context.add_init_script("localStorage.setItem('bca-sound-muted','1')")
 def route(r):
  if r.request.resource_type=='document' and r.request.url=='http://127.0.0.1:42095/':r.fulfill(body=html,content_type='text/html')
  else:external.append(r.request.url);r.abort()
 context.route('**/*',route);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 for width in [1440,1320,1024,768,390,320]:
  page.set_viewport_size({'width':width,'height':880});page.goto('http://127.0.0.1:42095/')
  expect(page.get_by_text('$906.52',exact=True)).to_be_visible();expect(page.get_by_text('1 listing needs a next step',exact=True)).to_be_visible()
  expect(page.get_by_text('Your recorded sales + shipping income, before fees and costs.',exact=True)).to_be_visible()
  expect(page.get_by_text('$18.37',exact=True)).to_be_visible()
  stock=page.get_by_role('region',name='Inventory value',exact=True)
  expect(stock.get_by_text('$320.00',exact=True)).to_be_visible();expect(stock.get_by_text('$2,500.00',exact=True)).to_be_visible()
  expect(stock.get_by_text('80 item(s) recorded · 26 without a valid cost; partial total',exact=True)).to_be_visible()
  assert page.evaluate('document.documentElement.scrollWidth')<=width
  button=page.get_by_role('button',name='Upload folder',exact=True);button.focus()
  assert button.evaluate('(el)=>getComputedStyle(el).outlineStyle')=='solid'
  assert page.locator('html').get_attribute('data-motion')=='off'
  page.screenshot(path=str(base/f'dashboard-{width}.png'),full_page=True)
  proof['rows'].append({'width':width,'noOverflow':True,'focusVisible':True,'reducedMotion':True})
 page.emulate_media(reduced_motion='no-preference');page.evaluate("localStorage.setItem('blackcat.motion','off');window.dispatchEvent(new Event('blackcat:appearance'))")
 assert page.locator('html').get_attribute('data-motion')=='off'
 page.set_viewport_size({'width':1320,'height':880});page.evaluate("localStorage.setItem('blackcat.motion','full');window.dispatchEvent(new Event('blackcat:appearance'))")
 hero=page.locator('[data-depth]');hero.hover(position={'x':40,'y':40})
 page.wait_for_function("document.querySelector('[data-depth]').style.getPropertyValue('--light-x') !== ''")
 page.evaluate("localStorage.setItem('blackcat.motion','off');window.dispatchEvent(new Event('blackcat:appearance'))")
 assert hero.evaluate('(el)=>getComputedStyle(el).transform')=='none'
 proof['pointerResponseAndMotionOff']=True
 data['/api/stats'].update(statusCounts={'Sold':45,'Listed':19955},totalItems=20000,listedCount=19955)
 data['/api/stats']['lifetimeSales'].update(itemSales=1250000.5,totalEarned=1250080.5)
 data['/api/stats']['stockValue']={'activeItems':19955,'cost':{'knownTotal':9876543210.12,'recorded':19954,'missing':1},'asking':{'knownTotal':19876543210.12,'recorded':19955,'missing':0}}
 page.set_viewport_size({'width':320,'height':880});page.goto('http://127.0.0.1:42095/')
 expect(page.get_by_text('$1,250,080.50',exact=True)).to_be_visible()
 assert page.get_by_text('$1,250,080.50',exact=True).evaluate('(el)=>el.scrollWidth<=el.clientWidth'), 'Revenue is clipped'
 assert page.evaluate('document.documentElement.scrollWidth')<=320
 assert page.get_by_role('region',name='Inventory value',exact=True).get_by_text('$9,876,543,210.12',exact=True).evaluate('(el)=>el.scrollWidth<=el.clientWidth')
 page.screenshot(path=str(base/'dashboard-large-values-320.png'),full_page=True)
 proof['largeValuesNoOverflow']=True
 data['/api/stats']['stockValue']={'activeItems':19955,'cost':{'knownTotal':None,'recorded':0,'missing':19955},'asking':{'knownTotal':0,'recorded':19955,'missing':0}}
 page.goto('http://127.0.0.1:42095/')
 stock=page.get_by_role('region',name='Inventory value',exact=True);expect(stock.get_by_text('Not recorded',exact=True)).to_be_visible();expect(stock.get_by_text('$0.00',exact=True)).to_be_visible()
 proof['unknownVersusRecordedZero']=True
 data['/api/stats']['lifetimeSales'].update(itemSales=0,shippingReceived=0,totalEarned=0,missingSalePrices=45,missingShipping=45)
 page.goto('http://127.0.0.1:42095/');expect(page.get_by_text('0 recorded item price(s); shipping excluded.',exact=True)).to_be_visible()
 proof['unknownSalePricesExcludedFromAverage']=True
 assert not errors,errors;assert not external,external;browser.close()
proof['requests']=sorted(set(requests));(base/'proof.json').write_text(json.dumps(proof,indent=2));(Path(tempfile.gettempdir())/f'blackcat-midnight-{phase}-path.txt').write_text(str(base));print(json.dumps(proof),flush=True)
