"""Run against an isolated built checkout: python scripts/check-upload-ui.py PATH.

Uses a temporary database and mocks publication commands. Never visits a real
marketplace or forwards an upload command to the running reseller.
"""
import copy
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

workspace = Path(sys.argv[1]).resolve()
project = Path(__file__).resolve().parents[1]
assert workspace != project, 'Use the isolated build, not the running app checkout'
platforms = [{'id': name, 'name': label, 'implemented': True, 'configured': True, 'reason': None}
             for name, label in [('depop','Depop'),('ebay','eBay'),('etsy','Etsy'),('poshmark','Poshmark'),('mercari','Mercari')]]
items = [{'id': 1, 'sku': 'FIXTURE-1', 'brand': 'Vintage brand', 'itemType': 'Shirt', 'size': 'M',
          'price': 24.99, 'platformPrices':{'ebay':19.99,'poshmark':25}, 'photoCount': 4, 'ready': True, 'issues': [], 'publishedOn': []}]

with tempfile.TemporaryDirectory(prefix='blackcat-upload-ui-') as temporary:
    root = Path(temporary); data = root/'data'; data.mkdir(); database = root/'test.db'
    shutil.copy2(workspace/'config/template.db', database)
    with closing(sqlite3.connect(database)) as db:
        db.executemany('INSERT INTO Item (sku,status,salePrice,shippingCharged,createdAt,updatedAt) VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
            [('SOLD-1','Sold',24.99,5.5),('SOLD-2','Sold',10.01,0),('RETURNED','Photographed',999,99)])
        db.execute('INSERT OR REPLACE INTO AppSettings (id,data,updatedAt) VALUES (1,?,CURRENT_TIMESTAMP)', (json.dumps({'mercariShipFrom':{'city':'Fixture','zip':'12345','state':'FL','stateFull':'Florida'}}),))
        db.commit()
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]; listener.close()
    base = f'http://127.0.0.1:{port}'
    origin = base
    environment = {**os.environ, 'DATABASE_URL':'file:'+database.as_posix(), 'BLACKCAT_DATA_ROOT':str(data),
                   # Deliberately reject Python's -m command: the real scheduler
                   # can be exercised without ever opening a marketplace browser.
                   'BLACKCAT_PYTHON':str(shutil.which('node'))}
    server = subprocess.Popen(['node','node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',str(port)], cwd=workspace,
        env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        deadline=time.monotonic()+30
        while True:
            try:
                with urlopen(Request(base+'/api/publish/settings', headers={'Host':'127.0.0.1:41999'}), timeout=2) as response: json.load(response)
                break
            except Exception:
                if server.poll() is not None or time.monotonic()>deadline: raise
                time.sleep(.2)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            page = browser.new_page(viewport={'width':1280,'height':1000})
            state = {'items':[], 'error':False, 'run':None, 'postError':False, 'settingsError':False, 'commands':[], 'auto':{'config':{'enabled':False,'marketplaces':['depop','ebay','etsy','poshmark','mercari']},'state':'off','needsAttention':0,'error':None,'runId':None}}
            def proxy(route):
                path = urlsplit(route.request.url).path
                if path == '/api/publish/status':
                    route.fulfill(status=503 if state['error'] else 200, json={} if state['error'] else {'run':state['run'], 'marketplaces':platforms}); return
                if path == '/api/publish/eligible': route.fulfill(json={'items':state['items'],'awaitingReview':[{'id':99,'sku':'PROCESSED-99','brand':'Processed brand','itemType':'Shirt','status':'Photographed','photoCount':4}]}); return
                if path == '/api/publish/auto-run':
                    if route.request.method == 'POST':
                        state['auto']['config']=route.request.post_data_json
                        state['auto']['state']='waiting' if state['auto']['config']['enabled'] else 'off'
                    route.fulfill(json={'ok':True,**state['auto']});return
                if path == '/api/publish/settings' and route.request.method == 'PATCH' and state['settingsError']:
                    route.fulfill(status=500,json={'error':'Fixture settings rejected'});return
                if path.startswith('/api/publish/runs'):
                    payload=route.request.post_data_json; state['commands'].append(payload)
                    if state['postError']: route.fulfill(status=500,json={'ok':False,'error':'Fixture upload rejected'}); return
                    if path == '/api/publish/runs':
                        state['run']={'id':1,'status':'running','totalJobs':5,'startedAt':'2026-09-10T12:00:00Z','finishedAt':None,'note':None,'marketplaces':['depop','ebay','etsy','poshmark','mercari']}
                    else: state['run']['status']={'pause':'paused','resume':'running','cancel':'cancelled'}.get(payload['action'],'running')
                    route.fulfill(json={'ok':True,'jobs':5}); return
                headers={**route.request.all_headers(),'host':'127.0.0.1:41999','origin':'http://127.0.0.1:41999'}
                route.fulfill(response=route.fetch(url=base+route.request.url.removeprefix(origin),headers=headers,max_redirects=0))
            page.route(origin+'/**',proxy)
            page.route('http://127.0.0.1:41999/**',lambda route:route.abort())
            page.on('dialog',lambda dialog:dialog.accept())
            page.goto(origin+'/ready',wait_until='domcontentloaded')
            expect(page.get_by_role('heading',name='Ready pieces will appear here',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='Start selected',exact=True)).not_to_be_enabled()
            expect(page.get_by_role('link',name='Crosslisting',exact=True)).to_have_attribute('aria-current','page')
            for name in ('Depop','eBay','Etsy','Poshmark','Mercari'): expect(page.get_by_role('checkbox',name=name,exact=True)).to_be_checked()
            logs=project/'var/logs';logs.mkdir(exist_ok=True)
            page.screenshot(path=str(logs/'crosslisting-main-empty.png'),full_page=True)
            expect(page.get_by_role('region',name='Processed pieces awaiting review')).to_contain_text('PROCESSED-99')
            assert page.locator('input[type=file]').count()==0
            imports=[]
            page.route(origin+'/api/import',lambda route:(imports.append(True),route.fulfill(json={'imported':0})))
            drop=page.evaluate_handle('()=>{const d=new DataTransfer();d.items.add(new File(["photo"],"fixture.jpg",{type:"image/jpeg"}));return d}')
            page.dispatch_event('body','drop',{'dataTransfer':drop})
            expect(page.get_by_text('Add and process photos on the Dashboard.',exact=True)).to_be_visible()
            assert not imports, 'Crosslisting must not import photos'
            page.get_by_role('switch',name='Auto Run',exact=True).click()
            expect(page.get_by_role('switch',name='Auto Run',exact=True)).to_have_attribute('aria-checked','true')
            expect(page.get_by_role('checkbox',name='Depop',exact=True)).not_to_be_enabled()
            expect(page.get_by_role('button',name='Start selected',exact=True)).not_to_be_enabled()
            page.get_by_role('switch',name='Auto Run',exact=True).click()
            expect(page.get_by_role('switch',name='Auto Run',exact=True)).to_have_attribute('aria-checked','false')
            state['error']=True;page.get_by_role('button',name='Refresh',exact=True).click()
            expect(page.locator('main').get_by_role('alert')).to_contain_text('Could not load')
            expect(page.get_by_role('button',name='Start selected',exact=True)).not_to_be_enabled()
            state['error']=False;state['items']=copy.deepcopy(items)
            page.get_by_role('button',name='Try again',exact=True).click()
            page.get_by_role('button',name='Select all ready',exact=True).click()
            expect(page.get_by_role('button',name='Start selected',exact=True)).to_be_enabled()
            expect(page.get_by_text('Depop $24.99 · eBay $19.99 · Etsy $24.99 · Poshmark $25.00 · Mercari $24.99',exact=True)).to_be_visible()
            page.screenshot(path=str(logs/'crosslisting-main-batch.png'),full_page=True)
            state['items']=[];page.get_by_role('button',name='Refresh',exact=True).click()
            expect(page.get_by_role('button',name='Start selected',exact=True)).not_to_be_enabled()
            state['items']=copy.deepcopy(items);page.get_by_role('button',name='Refresh',exact=True).click()
            page.get_by_role('button',name='Select all ready',exact=True).click()
            state['postError']=True;page.get_by_role('button',name='Start selected',exact=True).click()
            expect(page.get_by_text('Fixture upload rejected',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='Start selected',exact=True)).to_be_enabled()
            state['postError']=False;page.get_by_role('button',name='Start selected',exact=True).click()
            expect(page).to_have_url(origin+'/ready/activity')
            expect(page.get_by_role('heading',name='Run #1',exact=True)).to_be_visible()
            assert state['commands'][-1] == {'itemIds':[1],'marketplaces':['depop','ebay','etsy','poshmark','mercari']}
            page.get_by_role('button',name='Pause',exact=True).click()
            expect(page.get_by_role('button',name='Resume',exact=True)).to_be_visible()
            page.get_by_role('button',name='Resume',exact=True).click()
            expect(page.get_by_role('button',name='Pause',exact=True)).to_be_visible()
            page.get_by_role('button',name='Cancel',exact=True).click()
            expect(page.get_by_text('cancelled',exact=True)).to_be_visible()
            state['error']=True;page.reload()
            expect(page.locator('main').get_by_role('alert')).to_contain_text('Could not refresh')
            state['error']=False;page.get_by_role('button',name='Try again',exact=True).click()
            expect(page.get_by_role('heading',name='Run #1',exact=True)).to_be_visible()
            for previous,target in [('/beta/publish','/ready'),('/beta/autopost','/ready/activity'),('/beta/accounts','/ready/accounts'),('/beta','/beta/market'),('/legacy','/legacy/nifty')]:
                page.goto(origin+previous,wait_until='domcontentloaded');expect(page).to_have_url(origin+target)
            expect(page.get_by_role('heading',name='Ready for Nifty',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='open Nifty to log in',exact=True)).to_be_visible()
            page.screenshot(path=str(logs/'upload-legacy-nifty.png'),full_page=True)
            page.goto(origin+'/ready/accounts',wait_until='domcontentloaded')
            expect(page.get_by_label('Enable Depop direct posting',exact=True)).to_be_visible()
            expect(page.get_by_label('Enable Poshmark direct posting',exact=True)).to_be_visible()
            page.get_by_label('Enable Depop direct posting',exact=True).check()
            expect(page.get_by_label('Enable Depop direct posting',exact=True)).to_be_checked()
            page.reload();expect(page.get_by_label('Enable Depop direct posting',exact=True)).to_be_checked()
            state['settingsError']=True
            page.get_by_label('Enable Depop direct posting',exact=True).uncheck()
            expect(page.get_by_text('Fixture settings rejected',exact=True)).to_be_visible()
            expect(page.get_by_label('Enable Depop direct posting',exact=True)).to_be_checked()
            state['settingsError']=False
            page.get_by_label('Keep saved marketplace prices when relisting',exact=True).check()
            expect(page.get_by_text('Relisting prices saved',exact=True)).to_be_visible()
            page.reload()
            expect(page.get_by_label('Keep saved marketplace prices when relisting',exact=True)).to_be_checked()
            expect(page.get_by_label('Mercari unisex department',exact=True)).to_have_value('Women')
            expect(page.get_by_label('Mercari shipping',exact=True)).to_have_value('buyer_label')
            page.get_by_label('Enable Mercari direct posting',exact=True).check()
            page.get_by_role('button',name='Save Mercari settings',exact=True).click()
            expect(page.get_by_text('Mercari settings saved',exact=True)).to_be_visible()
            page.reload();expect(page.get_by_label('Enable Mercari direct posting',exact=True)).to_be_checked()
            page.goto(origin+'/ready',wait_until='domcontentloaded');page.set_viewport_size({'width':900,'height':900})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Upload page overflows the window'
            page.goto(origin+'/',wait_until='domcontentloaded')
            totals=page.get_by_role('region',name='Lifetime sales',exact=True)
            expect(totals).to_contain_text('$40.50')
            expect(totals).to_contain_text('$35.00')
            expect(totals).to_contain_text('$5.50')
            expect(totals.get_by_role('link').nth(1)).to_contain_text('2')
            expect(page.get_by_role('button',name='Upload folder',exact=True)).to_be_visible()
            page.set_viewport_size({'width':1280,'height':1000})
            page.screenshot(path=str(logs/'dashboard-lifetime-sales.png'),full_page=True)
            page.goto('about:blank')
            page.unroute_all(behavior='wait')
            browser.close()
            def api(method, path, payload=None):
                request=Request(base+path,method=method,headers={'Host':'127.0.0.1:41999','Origin':'http://127.0.0.1:41999','Content-Type':'application/json'},data=json.dumps(payload).encode() if payload is not None else None)
                with urlopen(request,timeout=5) as response:return json.load(response)
            actual=api('GET','/api/settings')['settings']
            assert Path(actual['pythonWorkerPath']).resolve()==Path(shutil.which('node')).resolve()
            probe=subprocess.run([shutil.which('node'),'-m','black_cat_worker.post_depop'],capture_output=True,text=True)
            assert probe.returncode!=0 and 'bad option' in probe.stderr, 'Fixture executor must reject Python commands'
            (data/'depop-login-ok.json').write_text('{}')
            api('PATCH','/api/publish/settings',{'depop':{'enabled':True,'autoPost':True}})
            assert not api('GET','/api/publish/auto-run')['config']['enabled']
            api('POST','/api/publish/auto-run',{'enabled':True,'marketplaces':['depop']})
            with closing(sqlite3.connect(database)) as db:
                assert db.execute('SELECT COUNT(*) FROM PublishJob').fetchone()[0]==0, 'Processed items must wait for approval'
            ready=data/'ready-for-nifty'/'RETURNED';(ready/'listing_photos').mkdir(parents=True)
            for number in range(1,5):(ready/'listing_photos'/f'RETURNED_{number:02}.jpg').write_bytes(b'fixture-photo-not-sent')
            with closing(sqlite3.connect(database)) as db:
                db.execute('UPDATE Item SET status=?,brand=?,itemType=?,size=?,condition=?,department=?,color=?,listedPrice=?,readyFolderPath=? WHERE sku=?',
                    ('Ready for Nifty','Fixture','T-Shirt','M','Good','Men','Blue',25,str(ready),'RETURNED'));db.commit()
            deadline=time.monotonic()+30
            while True:
                with closing(sqlite3.connect(database)) as db:jobs=db.execute('SELECT status,marketplace FROM PublishJob').fetchall()
                if jobs and jobs[0][0]=='requires_review':break
                if time.monotonic()>deadline:raise AssertionError(f'New Ready approval was not picked up: {jobs}')
                time.sleep(.2)
            assert jobs==[('requires_review','depop')]
            checked=api('GET','/api/publish/auto-run')['lastCheckedAt'];deadline=time.monotonic()+15
            while api('GET','/api/publish/auto-run')['lastCheckedAt']==checked:
                if time.monotonic()>deadline:raise AssertionError('Auto Run timer stopped')
                time.sleep(.2)
            with closing(sqlite3.connect(database)) as db:assert db.execute('SELECT COUNT(*) FROM PublishRun').fetchone()[0]==1, 'An uncertain attempt must not loop'
            api('POST','/api/publish/auto-run',{'enabled':False,'marketplaces':['depop']})
            print(json.dumps({'emptyAndBatchStates':True,'failedReadsRecover':True,'staleSelectionRemoved':True,
                'failedStartRecovers':True,'exactFivePlatformCommand':True,'pauseResumeCancel':True,
                'oldRoutesRedirect':True,'niftyPreserved':True,'depopSettingsPersist':True,'narrowLayout':True,'autoRunSwitch':True,'dashboardOnlyIntake':True,'lifetimeSalesAndShipping':True,'realSchedulerPickedNewApproval':True,'uncertainAttemptNotRepeated':True}),flush=True)
    finally:
        server.terminate();server.wait(timeout=10)
