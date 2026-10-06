"""Actual Inventory archive workflow with local callbacks and an owned SQLite fixture."""
import json,subprocess,tempfile,time,re,traceback
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parents[2]
base=Path(tempfile.mkdtemp(prefix='blackcat-archive-workflow-'))
(base/'owner.json').write_text('{"fixture":"archive-workflow"}')
(Path(tempfile.gettempdir())/'blackcat-archive-workflow-path.txt').write_text(str(base))
print(json.dumps({'artifacts':str(base)}),flush=True)
with (base/'bundle.log').open('w') as log:
    subprocess.run(['node',str(root/'tests/workflow/bundle.cjs'),str(base)],cwd=root,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/name).read_text(encoding='utf-8') for name in ['globals.css','depth.css'])
html='<meta charset="utf-8"><style>'+css.replace('@import "tailwindcss";','')+'</style><div id="root"></div><script>'+(base/'workflow.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
proof={'sourceRoot':str(root),'status':'running','actualComponents':True,'directHelpers':True,'syntheticData':True,'noServer':True,'noApiChecks':True,'phases':[],'browserErrors':[],'externalRequests':[]}
log=(base/'backend.log').open('w',encoding='utf-8')
proc=subprocess.Popen(['node',str(root/'tests/workflow/archive-backend.mjs'),str(base)],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
seq=0;closed=False
def call(op,args=None):
    global seq,closed
    seq+=1
    if op=='close':closed=True
    proc.stdin.write(json.dumps({'id':seq,'op':op,'args':args or {}})+'\n');proc.stdin.flush()
    line=proc.stdout.readline()
    if not line:raise RuntimeError('Archive fixture backend stopped; inspect backend.log')
    reply=json.loads(line);assert reply['id']==seq and reply['ok'],reply
    return reply['data']
def phase(name):
    proof['phases'].append(name);print(json.dumps({'phase':name}),flush=True)
def binding(source,message):
    args=message['args'];url=urlsplit(args['url'])
    if args['method']=='GET' and url.path=='/api/ship-queue':data={'count':0}
    elif args['method']=='GET' and url.path=='/api/items':data=call('page',{'params':url.query})
    else:
        match=re.fullmatch(r'/api/items/(\d+)',url.path)
        assert args['method']=='PATCH' and match and list(args['body'])==['bulkArchive'],args
        data=call('change',{'id':int(match.group(1)),'body':args['body']})
    return {'ok':True,'data':data}
def items():return {row['sku']:row for row in call('snapshot')['items']}
key='blackcat.inventory.bulk-archive.v1'
try:
    seeded=call('seed');assert len(seeded['items'])==100
    ids={row['sku']:row['id'] for row in seeded['items']}
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        context=browser.new_context(viewport={'width':1320,'height':880},reduced_motion='reduce')
        context.expose_binding('workflowCall',binding);context.add_init_script("localStorage.setItem('bca-sound-muted','1')")
        def route(r):
            url=urlsplit(r.request.url)
            if url.netloc=='127.0.0.1:42095' and url.path=='/inventory' and r.request.resource_type=='document':r.fulfill(body=html,content_type='text/html');return
            if url.netloc=='127.0.0.1:42095' and url.path=='/api/thumb' and r.request.resource_type=='image':
                photo=Path(parse_qs(url.query)['path'][0]).resolve();assert photo.is_relative_to(base.resolve()) and photo.suffix=='.jpg'
                r.fulfill(body=photo.read_bytes(),content_type='image/jpeg');return
            proof['externalRequests'].append(r.request.url);r.abort()
        context.route('**/*',route);page=context.new_page();page.set_default_timeout(15000)
        page.on('pageerror',lambda e:proof['browserErrors'].append(str(e)));page.on('dialog',lambda dialog:dialog.accept())
        def load(clear=False):
            if clear:page.evaluate('(key)=>localStorage.removeItem(key)',key)
            page.goto('http://127.0.0.1:42095/inventory?pageSize=100')
            expect(page.locator('[aria-label="Inventory results"] article')).to_have_count(100)
        def choose(skus):
            for sku in skus:page.get_by_role('checkbox',name='Select '+sku,exact=True).check()
            page.get_by_role('button',name='Archive selected',exact=True).click()
        def confirm():
            page.get_by_role('button',name='Confirm archive',exact=True).click()
            expect(page.get_by_role('dialog')).not_to_be_visible(timeout=30000)
        load();page.get_by_role('button',name='Select this page (100)',exact=True).click();page.get_by_role('button',name='Archive selected',exact=True).click()
        assert not call('snapshot')['calls'],'Confirmation view must not mutate'
        for width in [1320,768,390,320]:
            page.set_viewport_size({'width':width,'height':880});dialog=page.get_by_role('dialog')
            assert dialog.evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            cancel=dialog.get_by_role('button',name='Cancel',exact=True);cancel.focus();assert cancel.evaluate('(el)=>getComputedStyle(el).outlineStyle')=='solid'
            page.screenshot(path=str(base/f'archive-confirm-{width}.png'))
        page.set_viewport_size({'width':1320,'height':880});confirm()
        state=items();assert sum(row['status']=='Archived' for row in state.values())==95
        receipt=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',key)
        assert len(receipt['results'])==100 and sum(row['kind']=='saved' for row in receipt['results'])==95 and sum(row['kind']=='blocked' for row in receipt['results'])==5
        phase('100-item confirmation; 95 archived and five protected with per-item results; four-width dialog and focus')
        page.get_by_role('button',name='Restore confirmed archives to Review',exact=True).click();page.get_by_role('button',name='Confirm restore to Review',exact=True).click()
        expect(page.get_by_role('dialog')).not_to_be_visible(timeout=30000)
        state=items();assert sum(row['status']=='Photographed' for row in state.values())==95
        assert all(row['readyFolderPath'] is None for row in state.values() if row['status']=='Photographed')
        phase('95 confirmed archives restored to Review with readiness cleared')

        load(clear=True);choose(['ARC-001','ARC-002','ARC-003']);before=len(call('snapshot')['calls'])
        page.evaluate('''id=>{const original=window.fetch;window.fetch=async(input,init)=>{const result=await original(input,init);if(init?.method==='PATCH'&&String(input).endsWith('/'+id))throw Error('Fixture lost response');return result;};}''',ids['ARC-002'])
        confirm();assert len(call('snapshot')['calls'])==before+2
        state=items();assert state['ARC-001']['status']==state['ARC-002']['status']=='Archived' and state['ARC-003']['status']=='Photographed'
        receipt=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',key);assert [row['kind'] for row in receipt['results']]==['saved','unknown']
        load();assert len(call('snapshot')['calls'])==before+2
        expect(page.get_by_text('1 item(s) not attempted.',exact=True)).to_be_visible()
        phase('lost committed response stops further items; reload never replays it')

        load(clear=True);choose(['ARC-003']);call('mutate',{'id':ids['ARC-003']});confirm()
        assert items()['ARC-003']['status']=='Photographed'
        receipt=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',key);assert receipt['results'][0]['kind']=='blocked'
        phase('concurrent edit rejects stale archive confirmation')

        load(clear=True);choose(['ARC-004','ARC-005']);before=len(call('snapshot')['calls'])
        page.evaluate('''()=>{const original=window.fetch;window.fetch=async(input,init)=>{const result=await original(input,init);if(init?.method==='PATCH'){window.archiveHeld=true;await new Promise(resolve=>window.releaseArchive=resolve);}return result;};}''')
        page.get_by_role('button',name='Confirm archive',exact=True).click();page.wait_for_function('window.archiveHeld===true')
        page.get_by_role('button',name='Stop after current item',exact=True).click()
        expect(page.get_by_role('dialog').get_by_text('Stopping after the current item.',exact=True)).to_be_visible()
        page.evaluate('window.releaseArchive()');expect(page.get_by_role('dialog')).not_to_be_visible()
        assert len(call('snapshot')['calls'])==before+1 and items()['ARC-005']['status']=='Photographed'
        phase('stop-after-current preserves the in-flight receipt and leaves the next item untouched')

        load(clear=True);choose(['ARC-005','ARC-006']);before=len(call('snapshot')['calls'])
        page.evaluate('''()=>{const original=window.fetch;window.fetch=async(input,init)=>{const result=await original(input,init);if(init?.method==='PATCH'){window.archiveHeld=true;await new Promise(()=>{});}return result;};}''')
        page.get_by_role('button',name='Confirm archive',exact=True).click();page.wait_for_function('window.archiveHeld===true');page.reload()
        expect(page.get_by_text('This batch was interrupted. Check unrecorded outcomes in Inventory; nothing was replayed.',exact=True)).to_be_visible()
        assert len(call('snapshot')['calls'])==before+1
        state=items();assert state['ARC-005']['status']=='Archived' and state['ARC-006']['status']=='Photographed'
        phase('refresh during an unrecorded response restores an interrupted report without replay')

        load(clear=True);choose(['ARC-006']);before=len(call('snapshot')['calls'])
        page.evaluate('''key=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Fixture quota','QuotaExceededError');return original.call(this,k,v)};}''',key)
        confirm();assert len(call('snapshot')['calls'])==before and items()['ARC-006']['status']=='Photographed'
        expect(page.get_by_text('The batch stopped because its results could not be saved. Check Inventory before another attempt; no unfinished action will be replayed.',exact=True)).to_be_visible()
        phase('report-storage denial prevents the first mutation')

        load(clear=True);choose(['ARC-006','ARC-007']);before=len(call('snapshot')['calls'])
        page.evaluate('''key=>{const original=Storage.prototype.setItem;let count=0;Storage.prototype.setItem=function(k,v){if(k===key&&++count===2)throw new DOMException('Fixture quota','QuotaExceededError');return original.call(this,k,v)};}''',key)
        confirm();assert len(call('snapshot')['calls'])==before+1
        load();expect(page.get_by_text('This batch was interrupted. Check unrecorded outcomes in Inventory; nothing was replayed.',exact=True)).to_be_visible()
        state=items();assert state['ARC-006']['status']=='Archived' and state['ARC-007']['status']=='Photographed'
        phase('storage failure after one mutation stops the batch and survives reload honestly')

        load(clear=True);page.evaluate('(key)=>localStorage.setItem(key,"{broken")',key);load();choose(['ARC-007'])
        expect(page.get_by_role('button',name='Confirm archive',exact=True)).to_be_disabled()
        assert page.evaluate('(key)=>localStorage.getItem(key)',key)=='{broken'
        page.get_by_role('dialog').get_by_role('button',name='Clear unreadable report',exact=True).click();confirm()
        assert items()['ARC-007']['status']=='Archived'
        phase('corrupt report is retained until explicitly cleared, then a newly confirmed batch can proceed')
        assert not proof['browserErrors'],proof['browserErrors'];assert not proof['externalRequests'],proof['externalRequests'];browser.close()
    proof['final']=call('close');proc.wait(timeout=15);assert proc.returncode==0
    proof['status']='complete'
except BaseException:
    proof['status']='failed';proof['error']=traceback.format_exc();raise
finally:
    if proc.poll() is None and not closed:
        try:proof['final']=call('close');proc.wait(timeout=15)
        except Exception:pass
    (base/'proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8');log.close()
print(json.dumps({'status':proof['status'],'phases':len(proof['phases']),'artifacts':str(base)}),flush=True)
