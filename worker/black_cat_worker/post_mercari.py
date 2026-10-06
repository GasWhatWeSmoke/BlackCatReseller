"""Native Mercari publication using the existing approved Chrome connection."""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit
from .publish_progress import progress
from . import config
from .chrome_editor import new_chrome_editor
from .direct_listing import canonical_item_and_photos, read_listing_input
from .publish_guard import assert_publish_authorized
from .mercari_form import CREATE_URL, attach_photos, fill_listing, verify_listing_fields, listing_id, photo_key, photo_keys, field, value_of
from .mercari_photos import upload_photo_copies


def check_listing_limit(page):
    notice=page.locator('main').get_by_text(re.compile(r'^Currently you are limited to \d+ listings\. This will be increased as you complete more sales\.$'))
    for index in range(notice.count()):
        if notice.nth(index).is_visible():
            raise ValueError('Mercari account listing limit reached: '+notice.nth(index).inner_text().strip())


def submitted_url(page):
    value=page.wait_for_function(r'''()=>{
      const valid=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.mercari.com'&&/^\/us\/item\/m\d{9,15}\/?$/.test(u.pathname)}catch{return false}};
      if(valid(location.href))return location.href;
      const confirmed=location.pathname.match(/^\/sell\/confirmation\/(m\d{9,15})\/?$/);
      if(location.origin==='https://www.mercari.com'&&confirmed&&/Your listing is live\./.test(document.querySelector('main')?.innerText||''))
        return 'https://www.mercari.com/us/item/'+confirmed[1]+'/';
      const limit=(document.querySelector('main')?.innerText||'').split(/\n/).find(line=>/^Currently you are limited to \d+ listings\. This will be increased as you complete more sales\.$/.test(line.trim()));
      if(limit)return {listingLimit:limit.trim()};
      const links=[...document.querySelectorAll('a[href]')].filter(e=>e.getClientRects().length&&/^view (?:item|listing)$/i.test(e.textContent.trim())).map(e=>e.href).filter(valid);
      return new Set(links).size===1?links[0]:false;
    }''',timeout=120000).json_value()
    if isinstance(value,dict) and value.get('listingLimit'):
        raise ValueError('Mercari account listing limit reached: '+value['listingLimit'])
    identifier=listing_id(value)
    if not identifier:raise ValueError('Mercari did not identify the submitted listing')
    return f'https://www.mercari.com/us/item/{identifier}/'


def verify_public_listing(page,url,filled,cover,timeout=30000):
    from playwright.sync_api import expect
    identifier=listing_id(url)
    response=page.goto(url,wait_until='domcontentloaded',timeout=timeout)
    if not identifier or not response or response.status!=200 or listing_id(page.url)!=identifier:
        raise ValueError('Mercari public listing did not load at the submitted identity')
    expect(page.get_by_role('heading',name=filled['title'],level=1,exact=True)).to_be_visible(timeout=timeout)
    images=page.locator('main img,[data-testid="item-gallery"] img')
    images.first.wait_for(timeout=timeout)
    if cover not in [photo_key(value) for value in images.evaluate_all('els=>els.filter(e=>e.complete&&e.naturalWidth>0).map(e=>e.currentSrc||e.src)')]:
        raise ValueError('Mercari public cover does not match the uploaded item')
    price=page.locator('[data-testid="item-price"], [data-testid="product-info-price"], main [itemprop="price"]')
    expect(price).to_have_count(1,timeout=timeout)
    text=price.get_attribute('content') or price.inner_text()
    match=re.fullmatch(r'\s*\$?([\d,]+(?:\.\d{1,2})?)\s*',text)
    if not match or abs(float(match[1].replace(',',''))-filled['price'])>.001:raise ValueError('Mercari public price differs from the reviewed price')
    buy=page.get_by_role('button',name=re.compile(r'^(Buy now|Buy)$',re.I)).or_(page.get_by_role('link',name=re.compile(r'^(Buy now|Buy)$',re.I)))
    expect(buy).to_have_count(1,timeout=timeout);expect(buy).to_be_visible();expect(buy).to_be_enabled()
    sold=page.get_by_role('button',name=re.compile(r'^(Item sold|Sold out)$',re.I))
    if sold.count() and sold.first.is_visible():raise ValueError('Mercari listing is not available for purchase')
    return f'https://www.mercari.com/us/item/{identifier}/'


def run_on_page(page,item,photos,options,ship_from,mode,authorize,verify=verify_public_listing):
    report = None
    try:
        with upload_photo_copies(photos) as prepared:
            report = _run_on_page(page,item,prepared,options,ship_from,mode,authorize,verify)
        return report
    except Exception as error:
        if report is not None: return {**report,'message':'Photo cleanup needs attention'}
        return {'outcome':'failed','submissionStarted':False,'reason':f'{type(error).__name__}: {str(error)[:1500]}'}


def _run_on_page(page,item,photos,options,ship_from,mode,authorize,verify):
    submitted=False;candidate=None
    try:
        if mode not in {'fill','post'}:raise ValueError('Invalid Mercari posting mode')
        if mode=='post':authorize()
        progress('opening')
        page.get_by_label(re.compile(r'^(Title|What are you selling\?)(?:\s*\*)?$',re.I)).wait_for(timeout=30000)
        check_listing_limit(page)
        if str(value_of(field(page,['Title','What are you selling?']))).strip() or str(value_of(field(page,['Description','Describe your item']))).strip():
            raise ValueError('Mercari restored an existing draft; review it before starting a new item')
        progress('photos', len(photos))
        uploaded=attach_photos(page,photos)
        progress('details')
        filled=fill_listing(page,item,options,ship_from)
        if filled.get('native'):
            filled['coverPath']=str(photos[0]);filled['photoPaths']=[str(path) for path in photos]
        progress('checking')
        verify_listing_fields(page,item,filled)
        if photo_keys(page)!=uploaded:raise ValueError('Mercari photo order or contents changed before submission')
        from playwright.sync_api import expect
        final=page.get_by_role('button',name=re.compile(r'^(List|List item|List now)$',re.I))
        expect(final).to_have_count(1);expect(final).to_be_enabled()
        check_listing_limit(page)
        if mode=='fill':return {'outcome':'filled','submissionStarted':False,'uploadedPhotos':len(uploaded),'message':'Mercari form checked; List was not clicked.'}
        progress('publishing')
        authorize();submitted=True;final.click()
        progress('verifying')
        candidate=submitted_url(page)
        verified=verify(page,candidate,filled,uploaded[0])
        if listing_id(verified)!=listing_id(candidate):raise ValueError('Mercari verification returned another listing')
        return {'outcome':'posted','submissionStarted':True,'url':verified,'uploadedPhotos':len(uploaded)}
    except Exception as error:
        return {'outcome':'failed','submissionStarted':submitted,**({'url':candidate} if candidate else {}),'reason':f'{type(error).__name__}: {str(error)[:1500]}'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--sku',required=True)
    parser.add_argument('--mode',choices=['fill','post'],default='fill');parser.add_argument('--listing-stdin',action='store_true',required=True)
    args=parser.parse_args();report={'outcome':'failed','submissionStarted':False}
    try:
        item,photos=canonical_item_and_photos(read_listing_input(sys.stdin.buffer),args.sku)
        settings=config.load_settings();options=settings.get('publish',{}).get('mercari',{})
        if options.get('enabled') is not True:raise ValueError('Enable Mercari in Crosslisting first')
        authorize=lambda:assert_publish_authorized(item.get('itemId'),item['sku'],'mercari', photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
        if args.mode=='post':authorize()
        from playwright.sync_api import sync_playwright
        from .assisted_browser import find_real_chrome
        with sync_playwright() as pw:
            def verify(_page,url,filled,cover):
                if filled.get('native'):
                    from .mercari_native_form import verify_posted
                    return verify_posted(_page,url,filled,filled['coverPath'])
                # A seller-only preview is not public publication proof. No
                # seller cookies are copied to this short-lived public browser.
                public=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
                try:return verify_public_listing(public.new_page(),url,filled,cover)
                finally:public.close()
            with new_chrome_editor(pw,CREATE_URL,timeout=60000) as page:
                report=run_on_page(page,item,photos,options,settings.get('mercariShipFrom',{}),args.mode,authorize,verify)
                if report.get('outcome') == 'failed':
                    try:
                        logs=Path(settings.get('logsPath') or Path(settings['dataRoot'])/'logs')
                        logs.mkdir(parents=True,exist_ok=True)
                        location=urlsplit(page.url)
                        if location.hostname=='www.mercari.com' and not page.locator('input[type="password"]:visible').count():
                            page.screenshot(path=str(logs/f'mercari-{args.sku}-fail.png'),full_page=True)
                            snapshot={'url':location._replace(query='',fragment='').geturl(),
                                      'headings':page.get_by_role('heading').all_inner_texts(),
                                      'alerts':page.locator('[role="alert"],[role="dialog"]').all_inner_texts(),
                                      'listingText':page.locator('main').inner_text()[:8000]}
                            (logs/f'mercari-{args.sku}-failure.json').write_text(json.dumps(snapshot,indent=2),encoding='utf-8')
                    except Exception: pass  # Diagnostic failure must not change submission uncertainty.
    except Exception as error:
        if report.get('outcome')=='posted':report['message']='Mercari publication verified; browser cleanup needs attention'
        else:report={**report,'reason':f'{type(error).__name__}: {str(error)[:1500]}'}
    print('MERCARI_DONE '+json.dumps(report),flush=True)
    return 0 if report['outcome'] in {'posted','filled'} else 1


if __name__=='__main__':raise SystemExit(main())
