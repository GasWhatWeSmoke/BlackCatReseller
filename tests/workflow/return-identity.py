"""Actual Returns UI with identity races in a disposable local database."""
import json,subprocess,tempfile,traceback
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2];base=Path(tempfile.mkdtemp(prefix='blackcat-return-identity-ui-'))
(base/'owner.json').write_text('{"fixture":"return-identity"}')
(Path(tempfile.gettempdir())/'blackcat-return-identity-ui-path.txt').write_text(str(base))
print(json.dumps({'artifacts':str(base)}),flush=True)
with (base/'bundle.log').open('w') as log:subprocess.run(['node',str(root/'tests/workflow/bundle.cjs'),str(base)],cwd=root,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/name).read_text(encoding='utf-8') for name in ['globals.css','depth.css'])
html='<meta charset="utf-8"><style>'+css.replace('@import "tailwindcss";','')+'</style><div id="root"></div><script>'+(base/'workflow.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
proof={'sourceRoot':str(root),'status':'running','actualComponents':True,'directHelpers':True,'syntheticData':True,'noServer':True,'noApiChecks':True,'phases':[],'browserErrors':[],'externalRequests':[]}
log=(base/'backend.log').open('w',encoding='utf-8');proc=subprocess.Popen(['node',str(root/'tests/workflow/return-identity-backend.mjs'),str(base)],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
seq=0;closed=False
def call(op,args=None):
    global seq,closed
    seq+=1
    if op=='close':closed=True
    proc.stdin.write(json.dumps({'id':seq,'op':op,'args':args or {}})+'\n');proc.stdin.flush();reply=json.loads(proc.stdout.readline());assert reply['id']==seq and reply['ok'],reply
    return reply['data']
def phase(name):proof['phases'].append(name);print(json.dumps({'phase':name}),flush=True)
def binding(source,message):
    a=message['args'];url=urlsplit(a['url'])
    if a['method']=='GET' and url.path=='/api/ship-queue':data={'count':3}
    elif a['method']=='GET' and url.path=='/api/sales/returns':data=call('page',{'params':url.query})
    else:assert a['method']=='POST' and url.path=='/api/sales/returns',a;data=call('resolve',a['body'])
    return {'ok':True,'data':data}
try:
    call('seed')
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        context=browser.new_context(viewport={'width':1320,'height':880},reduced_motion='reduce');context.expose_binding('workflowCall',binding)
        context.add_init_script("localStorage.setItem('bca-sound-muted','1')")
        def route(r):
            url=urlsplit(r.request.url)
            if url.netloc=='127.0.0.1:42095' and url.path=='/sales/returns' and r.request.resource_type=='document':r.fulfill(body=html,content_type='text/html');return
            proof['externalRequests'].append(r.request.url);r.abort()
        context.route('**/*',route);page=context.new_page();page.set_default_timeout(15000);page.on('pageerror',lambda e:proof['browserErrors'].append(str(e)))
        def fill(sku):
            row=page.get_by_role('article',name='Review '+sku,exact=True)
            row.get_by_role('checkbox',name='I confirmed the full refund or fully cancelled sale payment.',exact=True).check()
            row.get_by_role('checkbox',name='The item is physically back in my inventory.',exact=True).check()
            row.get_by_label('Unrecovered sale fees · USD',exact=True).fill('1.25');row.get_by_label('Unrecovered postage · USD',exact=True).fill('0')
            return row
        page.goto('http://127.0.0.1:42095/sales/returns');row=fill('RETURN-1')
        call('arm',{'mode':'review'});row.get_by_role('button',name='Confirm return to Review',exact=True).click()
        expect(page.get_by_text('This review changed since it was loaded. Refresh and confirm the original review before making a decision.',exact=True)).to_be_visible()
        state=call('snapshot');assert state['items'][0]['status']=='Sold';assert state['reviews'][0]['action']=='pending_review'
        assert state['calls'][0]['reviewIdentity'];row=page.get_by_role('article',name='Review RETURN-1',exact=True)
        expect(row.get_by_role('checkbox',name='I confirmed the full refund or fully cancelled sale payment.',exact=True)).not_to_be_checked()
        phase('stale review ID replacement rejected; sale kept; recovered inputs do not transfer to replacement identity')
        row=fill('RETURN-1');row.get_by_role('button',name='Confirm return to Review',exact=True).click();expect(row).not_to_be_visible()
        state=call('snapshot');assert state['items'][0]['status']=='Needs Info';assert state['reviews'][0]['action']=='returned'
        assert json.loads(state['reviews'][0]['newValue'])['feeLoss']==1.25
        phase('fresh confirmation returns the original item and records actual costs with matching receipt identity')
        row=fill('RETURN-2');call('arm',{'mode':'item'});row.get_by_role('button',name='Confirm return to Review',exact=True).click()
        expect(page.get_by_text('The original item no longer matches this review. Check the inventory identity before reporting a new review.',exact=True)).to_be_visible()
        state=call('snapshot');assert state['items'][1]['status']=='Sold';assert state['reviews'][1]['action']=='pending_review'
        phase('replacement inventory identity rejected even after the current review loads')
        row=page.get_by_role('article',name='Review RETURN-3',exact=True);row.get_by_role('button',name='Reviewed · keep sale recorded',exact=True).click();expect(row).not_to_be_visible()
        state=call('snapshot');assert state['items'][2]['status']=='Sold';assert state['reviews'][2]['action']=='review_resolved'
        for width in [1320,768,390,320]:
            page.set_viewport_size({'width':width,'height':880});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(base/f'returns-{width}.png'))
        phase('keep-sale confirmation preserves stock; in-person wording and layout checked at four widths')
        assert not proof['browserErrors'],proof['browserErrors'];assert not proof['externalRequests'],proof['externalRequests']
        proof['final']=call('close');proof['status']='passed';browser.close()
except Exception:proof['status']='failed';proof['error']=traceback.format_exc();raise
finally:
    (base/'proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8')
    if not closed and proc.poll() is None:
        try:call('close')
        except Exception:pass
    proc.wait(timeout=30);log.close()
