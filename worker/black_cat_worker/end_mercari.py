"""Deactivate one exact sale-linked Mercari item, then verify unavailability."""
import argparse
import json
import re
import sys
from .chrome_editor import new_chrome_editor
from .delist_guard import assert_delist_authorized
from .direct_listing import read_listing_input
from .mercari_form import INVENTORY_URL, listing_id
from .mercari_inventory import find_card, ListingNotFound
from .seller_selection import check_listing_checkbox


def verify_unavailable(page,identifier):
    from playwright.sync_api import expect
    # An exact seller-side Inactive record is required even when the public page
    # returns404; absence alone could be a login or transient network failure.
    find_card(page,identifier,'inactive')
    url=f'https://www.mercari.com/us/item/{identifier}/'
    response=page.goto(url,wait_until='domcontentloaded',timeout=30000)
    if not response or listing_id(page.url)!=identifier:raise ValueError('Mercari did not load the expected item identity')
    if response.status==404:return url
    if response.status!=200:raise ValueError('Mercari availability was blocked or could not be read')
    photos=page.locator('main').get_by_test_id('ProductSquareImage')
    if photos.count():
        # Mercari repeats the exact item's status on every carousel image.
        # Recommendation ribbons outside this gallery cannot prove removal.
        ribbons=photos.get_by_test_id('ItemDetailsRibbon')
        expect(ribbons).to_have_count(photos.count(),timeout=15000)
        for index in range(ribbons.count()):
            # A second paragraph invites the seller to activate the item;
            # only the ribbon's first paragraph is its availability status.
            expect(ribbons.nth(index).locator('p').first).to_have_text(re.compile(r'^(?:INACTIVE|SOLD OUT)$',re.I))
        expect(ribbons.first).to_be_visible(timeout=15000)
    else:
        unavailable=page.locator('main').get_by_text(re.compile(r'^(?:This item is (?:no longer available|not for sale)|Item (?:unavailable|sold)|SOLD OUT|INACTIVE)[.!]?$',re.I))
        expect(unavailable).to_be_visible(timeout=15000)
    buy=page.get_by_role('button',name=re.compile(r'^(Buy now|Buy)$',re.I)).or_(page.get_by_role('link',name=re.compile(r'^(Buy now|Buy)$',re.I)))
    if any(buy.nth(i).is_visible() and buy.nth(i).is_enabled() for i in range(buy.count())):raise ValueError('Mercari still offers the item for purchase')
    return url


def remove_listing(page,request,authorize):
    from playwright.sync_api import expect
    submitted=False;identifier=request.get('externalListingId')
    try:
        if not identifier or listing_id(request.get('externalUrl'))!=identifier:raise ValueError('Mercari removal identity mismatch')
        authorize()
        try:card=find_card(page,identifier,'active')
        except ListingNotFound:
            url=verify_unavailable(page,identifier)
            return {'outcome':'ended','verified':True,'submissionStarted':False,'externalListingId':identifier,'url':url}
        checkbox=card.get_by_role('checkbox')
        native=checkbox.get_attribute('data-testid')=='ListingItemCheckbox'
        if native:
            bulk=page.get_by_test_id('BulkActions');expect(bulk).to_have_count(1)
            # Mercari checks its aggregate header even for a partial selection.
            # Require that exact header plus the global selected-item counter;
            # an off-page second selection must still stop the operation.
            expect(page.get_by_test_id('SelectAllCheckbox')).to_have_count(1)
            expect(bulk.get_by_test_id('SelectAllCheckbox')).to_have_count(1)
        selected=page.locator('main input[type="checkbox"]:checked'+(':not([data-testid="SelectAllCheckbox"])' if native else ''))
        expect(selected).to_have_count(0)
        check_listing_checkbox(checkbox)
        expect(selected).to_have_count(1);expect(checkbox).to_be_checked()
        if native:expect(bulk.get_by_text(re.compile(r'^1 item selected$',re.I))).to_be_visible()
        action=page.locator('main').get_by_role('button',name='Deactivate',exact=True)
        expect(action).to_have_count(1);expect(action).to_be_enabled()
        authorize();submitted=True;action.click()
        outcome=page.wait_for_function(r'''()=>{
          if([...document.querySelectorAll('[role=dialog],dialog')].some(e=>e.getClientRects().length&&/deactivate/i.test(e.innerText)))return 'dialog';
          if([...document.querySelectorAll('[role=status],[role=alert]')].some(e=>e.getClientRects().length&&/deactivated/i.test(e.innerText)))return 'done';
          return false;
        }''',timeout=30000).json_value()
        if outcome=='dialog':
            dialog=page.get_by_role('dialog').filter(has_text=re.compile('deactivate',re.I)).filter(visible=True)
            expect(dialog).to_have_count(1)
            expect(dialog).to_contain_text(re.compile(r'\b1 (?:item|listing)(?!s)',re.I),use_inner_text=True)
            authorize();dialog.get_by_role('button',name='Deactivate',exact=True).click()
            expect(dialog).not_to_be_visible(timeout=30000)
        url=verify_unavailable(page,identifier)
        return {'outcome':'ended','verified':True,'submissionStarted':submitted,'externalListingId':identifier,'url':url}
    except Exception as error:
        return {'outcome':'unknown' if submitted else 'failed','verified':False,'submissionStarted':submitted,'reason':f'{type(error).__name__}: {str(error)[:1500]}'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--mode',choices=['end'],required=True);parser.add_argument('--listing-stdin',action='store_true',required=True);parser.parse_args()
    result={'outcome':'failed','verified':False,'submissionStarted':False}
    try:
        request=read_listing_input(sys.stdin.buffer)
        identifier=request.get('externalListingId')
        if request.get('marketplace')!='mercari' or not identifier or listing_id(request.get('externalUrl'))!=identifier:raise ValueError('An exact Mercari listing is required')
        authorize=lambda:assert_delist_authorized(request.get('listingId'),'mercari',identifier,request.get('attempt'))
        authorize()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            with new_chrome_editor(pw,INVENTORY_URL) as page:result=remove_listing(page,request,authorize)
    except Exception as error:
        if result.get('outcome')=='ended':result['reason']='Removal verified; Chrome cleanup needs attention'
        else:result={**result,'reason':f'{type(error).__name__}: {str(error)[:1500]}'}
    print('MERCARI_END_DONE '+json.dumps(result),flush=True)
    return 0 if result['outcome']=='ended' else 1


if __name__=='__main__':raise SystemExit(main())
