"""Native seller-inventory removal. Exact identity and reload proof are mandatory."""
import argparse
import json
import re
import sys
from urllib.parse import urlsplit

from .chrome_editor import new_chrome_editor
from .delist_guard import assert_delist_authorized
from .direct_listing import read_listing_input
from .seller_selection import check_listing_checkbox
from .post_ebay import listing_id as ebay_id, listing_availability
from .post_etsy import listing_id as etsy_id
from .ebay_form import image_key

START_URLS = {'ebay':'https://www.ebay.com/sh/lst/active',
              'etsy':'https://www.etsy.com/your/shops/me/tools/listings'}


class ListingNotFound(ValueError):
    pass


def identity(marketplace, url):
    return (ebay_id if marketplace == 'ebay' else etsy_id)(url)


def open_inventory(page, marketplace):
    from playwright.sync_api import expect
    response = page.goto(START_URLS[marketplace], wait_until='domcontentloaded', timeout=30000)
    if not response or response.status != 200 or page.url.split('?')[0].rstrip('/') != START_URLS[marketplace]:
        raise ValueError('Seller inventory did not load; sign in to the selling account')
    root = page.locator('main, #listings-content-target' if marketplace == 'ebay' else 'main')
    expect(root).to_have_count(1, timeout=30000)
    expect(root).to_be_visible(timeout=30000)


def ebay_row(page, identifier):
    """Find one active listing using Seller Hub's labelled search control."""
    from playwright.sync_api import expect
    if not isinstance(identifier, str) or not re.fullmatch(r'\d{9,15}', identifier):
        raise ValueError('An exact eBay item number is required')
    root = page.locator('main, #listings-content-target')
    expect(root).to_have_count(1)
    search = root.get_by_label(re.compile(r'^(Search|Search listings|Search by title, SKU,? or item (?:ID|number))$', re.I))
    expect(search).to_have_count(1)
    search.fill(identifier); search.press('Enter')
    row = root.locator('tr,[role="row"]').filter(has=page.locator(f'a[href*="/itm/{identifier}"]'))
    expect(row).to_have_count(1, timeout=15000)
    ids = {ebay_id(href) for href in row.locator('a[href*="/itm/"]').evaluate_all('els=>els.map(e=>e.href)')}
    if ids != {identifier}: raise ValueError('eBay row contains another item')
    if re.search(r'\bauction\b', row.inner_text(), re.I): raise ValueError('Automatic removal supports fixed-price listings only')
    return row


def etsy_card(page, identifier, status):
    from playwright.sync_api import expect
    selected = page.locator(f'input[name="item_status"][value="{status}"]')
    expect(selected).to_have_count(1)
    check_listing_checkbox(selected)
    expect(selected).to_be_checked()
    search = page.get_by_placeholder('Search by title, tag, or SKU', exact=True)
    # ID search is not assumed to be supported by Etsy. Leave this empty and use
    # the exact edit link, advancing inventory pages when necessary.
    search.fill(''); search.press('Enter')
    seen = set()
    for _ in range(20):
        links = page.locator('main a[href*="/listing-editor/edit/"]:visible')
        page.wait_for_function('()=>document.querySelector("main a[href*=\\"/listing-editor/edit/\\"]")||/no listings found|no inactive listings|no active listings/i.test(document.querySelector("main")?.innerText||"")', timeout=15000)
        signature = tuple(links.evaluate_all('els=>els.map(e=>e.getAttribute("href"))'))
        if signature in seen: raise ValueError('Etsy inventory pagination did not advance')
        seen.add(signature)
        link = links.and_(page.locator(f'a[href$="/listing-editor/edit/{identifier}"]'))
        if link.count() == 1:
            # Nearest individual card containing its checkbox, never the whole grid.
            card = link.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]')
            expect(card).to_have_count(1)
            identities = set()
            for href in card.locator('a[href*="/listing-editor/edit/"]').evaluate_all('els=>els.map(e=>e.href)'):
                target = urlsplit(href)
                match = re.fullmatch(r'/your/shops/[^/]+/listing-editor/edit/(\d+)', target.path)
                if target.scheme != 'https' or target.hostname != 'www.etsy.com' or target.port or target.username or target.password or not match:
                    raise ValueError('Etsy card contains an unexpected edit link')
                identities.add(match[1])
            if identities != {identifier}: raise ValueError('Etsy card contains another item')
            expect(selected).to_be_checked()
            return card
        next_page = page.get_by_role('button', name=re.compile(r'^Next(?: page)?$', re.I)).or_(page.get_by_role('link', name=re.compile(r'^Next(?: page)?$', re.I)))
        if next_page.count() != 1 or not next_page.is_enabled() or next_page.get_attribute('aria-disabled') == 'true': break
        next_page.click()
        page.wait_for_function('old=>JSON.stringify([...document.querySelectorAll("main a[href*=\\"/listing-editor/edit/\\"]")].filter(e=>e.getClientRects().length).map(e=>e.getAttribute("href")))!==JSON.stringify(old)', arg=list(signature), timeout=15000)
    raise ListingNotFound(f'Etsy exact listing was not found in {status} inventory')


def etsy_unavailable(page, identifier):
    from playwright.sync_api import expect
    etsy_card(page, identifier, 'inactive')
    url = f'https://www.etsy.com/listing/{identifier}'
    response = page.goto(url, wait_until='domcontentloaded', timeout=30000)
    if not response or response.status != 200 or etsy_id(page.url) != identifier:
        raise ValueError('Etsy product availability could not be read')
    notice = page.get_by_text(re.compile(r'^(Sorry, this item is unavailable\.?|This listing is no longer available\.?|This item is unavailable\.?)$', re.I))
    expect(notice).to_be_visible(timeout=15000)
    # A recommendation's cart control is irrelevant; inspect this product's form.
    form = page.locator('form.add-to-cart-form').filter(has=page.locator(f'input[name="listing_id"][value="{identifier}"]'))
    buy = form.get_by_role('button', name=re.compile(r'^Add to cart$', re.I))
    if buy.count() and buy.is_visible() and buy.is_enabled(): raise ValueError('Etsy listing is still purchasable')
    return url


def ebay_availability(page, identifier):
    from playwright.sync_api import expect
    url = f'https://www.ebay.com/itm/{identifier}'
    response = page.goto(url, wait_until='domcontentloaded', timeout=30000)
    if not response or response.status != 200 or ebay_id(page.url) != identifier:
        raise ValueError('eBay product availability could not be read')
    return listing_availability(page, identifier)


def verify_ebay_end_confirmation(page,row,dialog,identifier):
    from playwright.sync_api import expect
    if re.search(r'(?<!\d)'+re.escape(identifier)+r'(?!\d)',dialog.inner_text()):return
    # Seller Hub's current dialog omits the item number. Retain the exact
    # originating row, then match its title and cover to the single dialog card.
    if urlsplit(page.url).path.rstrip('/')!='/sh/lst/active':raise ValueError('eBay left the selected seller inventory')
    expect(row).to_have_attribute('data-id',identifier)
    checkbox=row.locator('input[type="checkbox"]');expect(checkbox).to_have_count(1);expect(checkbox).to_have_value(identifier)
    links=row.locator('a[href*="/itm/"]').evaluate_all('els=>els.map(e=>({url:e.href,title:e.innerText.trim()}))')
    if {ebay_id(link['url']) for link in links}!={identifier}:raise ValueError('eBay confirmation row identity changed')
    titles={link['title'] for link in links if link['title']}
    if len(titles)!=1:raise ValueError('eBay selected row title is ambiguous')
    title=dialog.locator('.item-card__details-title');expect(title).to_have_count(1);expect(title).to_have_text(next(iter(titles)))
    source=row.locator('img');cover=dialog.locator('img')
    expect(source).to_have_count(1);expect(cover).to_have_count(1)
    expected=image_key(source.evaluate('e=>e.currentSrc||e.src'))
    if not expected or image_key(cover.evaluate('e=>e.currentSrc||e.src'))!=expected:raise ValueError('eBay confirmation cover differs from the selected listing')


def remove_listing(page, marketplace, request, authorize):
    from playwright.sync_api import expect
    started = False
    identifier = request['externalListingId']
    try:
        if identity(marketplace, request['externalUrl']) != identifier: raise ValueError('Removal identity mismatch')
        authorize()
        if marketplace == 'ebay':
            state, url = ebay_availability(page, identifier)
            if state == 'unavailable':
                return {'outcome':'ended','verified':True,'submissionStarted':False,'externalListingId':identifier,'url':url}
        open_inventory(page, marketplace)
        if marketplace == 'etsy':
            try: card = etsy_card(page, identifier, 'active')
            except ListingNotFound:
                url = etsy_unavailable(page, identifier)
                return {'outcome':'ended','verified':True,'submissionStarted':False,'externalListingId':identifier,'url':url}
            bulk=page.locator('main [data-region="bulk-actions"]')
            native=bulk.count()==1
            selected_selector='main input[type="checkbox"]:checked'
            if native:
                header_name=re.compile(r'^(?:Select|Deselect) all listings on this page$')
                expect(page.get_by_role('checkbox',name=header_name)).to_have_count(1)
                expect(bulk.get_by_role('checkbox',name=header_name)).to_have_count(1)
                selected_selector+=':not([aria-label="Select all listings on this page"]):not([aria-label="Deselect all listings on this page"])'
            selected=page.locator(selected_selector)
            expect(selected).to_have_count(0)
            checkbox = card.locator('input[type="checkbox"]')
            check_listing_checkbox(checkbox)
            expect(selected).to_have_count(1)
            expect(checkbox).to_be_checked()
            if native:
                expect(bulk.get_by_role('button',name='Select or deselect listings',exact=True)).to_have_text('1')
                action=bulk.get_by_text('Deactivate',exact=True)
                expect(action).to_have_count(1);expect(action).to_be_visible()
                if action.get_attribute('disabled') is not None:raise ValueError('Etsy deactivation is disabled')
            else:action=page.locator('main').get_by_role('button',name='Deactivate',exact=True)
            authorize(); started = True
            action.click()
            dialog = page.get_by_role('dialog').or_(page.locator('#wt-portals .wt-overlay__modal:visible')).filter(has_text=re.compile('deactivate', re.I))
            expect(dialog).to_have_count(1, timeout=15000)
            # A one-item selection is required on both sides of the confirmation.
            expect(dialog).to_contain_text(re.compile(r'\b1 listing(?!s)', re.I), use_inner_text=True)
            confirm=dialog.get_by_text(re.compile(r'^Deactivate(?: now)?$'))
            expect(confirm).to_have_count(1);expect(confirm).to_be_visible()
            if confirm.evaluate('e=>e.tagName') not in {'BUTTON','CLG-BUTTON'}:
                raise ValueError('Etsy deactivation confirmation is not a verified button')
            if confirm.get_attribute('disabled') is not None or confirm.get_attribute('aria-disabled')=='true':
                raise ValueError('Etsy deactivation confirmation is disabled')
            authorize()
            confirm.click()
            expect(dialog).not_to_be_visible(timeout=30000)
            open_inventory(page, marketplace)
            url = etsy_unavailable(page, identifier)
        else:
            row = ebay_row(page, identifier)
            menu = row.get_by_role('button', name=re.compile(r'^(Actions|More actions|More options|Show other actions(?: \(.+\))?)$', re.I))
            expect(menu).to_have_count(1); menu.click()
            end = (page.get_by_role('menuitem', name='End listing', exact=True)
                   .or_(row.get_by_role('link', name='End listing', exact=True))
                   .or_(page.locator('.shui-menu:visible').get_by_role('button', name='End listing', exact=True)))
            expect(end).to_have_count(1)
            authorize(); started = True; end.click()
            dialog = page.get_by_role('dialog').filter(has_text=re.compile('End listing', re.I))
            expect(dialog).to_have_count(1, timeout=15000)
            verify_ebay_end_confirmation(page,row,dialog,identifier)
            reason = dialog.get_by_role('radio', name=re.compile(r'^(The item is no longer available for sale|Item is no longer available)$', re.I))
            if reason.count(): reason.check()
            verify_ebay_end_confirmation(page,row,dialog,identifier)
            authorize()
            dialog.get_by_role('button', name='End listing', exact=True).click()
            expect(dialog).not_to_be_visible(timeout=30000)
            state, url = ebay_availability(page, identifier)
            if state != 'unavailable': raise ValueError('eBay listing remains active after ending')
        return {'outcome':'ended','verified':True,'submissionStarted':started,'externalListingId':identifier,'url':url}
    except Exception as error:
        return {'outcome':'unknown' if started else 'failed','verified':False,'submissionStarted':started,
                'reason':f'{type(error).__name__}: {str(error)[:1500]}'}


def main(marketplace):
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['end'], required=True)
    parser.add_argument('--listing-stdin', action='store_true', required=True)
    parser.parse_args()
    result = {'outcome':'failed','verified':False,'submissionStarted':False}
    try:
        request = read_listing_input(sys.stdin.buffer)
        if request.get('marketplace') != marketplace or identity(marketplace, request.get('externalUrl')) != request.get('externalListingId'):
            raise ValueError('An exact supported listing identity is required')
        authorize = lambda: assert_delist_authorized(request.get('listingId'), marketplace, request['externalListingId'], request.get('attempt'))
        authorize()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            with new_chrome_editor(pw, START_URLS[marketplace]) as page:
                result = remove_listing(page, marketplace, request, authorize)
    except Exception as error:
        if result.get('outcome') == 'ended': result['reason'] = 'Removal verified; browser cleanup needs attention'
        else: result = {**result,'reason':f'{type(error).__name__}: {str(error)[:1500]}'}
    print(marketplace.upper()+'_END_DONE '+json.dumps(result), flush=True)
    return 0 if result['outcome'] == 'ended' else 1
