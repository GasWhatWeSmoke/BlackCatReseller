"""Actual Sales/manual-entry components; isolated callbacks, no server or marketplace actions."""
import json,subprocess,tempfile,re,traceback
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parents[2]
base=Path(tempfile.mkdtemp(prefix='blackcat-manual-sale-workflow-'))
(base/'owner.json').write_text('{"fixture":"manual-sale"}')
(Path(tempfile.gettempdir())/'blackcat-manual-sale-workflow-path.txt').write_text(str(base))
print(json.dumps({'artifacts':str(base)}),flush=True)
with (base/'bundle.log').open('w') as log:
    subprocess.run(['node',str(root/'tests/workflow/bundle.cjs'),str(base)],cwd=root,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/name).read_text(encoding='utf-8') for name in ['globals.css','depth.css'])
html='<meta charset="utf-8"><style>'+css.replace('@import "tailwindcss";','')+'</style><div id="root"></div><script>'+(base/'workflow.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
proof={'sourceRoot':str(root),'status':'running','actualComponents':True,'directHelpers':True,'syntheticData':True,'noServer':True,'noApiChecks':True,'phases':[],'browserErrors':[],'externalRequests':[]}
log=(base/'backend.log').open('w',encoding='utf-8')
proc=subprocess.Popen(['node',str(root/'tests/workflow/manual-sale-backend.mjs'),str(base)],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
seq=0;closed=False
def call(op,args=None):
    global seq,closed
    seq+=1
    if op=='close':closed=True
    proc.stdin.write(json.dumps({'id':seq,'op':op,'args':args or {}})+'\n');proc.stdin.flush()
    reply=json.loads(proc.stdout.readline());assert reply['id']==seq and reply['ok'],reply
    return reply['data']
def phase(name):proof['phases'].append(name);print(json.dumps({'phase':name}),flush=True)
def binding(source,message):
    args=message['args'];url=urlsplit(args['url'])
    if args['method']=='GET' and url.path=='/api/ship-queue':data=call('count')
    elif args['method']=='GET' and url.path=='/api/publish/mercari-goal':data={'tracking':False}
    elif args['method']=='GET' and url.path=='/api/items':data=call('page',{'params':url.query})
    elif args['method']=='GET' and url.path=='/api/past-uploads':data=call('history',{'params':url.query})
    else:
        match=re.fullmatch(r'/api/items/(\d+)',url.path);assert match,args
        data=call('change' if args['method']=='PATCH' else 'item',{'id':int(match.group(1)),'body':args['body']})
    return {'ok':True,'data':data}
key='blackcat.manual-sale.v1'
try:
    call('seed')
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        context=browser.new_context(viewport={'width':1320,'height':880},reduced_motion='reduce')
        context.expose_binding('workflowCall',binding);context.add_init_script("localStorage.setItem('bca-sound-muted','1')")
        def route(r):
            url=urlsplit(r.request.url)
            if url.netloc=='127.0.0.1:42095' and url.path=='/sales' and r.request.resource_type=='document':r.fulfill(body=html,content_type='text/html');return
            proof['externalRequests'].append(r.request.url);r.abort()
        context.route('**/*',route);page=context.new_page();page.set_default_timeout(15000)
        page.on('pageerror',lambda e:proof['browserErrors'].append(str(e)));page.on('dialog',lambda dialog:dialog.accept())
        def load():page.goto('http://127.0.0.1:42095/sales')
        def form(sku,source='in_person'):
            if not page.get_by_label('Exact SKU',exact=True).is_visible():page.get_by_role('button',name='Record a sale',exact=True).click()
            page.get_by_label('Exact SKU',exact=True).fill(sku);page.get_by_role('button',name='Find item',exact=True).click()
            expect(page.get_by_role('button',name='Review sale',exact=True)).to_be_enabled()
            page.get_by_label('Sold through',exact=True).select_option(source)
            page.get_by_label('Item sale price · USD',exact=True).fill('12.34')
            page.get_by_label('Actual fees · USD',exact=True).fill('0')
            page.get_by_label('Order reference or sale note',exact=True).fill('Fixture cash sale')
            if source!='in_person':page.get_by_label('Shipping income received · USD',exact=True).fill('0')
        def save():
            page.get_by_role('button',name='Review sale',exact=True).click()
            page.get_by_role('button',name='Confirm paid sale',exact=True).click()
            expect(page.get_by_role('dialog')).not_to_be_visible()
        load();form('000001')
        page.get_by_role('button',name='Review sale',exact=True).click();assert not call('snapshot')['calls']
        for width in [1320,768,390,320]:
            page.set_viewport_size({'width':width,'height':880});dialog=page.get_by_role('dialog')
            assert dialog.evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            back=dialog.get_by_role('button',name='Back to details');back.focus();assert back.evaluate('(el)=>getComputedStyle(el).outlineStyle')=='solid'
            page.screenshot(path=str(base/f'confirm-{width}.png'))
        page.set_viewport_size({'width':1320,'height':880});page.get_by_role('button',name='Back to details').click()
        load();expect(page.get_by_label('Item sale price · USD',exact=True)).to_have_value('12.34')
        expect(page.get_by_role('button',name='Review sale',exact=True)).to_be_disabled()
        page.get_by_role('button',name='Find item',exact=True).click();expect(page.get_by_role('button',name='Review sale',exact=True)).to_be_enabled();save()
        state=call('snapshot');assert state['items'][0]['status']=='Sold' and state['items'][0]['marketplaceFees']==0
        assert state['listings'][0]['status']=='delist_pending'
        expect(page.get_by_text('Awaiting pickup',exact=True)).to_be_visible()
        page.get_by_role('button',name='Mark handed over',exact=True).click();expect(page.get_by_text('Handed over',exact=True)).to_be_visible()
        page.get_by_role('button',name='Undo handover',exact=True).click();expect(page.get_by_text('Awaiting pickup',exact=True)).to_be_visible()
        phase('four-width confirmation and focus; unsent draft recovery requires fresh item; pickup saved with removal pending; handover and undo')
        page.get_by_role('button',name='Record another sale').click();form('000002','off_platform')
        page.evaluate('''()=>{const original=window.fetch;window.fetch=async(input,init)=>{const response=await original(input,init);if(init?.method==='PATCH'&&JSON.parse(init.body).manualSale)throw Error('Fixture lost reply');return response;};}''')
        save();assert call('snapshot')['items'][1]['status']=='Sold';before=len(call('snapshot')['calls'])
        expect(page.get_by_role('button',name='Check saved sale')).to_be_visible();load()
        assert len(call('snapshot')['calls'])==before
        page.get_by_role('button',name='Check saved sale').click();expect(page.get_by_role('button',name='Record another sale')).to_be_visible()
        assert len(call('snapshot')['calls'])==before
        phase('lost committed reply survives reload and reconciles by receipt without replay')
        page.get_by_role('button',name='Record another sale').click();form('000003')
        page.get_by_role('button',name='Review sale',exact=True).click();call('mutate',{'id':3})
        page.get_by_role('button',name='Confirm paid sale').click();expect(page.get_by_role('dialog')).not_to_be_visible()
        expect(page.get_by_text('000003 · Not saved',exact=True)).to_be_visible();assert call('snapshot')['items'][2]['status']=='Listed'
        phase('stale confirmation rejected without stock mutation')
        page.get_by_role('button',name='Clear draft / report').click();form('000004')
        page.get_by_role('button',name='Review sale',exact=True).click();before=len(call('snapshot')['calls'])
        page.evaluate('''()=>{window.fixtureSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('storage full');};}''')
        page.get_by_role('button',name='Confirm paid sale').click();expect(page.get_by_role('dialog').get_by_role('alert')).to_be_visible()
        assert len(call('snapshot')['calls'])==before
        page.evaluate('()=>{Storage.prototype.setItem=window.fixtureSetItem;}');page.get_by_role('button',name='Back to details').click()
        phase('storage failure before confirmation blocks the write')
        page.evaluate('(key)=>localStorage.setItem(key,"broken report")',key);load()
        expect(page.get_by_text('The saved sale draft could not be read. Check Sales before clearing it.',exact=True)).to_be_visible()
        expect(page.get_by_label('Exact SKU',exact=True)).to_be_disabled()
        assert page.evaluate('(key)=>localStorage.getItem(key)',key)=='broken report'
        assert len(call('snapshot')['calls'])==before
        page.screenshot(path=str(base/'sales-report.png'))
        phase('corrupt report is visible and never replayed')
        assert not proof['browserErrors'],proof['browserErrors'];assert not proof['externalRequests'],proof['externalRequests']
        proof['final']=call('close');proof['status']='passed';browser.close()
except Exception:
    proof['status']='failed';proof['error']=traceback.format_exc();raise
finally:
    (base/'proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8')
    if not closed and proc.poll() is None:
        try:call('close')
        except Exception:pass
    proc.wait(timeout=30);log.close()
