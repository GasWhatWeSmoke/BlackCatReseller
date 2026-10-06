"""Fixed-price eBay posting through Chrome; no marketplace API credentials."""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .publish_progress import progress
from . import config
from .chrome_editor import new_chrome_editor
from .direct_listing import canonical_item_and_photos, read_listing_input
from .publish_guard import assert_publish_authorized
from .ebay_form import CREATE_URL, open_form, attach_photos, fill_listing_fields, verify_listing_fields, image_key, norm, category_for, reviewed_inseam, reviewed_outer_shell_material


def listing_id(value):
    if not isinstance(value, str): return None
    try:
        url = urlsplit(value)
        match = re.fullmatch(r'/itm/(?:[^/]+/)?(\d{9,15})/?', url.path)
        return match[1] if url.scheme == 'https' and url.hostname in {'www.ebay.com','ebay.com'} and not url.port and not url.username and not url.password and match else None
    except (TypeError,ValueError): return None


def submitted_url(page, title=None, timeout=15000, cover=None):
    from playwright.sync_api import TimeoutError as BrowserTimeout, expect
    try:
        value = page.wait_for_function("""()=>{
          const valid=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['www.ebay.com','ebay.com'].includes(u.hostname)&&/^\\/itm\\/(?:[^/]+\\/)?\\d{9,15}\\/?$/.test(u.pathname)}catch{return false}};
          if(valid(location.href))return location.href;
          const links=[...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length&&/view (?:your )?listing/i.test(a.textContent)).map(a=>a.href).filter(valid);
          const unique=[...new Set(links)];return unique.length===1?unique[0]:false;
        }""", timeout=timeout).json_value()
    except BrowserTimeout:
        if not title: raise
        from .seller_removal import open_inventory
        for attempt in range(2):
            try:
                open_inventory(page, 'ebay')
                break
            except ValueError as error:
                location = urlsplit(page.url)
                if (str(error) != 'Seller inventory did not load; sign in to the selling account'
                        or location.hostname != 'www.ebay.com'
                        or any(part in location.path for part in ('signin', 'splashui', 'captcha'))):
                    raise
                if attempt:
                    raise ValueError('eBay seller inventory remained unavailable during publication verification') from error
                # Retry only this verification read. Never return to List it.
                page.wait_for_timeout(1000)
        root = page.locator('main, #listings-content-target')
        search = root.get_by_label(re.compile(r'^(Search|Search listings|Search by title, SKU,? or item (?:ID|number))$', re.I))
        expect(search).to_have_count(1)
        # Seller Hub's keyword search fails on literal percent signs. Keep the
        # actual title unchanged and still require its exact result-row link.
        search.fill(title.replace('%', '')); search.press('Enter')
        row = root.locator('tr,[role="row"]').filter(has=page.get_by_role('link', name=title, exact=True))
        if cover:
            # Distinct pieces can have identical titles. Seller Hub's thumbnail
            # retains the uploaded image ID, so bind the row to this attempt.
            from time import monotonic
            deadline = monotonic() + 30
            while True:
                images = row.evaluate_all("rows=>rows.map(r=>[...r.querySelectorAll('img')].map(i=>i.currentSrc||i.src))")
                matching = [index for index, sources in enumerate(images) if cover in {image_key(value) for value in sources}]
                if len(matching) > 1: raise ValueError('eBay inventory has multiple matching title and cover rows')
                if len(matching) == 1:
                    row = row.nth(matching[0])
                    break
                if monotonic() >= deadline: raise ValueError('eBay inventory did not identify the submitted title and cover')
                page.wait_for_timeout(300)
        expect(row).to_have_count(1, timeout=30000)
        ids = {listing_id(href) for href in row.locator('a[href*="/itm/"]').evaluate_all('els=>els.map(e=>e.href)')}
        if len(ids) != 1 or None in ids: raise ValueError('eBay active inventory did not identify one submitted item')
        value = f'https://www.ebay.com/itm/{ids.pop()}'
    identifier = listing_id(value)
    if not identifier: raise ValueError('eBay did not identify the submitted listing')
    return f'https://www.ebay.com/itm/{identifier}'


def verify_listing(page, url, filled, cover, timeout=30000):
    from playwright.sync_api import expect
    identifier = listing_id(url)
    if not identifier: raise ValueError('A valid eBay listing identity is required')
    response = page.goto(url, wait_until='domcontentloaded', timeout=timeout)
    if not response or response.status != 200 or listing_id(page.url) != identifier:
        raise ValueError('eBay did not load the submitted listing')
    heading = page.get_by_role('heading', name=re.compile(r'^(?:Details about\s+)?' + re.escape(filled['title']) + '$'), level=1)
    expect(heading).to_be_visible(timeout=timeout)
    images = page.locator('.ux-image-carousel img, [data-testid="image-carousel"] img')
    expect(images).not_to_have_count(0, timeout=timeout)
    keys = images.evaluate_all('els=>els.map(e=>e.getAttribute("data-zoom-src")||e.currentSrc||e.src||e.getAttribute("data-src"))')
    actual_photos = list(dict.fromkeys(key for value in keys if (key := image_key(value))))
    expected_photos = filled.get('photoKeys')
    if expected_photos:
        if actual_photos != expected_photos: raise ValueError('eBay product photos or their order do not match this item')
    elif cover not in actual_photos: raise ValueError('eBay product photo does not match this item')
    price = page.locator('.x-price-primary')
    expect(price).to_have_count(1, timeout=timeout)
    from decimal import Decimal
    match = re.fullmatch(r'(?:US\s*)?\$\s*([\d,]+\.\d{2})', price.inner_text().strip())
    if not match or Decimal(match[1].replace(',', '')) != Decimal(str(filled['price'])):
        raise ValueError('eBay published price does not match the verified form')
    specifics_heading = page.get_by_role('heading', name='Item specifics', exact=True)
    specifics = specifics_heading.locator('xpath=ancestor::*[self::section or contains(concat(" ",normalize-space(@class)," ")," ux-layout-section-evo ") or contains(concat(" ",normalize-space(@class)," ")," ux-layout-section-module-evo ")][1]')
    expect(specifics).to_have_count(1, timeout=timeout)
    values = specifics.evaluate("""section=>{
      const values=[...section.querySelectorAll('dl dt')].flatMap(e=>{
        const value=e.nextElementSibling;return value?.tagName==='DD'?[{label:e.innerText,value:value.innerText}]:[];
      });
      for(const row of section.querySelectorAll('tr')){const cells=[...row.querySelectorAll('th,td')];for(let i=0;i+1<cells.length;i+=2)values.push({label:cells[i].innerText,value:cells[i+1].innerText});}
      return values;
    }""")
    for label in ['Brand','Department','Size','Size Type','Color','Sleeve Length','Skirt Length','Dress Length','Inseam','Outer Shell Material','Style']:
        if label not in filled['specifics']: continue
        aliases = [norm(label)] + (['usshoesize'] if label == 'Size' else ['colour','exteriorcolor'] if label == 'Color' else [])
        actual = {norm(row['value']) for row in values if norm(row['label']) in aliases}
        if actual != {norm(filled['specifics'][label])}: raise ValueError(f'eBay published {label} does not match the verified form')
    crumbs = page.locator('nav[aria-label*="breadcrumb" i] a:visible,.seo-breadcrumb a:visible,.breadcrumbs a:visible')
    labels = [norm(value) for value in crumbs.all_inner_texts()]
    # The editor nests Boys under Kids; the public breadcrumb omits Kids.
    branch = norm(filled['category'][2] if filled['category'][1:3] == ['Kids', 'Boys'] else filled['category'][1])
    if not any(value == branch or value.startswith(branch + 's') for value in labels) or not any(value.endswith(norm(filled['category'][-1])) for value in labels):
        raise ValueError('eBay published category could not be confirmed')
    state, _ = listing_availability(page, identifier)
    if state != 'active': raise ValueError('eBay did not confirm that the published listing is active')
    return f'https://www.ebay.com/itm/{identifier}'


def listing_availability(page, identifier):
    from playwright.sync_api import expect
    if listing_id(page.url) != identifier: raise ValueError('eBay listing identity changed')
    url = f'https://www.ebay.com/itm/{identifier}'
    ended_notice = page.locator('.ux-layout-section__textual-display--statusMessage').filter(has_text=re.compile(r'^\s*You ended this listing on ', re.I))
    if ended_notice.count() == 1 and ended_notice.is_visible():
        relist = ended_notice.get_by_role('link', name='Relist', exact=True)
        if relist.count() != 1: raise ValueError('eBay ended notice does not identify its listing')
        target = urlsplit(relist.get_attribute('href') or '')
        query = parse_qs(target.query)
        if not (target.scheme == 'https' and target.hostname == 'www.ebay.com' and not target.port
                and not target.username and not target.password and target.path == '/sl/list'
                and query.get('itemId') == [identifier] and query.get('mode') == ['RelistItem']):
            raise ValueError('eBay ended notice identifies a different listing')
        return 'unavailable', url
    expect(page.get_by_role('heading', level=1)).to_be_visible(timeout=15000)
    ended = page.locator('.vim.d-vi-evo-region, .d-vi-alert, [role="status"], [role="alert"]').filter(
        has_text=re.compile(r'This listing (?:was|has) ended|This listing sold|This item is no longer available', re.I))
    buy = page.get_by_role('link', name=re.compile(r'^Buy it now$', re.I)).or_(page.get_by_role('button', name=re.compile(r'^Buy it now$', re.I)))
    # eBay hides Buy it now on the seller's own item. Its official owner panel
    # certifies availability only alongside a revise link for this exact item.
    owner_notice = page.locator('.vim.d-top-panel-message').get_by_text('Your item is for sale', exact=True)
    revise = page.get_by_role('link', name='Revise listing', exact=True)
    owner_active = False
    if owner_notice.count() == 1 and owner_notice.is_visible() and revise.count() == 1 and revise.is_visible():
        target = urlsplit(revise.get_attribute('href') or '')
        query = parse_qs(target.query)
        owner_active = (target.scheme == 'https' and target.hostname == 'www.ebay.com' and not target.port
                        and not target.username and not target.password and target.path == '/sl/list'
                        and query.get('itemId') == [identifier] and query.get('mode') == ['ReviseItem'])
    if ended.count() and ended.first.is_visible():
        if owner_active or buy.count() and buy.first.is_visible() and buy.first.is_enabled(): raise ValueError('eBay availability signals disagree')
        return 'unavailable', url
    if owner_active: return 'active', url
    if buy.count() == 1 and buy.is_visible() and buy.is_enabled(): return 'active', url
    raise ValueError('eBay did not confirm active or ended availability')


def run_on_page(page, item, photos, options, mode, authorize, verify=verify_listing):
    submitted = False
    candidate = None
    try:
        if mode not in {'fill','post'}: raise ValueError('Invalid eBay posting mode')
        reviewed_inseam(item, category_for(item))
        reviewed_outer_shell_material(item, category_for(item))
        if mode == 'post': authorize()
        progress('opening')
        open_form(page, item)
        progress('photos', len(photos))
        uploaded = attach_photos(page, photos)
        progress('details')
        filled = fill_listing_fields(page, item, options)
        filled['photoKeys'] = uploaded
        progress('checking')
        verify_listing_fields(page, item, filled)
        if mode == 'fill':
            return {'outcome':'filled','submissionStarted':False,'uploadedPhotos':len(uploaded),
                    'message':'Verified eBay fields and photos; closed without clicking List it.'}
        from playwright.sync_api import expect
        final = page.get_by_role('button', name=re.compile(r'^(List it|List item)$', re.I))
        expect(final).to_have_count(1); expect(final).to_be_enabled()
        authorize()
        submitted = True
        progress('publishing')
        final.click()
        progress('verifying')
        candidate = submitted_url(page, filled['title'], cover=uploaded[0])
        verified = verify(page, candidate, filled, uploaded[0])
        if listing_id(verified) != listing_id(candidate): raise ValueError('eBay verification returned a different listing')
        return {'outcome':'posted','submissionStarted':True,'url':verified,'uploadedPhotos':len(uploaded),
                'publishedTitle':filled['title'],'publishedPrice':filled['price']}
    except Exception as error:
        return {'outcome':'failed','submissionStarted':submitted,**({'url':candidate} if candidate else {}),
                'reason':f'{type(error).__name__}: {str(error)[:1500]}'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sku',required=True)
    parser.add_argument('--mode',choices=['fill','post'],default='fill')
    parser.add_argument('--listing-stdin',action='store_true',required=True)
    args = parser.parse_args()
    report = {'outcome':'failed','submissionStarted':False}
    try:
        item, photos = canonical_item_and_photos(read_listing_input(sys.stdin.buffer),args.sku)
        settings = config.load_settings()
        options = settings.get('publish',{}).get('ebayBrowser',{})
        if options.get('enabled') is not True: raise ValueError('Enable eBay browser posting in Settings first')
        authorize = lambda: assert_publish_authorized(item.get('itemId'),item['sku'],'ebay', photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
        if args.mode == 'post': authorize()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            for attempt in range(2):
                with new_chrome_editor(pw,CREATE_URL,timeout=60000) as page:
                    report = run_on_page(page,item,photos,options,args.mode,authorize)
                    if report.get('outcome') == 'failed':
                        try:
                            logs = Path(settings['dataRoot']) / 'logs'
                            logs.mkdir(parents=True,exist_ok=True)
                            page.screenshot(path=str(logs / f'ebay-{args.sku}-failure.png'),full_page=True)
                            state = {'path':urlsplit(page.url).path,'title':page.title(),
                                     'headings':page.get_by_role('heading').all_inner_texts(),
                                     'buttons':page.get_by_role('button').all_inner_texts()}
                            (logs / f'ebay-{args.sku}-failure.json').write_text(json.dumps(state,indent=2),encoding='utf-8')
                        except Exception:
                            pass
                if (args.mode != 'post' or attempt or report.get('outcome') != 'failed'
                        or report.get('submissionStarted') is not False or report.get('url')
                        or not report.get('reason','').startswith('TimeoutError:')):
                    break
                # The previous editor is closed and explicitly never submitted.
                # run_on_page checks current sale/queue authorization again.
                print('[ebay] retrying one timed-out browser step before submission',flush=True)
    except Exception as error:
        if report.get('outcome') == 'posted': report['message'] = 'Publication verified; browser cleanup needs attention'
        else: report = {**report,'outcome':'failed','reason':f'{type(error).__name__}: {str(error)[:1500]}'}
    print('EBAY_DONE '+json.dumps(report),flush=True)
    return 0 if report['outcome'] in {'posted','filled'} else 1


if __name__ == '__main__': sys.exit(main())
