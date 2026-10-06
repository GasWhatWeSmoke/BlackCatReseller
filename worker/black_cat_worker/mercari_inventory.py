"""Read an exact Mercari seller card; no listing or account mutations."""
import re
from urllib.parse import urlsplit
from .mercari_form import listing_id


class ListingNotFound(ValueError):pass


def find_card(page,identifier,status):
    from playwright.sync_api import expect
    if status not in {'active','inactive'} or not re.fullmatch(r'm\d{9,15}',identifier):raise ValueError('Invalid Mercari inventory request')
    url=f'https://www.mercari.com/mypage/listings/{status}/'
    response=page.goto(url,wait_until='domcontentloaded',timeout=30000)
    if not response or response.status!=200 or urlsplit(page.url).path.rstrip('/')!=urlsplit(url).path.rstrip('/'):
        raise ValueError('Mercari seller inventory did not load; sign in to the selling account')
    expect(page.get_by_role('heading',name=re.compile(r'^My listings$',re.I))).to_be_visible(timeout=15000)
    help_dialog=page.get_by_role('dialog').filter(has_text='Clicks and views')
    if help_dialog.count()==1 and help_dialog.is_visible():
        help_dialog.get_by_role('button',name='Got it',exact=True).click()
    seen=set()
    for _ in range(20):
        page.wait_for_function(r'''()=>{
          const main=document.querySelector('main');return main&&([...main.querySelectorAll('a[href]')].some(e=>e.getClientRects().length&&/\/us\/item\/m\d+/.test(e.href))||
          [...main.querySelectorAll('[role=status],h2,h3')].some(e=>e.getClientRects().length&&/^No (?:items|listings)(?: found)?[.!]?$/i.test(e.innerText.trim())));
        }''',timeout=15000)
        links=page.locator('main a[href*="/us/item/"]:visible')
        urls=links.evaluate_all('els=>els.map(e=>e.href)')
        signature=tuple(urls)
        if signature in seen:raise ValueError('Mercari inventory pagination did not advance')
        seen.add(signature)
        matches=[index for index,value in enumerate(urls) if listing_id(value)==identifier]
        if matches:
            card=links.nth(matches[0]).locator('xpath=ancestor::*[self::article or self::li or self::tr or @data-testid="item-card"][1]')
            expect(card).to_have_count(1)
            for index in matches[1:]:
                if not links.nth(index).evaluate('(link,card)=>card.contains(link)',card.element_handle()):
                    raise ValueError('Mercari inventory contains duplicate matching cards')
            ids={listing_id(value) for value in card.locator('a[href*="/us/item/"]').evaluate_all('els=>els.map(e=>e.href)')}
            if ids!={identifier}:raise ValueError('Mercari card contains a different item')
            return card
        next_page=page.get_by_role('button',name=re.compile(r'^Next(?: page)?$',re.I)).or_(page.get_by_role('link',name=re.compile(r'^Next(?: page)?$',re.I)))
        if next_page.count()!=1 or not next_page.is_enabled() or next_page.get_attribute('aria-disabled')=='true':break
        next_page.click()
        page.wait_for_function('old=>JSON.stringify([...document.querySelectorAll("main a[href*=\\"/us/item/\\"]")].filter(e=>e.getClientRects().length).map(e=>e.href))!==JSON.stringify(old)',arg=urls,timeout=15000)
    raise ListingNotFound(f'Mercari item was not found in {status} listings')
