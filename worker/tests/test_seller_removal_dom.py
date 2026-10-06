"""Local browser fixtures; every browser request is fulfilled in this process."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.seller_removal import remove_listing, START_URLS

IDENTIFIER = '123456789012'


class SellerRemovalDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_default_timeout(800)
        self.ended = False; self.mutations = 0; self.ignore_end = False; self.extra_selection = False
        self.wrong_row = False; self.authorizations = 0; self.pause_at = 0
        self.native_ebay = False
        self.native_end_card=False;self.wrong_end_cover=False
        self.untrusted_owner_notice = False
        self.etsy_title_link = False; self.etsy_other_link = False
        self.covered_checkbox = False
        self.covered_status = False
        self.native_selection = False; self.selected_total = 1
        self.custom_confirmation = False
        self.page.route('**/*', self.route)

    def tearDown(self): self.page.close()

    def authorize(self):
        self.authorizations += 1
        if self.authorizations == self.pause_at: raise ValueError('Removal was paused')

    def route(self, route):
        url = route.request.url
        if '/fixture/end' in url:
            self.mutations += 1
            if not self.ignore_end: self.ended = True
            route.fulfill(status=200, body='ok'); return
        if '/itm/' in url:
            content = '<div role="status">This listing was ended by the seller.</div>' if self.ended else '<a href="#">Buy it now</a>'
            if self.native_ebay and not self.ended:
                region = '' if self.untrusted_owner_notice else 'class="vim d-top-panel-message"'
                content = f'<div {region}><span>Your item is for sale</span><a href="https://www.ebay.com/sl/list?itemId={IDENTIFIER}&mode=ReviseItem">Revise listing</a></div>'
            html = '<h1>Reviewed shirt</h1>'+content
        elif '/sh/lst/active' in url:
            target = '999999999999' if self.wrong_row else IDENTIFIER
            html = f'''<main><label>Search listings<input></label><table><tr>
              <td><a href="https://www.ebay.com/itm/{target}">Reviewed shirt</a>Fixed price</td>
              <td><button onclick="document.querySelector('[role=menuitem]').hidden=false">Actions</button>
              <a role="menuitem" hidden onclick="document.querySelector('dialog').showModal()">End listing</a></td></tr></table>
              <dialog>End listing {IDENTIFIER}<label><input type="radio">The item is no longer available for sale</label>
              <button onclick="fetch('/fixture/end').then(()=>document.querySelector('dialog').close())">End listing</button></dialog></main>'''
            if self.native_ebay:
                html = f'''<div id="listings-content-target"><h1>Manage active listings(1)</h1>
                  <input role="combobox" aria-label="Search by title, SKU, or item number">
                  <table><tr><td><a href="https://www.ebay.com/itm/{target}">Reviewed shirt</a>Buy It Now</td>
                  <td><button aria-label="Show other actions (Reviewed shirt)" onclick="document.querySelector('.shui-menu').hidden=false">...</button></td></tr></table></div>
                  <div class="shui-menu" hidden><button onclick="this.parentElement.hidden=true;document.querySelector('dialog').showModal()">End listing</button></div>
                  <dialog>End listing {IDENTIFIER}<label><input type="radio">The item is no longer available for sale</label>
                  <button onclick="fetch('/fixture/end').then(()=>document.querySelector('dialog').close())">End listing</button></dialog>'''
                if self.native_end_card:
                    html=html.replace('<tr>',f'<tr data-id="{target}"><td><input type="checkbox" value="{target}"><img src="https://i.ebayimg.com/images/g/COVER/s-l140.jpg"></td>',1)
                    key='OTHER' if self.wrong_end_cover else 'COVER'
                    html=html.replace(f'<dialog>End listing {IDENTIFIER}',f'<dialog><h2>End listing</h2><div class="item-card__details-title">Reviewed shirt</div><img src="https://i.ebayimg.com/images/g/{key}/s-l140.jpg">')
        elif '/listing/' in url:
            html = '<main>Sorry, this item is unavailable.</main>' if self.ended else f'<form class="add-to-cart-form"><input name="listing_id" value="{IDENTIFIER}"><button>Add to cart</button></form>'
        else:
            inactive = 'true' if self.ended else 'false'
            extra = '<input type="checkbox" checked>' if self.extra_selection else ''
            second_id = '999999999999' if self.etsy_other_link else IDENTIFIER
            second_link = f'<a href="/your/shops/me/listing-editor/edit/{second_id}?ref=listings_manager_grid">Reviewed shirt</a>' if self.etsy_title_link else ''
            checkbox = '<input type="checkbox">'
            if self.covered_checkbox:
                checkbox = '<style>.covered-label:before{content:"";position:absolute;left:0;top:0;width:18px;height:18px;background:#ddd}</style><div style="position:relative;width:24px;height:18px"><input id="listing-choice" type="checkbox" style="width:18px;height:18px;margin:0"><label class="covered-label" for="listing-choice" style="display:block;width:0;height:0"><span style="display:none">Select this listing</span></label></div>'
            action='<button onclick="document.querySelector(\'dialog\').showModal()">Deactivate</button>'
            if self.native_selection:
                checkbox=checkbox.replace('type="checkbox"','type="checkbox" onchange="document.getElementById(&quot;aggregate&quot;).checked=this.checked"')
                action=f'''<div data-region="bulk-actions"><button aria-label="Select or deselect listings">{self.selected_total}</button>
                  <input type="checkbox" id="aggregate" aria-label="Deselect all listings on this page">
                  <clg-button onclick="document.querySelector('dialog').showModal()">Deactivate</clg-button></div>'''
            html = f'''<main><label><input type="radio" name="item_status" value="active" checked onchange="render()">Active</label>
              <label><input type="radio" name="item_status" value="inactive" onchange="render()">Inactive</label>
              <input placeholder="Search by title, tag, or SKU">{extra}<div id="cards"></div>
              {action}
              <dialog>Deactivate 1 listing<{"clg-button" if self.custom_confirmation else "button"} onclick="fetch('/fixture/end').then(()=>document.querySelector('dialog').close())">{"Deactivate now" if self.custom_confirmation else "Deactivate"}</{"clg-button" if self.custom_confirmation else "button"}></dialog>
              </main><script>function render(){{const inactive=document.querySelector('[value=inactive]').checked;
                document.querySelector('#cards').innerHTML=inactive==={inactive}?'<article>{checkbox}<a href="/your/shops/me/listing-editor/edit/{IDENTIFIER}">Reviewed shirt</a>{second_link}</article>':'No listings found';}}render()</script>'''
        if self.covered_status and '/tools/listings' in url:
            html = html.replace('<label><input type="radio"', '<label style="display:inline-block;position:relative;width:120px;height:28px"><input type="radio"')
            html = html.replace('>Active</label>', '><span style="position:absolute;inset:0;background:white">Active</span></label>')
            html = html.replace('>Inactive</label>', '><span style="position:absolute;inset:0;background:white">Inactive</span></label>')
        route.fulfill(status=200, content_type='text/html', body=html)

    def run_removal(self, marketplace):
        prefix = 'itm' if marketplace == 'ebay' else 'listing'
        request = {'externalListingId':IDENTIFIER, 'externalUrl':f'https://www.{marketplace}.com/{prefix}/{IDENTIFIER}'}
        return remove_listing(self.page, marketplace, request, self.authorize)

    def test_ebay_ends_exact_fixed_price_listing_and_reloads_public_availability(self):
        result = self.run_removal('ebay')
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertTrue(result['verified']); self.assertEqual(self.mutations, 1)
        self.assertEqual(self.authorizations, 3)

    def test_current_seller_hub_combobox_and_portal_menu_end_only_the_exact_item(self):
        self.native_ebay = True
        result = self.run_removal('ebay')
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertTrue(result['verified']); self.assertEqual(self.mutations, 1)
        self.assertEqual(self.authorizations, 3)

    def test_owner_notice_outside_ebay_status_panel_does_not_authorize_removal(self):
        self.native_ebay = True; self.untrusted_owner_notice = True
        result = self.run_removal('ebay')
        self.assertEqual(result['outcome'], 'failed', result)
        self.assertEqual(self.mutations, 0)

    def test_native_end_dialog_matches_the_retained_row_when_item_number_is_not_shown(self):
        self.native_ebay=True;self.native_end_card=True
        result=self.run_removal('ebay')
        self.assertEqual(result['outcome'],'ended',result);self.assertEqual(self.mutations,1)

    def test_matching_title_alone_cannot_authorize_a_different_dialog_cover(self):
        self.native_ebay=True;self.native_end_card=True;self.wrong_end_cover=True
        result=self.run_removal('ebay')
        self.assertEqual(result['outcome'],'unknown',result);self.assertEqual(self.mutations,0)

    def test_etsy_deactivates_one_card_and_proves_inactive_and_unavailable(self):
        result = self.run_removal('etsy')
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertEqual(self.mutations, 1); self.assertTrue(result['submissionStarted'])

    def test_etsy_uses_the_associated_label_when_status_radio_is_covered(self):
        self.covered_status = True
        result = self.run_removal('etsy')
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertTrue(result['verified'])
        self.assertEqual(self.mutations, 1)

    def test_etsy_photo_and_title_links_can_identify_the_same_card(self):
        self.etsy_title_link = True
        result = self.run_removal('etsy')
        self.assertEqual(result['outcome'], 'ended', result); self.assertEqual(self.mutations, 1)

    def test_etsy_label_overlay_selects_only_its_associated_listing_checkbox(self):
        self.covered_checkbox = True
        result = self.run_removal('etsy')
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertEqual(self.mutations, 1); self.assertEqual(self.authorizations, 3)

    def test_etsy_native_bulk_counter_excludes_aggregate_checkbox_and_uses_custom_button(self):
        self.covered_checkbox=True;self.native_selection=True
        result=self.run_removal('etsy')
        self.assertEqual(result['outcome'],'ended',result);self.assertEqual(self.mutations,1)

    def test_etsy_native_bulk_counter_cannot_hide_another_selected_listing(self):
        self.native_selection=True;self.selected_total=2
        result=self.run_removal('etsy')
        self.assertEqual(result['outcome'],'failed',result);self.assertEqual(self.mutations,0)

    def test_etsy_custom_confirmation_button_finishes_the_exact_selected_removal(self):
        self.covered_checkbox=True;self.native_selection=True;self.custom_confirmation=True
        result=self.run_removal('etsy')
        self.assertEqual(result['outcome'],'ended',result);self.assertEqual(self.mutations,1)
        self.assertEqual(self.authorizations,3)

    def test_etsy_pause_before_custom_confirmation_preserves_the_listing(self):
        self.native_selection=True;self.custom_confirmation=True;self.pause_at=3
        result=self.run_removal('etsy')
        self.assertEqual(result['outcome'],'unknown',result);self.assertEqual(self.mutations,0)

    def test_etsy_card_containing_a_second_item_is_not_deactivated(self):
        self.etsy_title_link = True; self.etsy_other_link = True
        result = self.run_removal('etsy')
        self.assertEqual(result['outcome'], 'failed', result); self.assertEqual(self.mutations, 0)

    def test_already_ended_items_are_verified_without_another_mutation(self):
        self.ended = True
        for marketplace in ('ebay', 'etsy'):
            result = self.run_removal(marketplace)
            self.assertEqual(result['outcome'], 'ended', result)
            self.assertFalse(result['submissionStarted'])
        self.assertEqual(self.mutations, 0)

    def test_pause_before_final_confirmation_does_not_submit(self):
        for marketplace in ('ebay', 'etsy'):
            self.authorizations = 0; self.pause_at = 3
            result = self.run_removal(marketplace)
            self.assertEqual(result['outcome'], 'unknown', result)
        self.assertEqual(self.mutations, 0)

    def test_existing_etsy_bulk_selection_is_rejected(self):
        self.extra_selection = True
        result = self.run_removal('etsy')
        self.assertEqual(result['outcome'], 'failed', result)
        self.assertFalse(result['submissionStarted']); self.assertEqual(self.mutations, 0)

    def test_ebay_still_purchasable_after_end_is_unknown(self):
        self.ignore_end = True
        result = self.run_removal('ebay')
        self.assertEqual(result['outcome'], 'unknown', result)
        self.assertEqual(self.mutations, 1)

    def test_wrong_ebay_row_is_never_mutated(self):
        self.wrong_row = True
        result = self.run_removal('ebay')
        self.assertEqual(result['outcome'], 'failed', result)
        self.assertEqual(self.mutations, 0)


if __name__ == '__main__': unittest.main()
