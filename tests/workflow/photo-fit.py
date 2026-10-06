import io,json,subprocess,tempfile,sys
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from PIL import Image,ImageDraw
from playwright.sync_api import sync_playwright,expect
from photo_geometry import assert_photo_contained
root=Path(__file__).resolve().parents[2];base=Path(tempfile.mkdtemp(prefix='blackcat-photo-fit-'));print(str(base),flush=True)
subprocess.run(['node',str(root/'tests/workflow/photo-fit.cjs'),str(base)],cwd=root,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
colors=[(255,40,40),(40,255,40),(40,40,255),(255,255,40)];pictures={}
for name,(w,h) in {'wide':(1800,600),'portrait':(600,1800),'square':(900,900)}.items():
 im=Image.new('RGB',(w,h),(50,50,50));draw=ImageDraw.Draw(im);a=w//5;b=h//5
 for rectangle,color in zip([(0,0,a,b),(w-a,0,w-1,b),(0,h-b,a,h-1),(w-a,h-b,w-1,h-1)],colors):draw.rectangle(rectangle,fill=color)
 out=io.BytesIO();im.save(out,format='PNG');pictures[name]=out.getvalue()
css=(root/'node_modules/tailwindcss/preflight.css').read_text()+'\n'+'\n'.join((root/'src/app'/p).read_text(encoding='utf-8') for p in ['globals.css','depth.css']).replace('@import "tailwindcss";','')
html='<meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+(base/'photo-fit.bundle.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script>'
proof={'actualReviewComponent':True,'noServer':True,'externalRequests':[],'rows':[]};errors=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe');ctx=browser.new_context(viewport={'width':900,'height':880},reduced_motion='reduce')
 def route(r):
  url=urlsplit(r.request.url)
  if url.netloc!='127.0.0.1:42095':proof['externalRequests'].append(r.request.url);r.abort()
  elif r.request.resource_type=='document':r.fulfill(body=html,content_type='text/html')
  elif url.path=='/broken.png':
   if 'refresh=' in url.query:r.fulfill(body=pictures['portrait'],content_type='image/png')
   else:r.fulfill(status=404,body='missing')
  elif r.request.resource_type=='image':r.fulfill(body=pictures[parse_qs(url.query)['path'][0]],content_type='image/png')
  else:raise AssertionError(r.request.url)
 ctx.route('**/*',route);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 for width in [900,390,320]:
  page.set_viewport_size({'width':width,'height':880});page.goto('http://127.0.0.1:42095/')
  for photo in range(1,4):
   page.get_by_role('button',name=f'Select photo {photo}',exact=True).click()
   hero=page.get_by_role('button',name='Enlarge selected item photo',exact=True)
   expect(hero.locator('img')).to_be_visible();hero.locator('img').evaluate('(el)=>el.decode()')
   for rotation in [90,180,270,0]:
    assert hero.locator('img').evaluate('(el)=>el.style.transform').endswith(f'rotate({rotation}deg)')
    assert_photo_contained(hero.locator('img'))
    raw=hero.screenshot();im=Image.open(io.BytesIO(raw)).convert('RGB');histogram={color:count for count,color in im.getcolors(im.width*im.height)};counts=[histogram.get(c,0) for c in colors]
    (base/f'hero-{width}-{photo}-{rotation}.png').write_bytes(raw)
    assert all(n>5 for n in counts),{'width':width,'photo':photo,'rotation':rotation,'cornerPixels':counts}
    proof['rows'].append({'width':width,'photo':photo,'rotation':rotation,'cornerPixels':counts})
    page.get_by_role('button',name='Rotate',exact=True).click()
   assert page.evaluate('document.documentElement.scrollWidth')<=width
  retry=page.get_by_role('button',name='Retry image',exact=True);expect(retry).to_be_visible();retry.click();expect(page.get_by_alt_text('Retry fixture',exact=True)).to_be_visible()
  page.get_by_alt_text('Retry fixture',exact=True).evaluate('(el)=>el.decode()')
  page.get_by_role('button',name='Select photo 1',exact=True).click();hero.click()
  dialog=page.get_by_role('dialog');expect(dialog).to_be_visible()
  frame=page.get_by_role('region',name='Photo viewing area',exact=True)
  expect(page.get_by_role('button',name='Fit',exact=True)).to_be_enabled()
  expect(frame).to_have_attribute('data-pannable','false')
  page.get_by_role('button',name='100%',exact=True).click();expect(frame).to_have_attribute('data-pannable','true')
  page.get_by_role('button',name='Fit',exact=True).click();expect(frame).to_have_attribute('data-pannable','false')
  page.get_by_role('button',name='Next photo',exact=True).click()
  expect(dialog.get_by_alt_text('FIT-FIXTURE, photo 2',exact=True)).to_be_visible()
  page.keyboard.press('Escape');expect(dialog).not_to_be_visible();expect(hero).to_be_focused()
 assert not errors,errors;assert not proof['externalRequests'];browser.close()
proof['errors']=errors;proof['retryWorks']=True;proof['viewerZoomNavigationFocus']=True;(base/'proof.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof),flush=True)
