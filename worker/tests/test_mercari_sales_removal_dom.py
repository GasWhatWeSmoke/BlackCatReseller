from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.end_mercari import remove_listing
from black_cat_worker.mercari_sales import scan_sales

ID='m12345678901'


class MercariSalesRemovalDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.page=self.browser.new_page();self.page.set_default_timeout(1000)
        self.inactive=False;self.mutations=0;self.bulk=False;self.pause_at=0;self.calls=0;self.public_status=404
        self.reads=[];self.bad_second=False;self.missing_paging=False
        self.photo_and_title=False;self.duplicate_card=False
        self.covered_checkbox=False
        self.native_selection=False;self.selected_total=1
        self.inactive_banner=False;self.public_buy=False
        self.carousel=False;self.bad_ribbon=False
        self.page.route('**/*',self.route)

    def tearDown(self):self.page.close()

    def route(self,route):
        path=urlsplit(route.request.url).path
        if path=='/fixture/deactivate':self.mutations+=1;self.inactive=True;route.fulfill(body='ok');return
        if path.startswith('/us/item/'):
            notice='INACTIVE' if self.inactive_banner else 'This item is not for sale'
            if self.carousel:
                notice=''.join('<div data-testid="ProductSquareImage"><div data-testid="ItemDetailsRibbon"><p>'+
                               ('ACTIVE' if self.bad_ribbon and index==2 else 'INACTIVE')+'</p><p>Activate to sell your item</p></div></div>' for index in range(5))
            buy='<button>Buy now</button>' if self.public_buy else ''
            route.fulfill(status=self.public_status,content_type='text/html',body=f'<main>{notice}{buy}</main>');return
        if '/transaction/order_status/' in path:
            identifier=path.rstrip('/').split('/')[-1];self.reads.append(identifier)
            payment='Paid' if identifier==ID else 'Payment processing'
            count=2 if self.bad_second and identifier!=ID else 1
            html=f'<main><h1>Order status</h1><h2>{count} item</h2><dl><dt>Order status</dt><dd>Awaiting shipment</dd><dt>Payment status</dt><dd>{payment}</dd></dl><section aria-label="Order items"><a href="/us/item/{identifier}/">Shirt</a></section><button>Print shipping label</button><p>Customer note: paid, please ship. This does not certify payment.</p></main>'
        elif path.endswith('/in_progress/') or path.endswith('/complete/'):
            next_page='' if self.missing_paging else '<button disabled>Next</button>'
            html=f'<main><h1>My listings</h1><a href="/transaction/order_status/{ID}/">Order one</a><a href="/transaction/order_status/m99999999999/">Order two</a>{next_page}</main>'
        else:
            show=self.inactive if '/inactive/' in path else not self.inactive
            card=f'<article><input type="checkbox"><a href="/us/item/{ID}/">Shirt</a></article>' if show else '<div role="status">No listings found</div>'
            if show and self.covered_checkbox:
                card=card.replace('<input type="checkbox">','<label style="position:relative;display:inline-block;width:24px;height:24px"><input type="checkbox"><span style="position:absolute;inset:0;background:#ddd"></span></label>')
            aggregate=''
            if show and self.native_selection:
                card=card.replace('type="checkbox"','type="checkbox" data-testid="ListingItemCheckbox" onchange="document.querySelector(\'[data-testid=SelectAllCheckbox]\').checked=this.checked"')
                aggregate=f'<div data-testid="BulkActions"><input type="checkbox" data-testid="SelectAllCheckbox"><p>{self.selected_total} item'+('s' if self.selected_total!=1 else '')+' selected</p></div>'
            if show and self.photo_and_title:card=card.replace('</article>',f'<a href="/us/item/{ID}/">Shirt photo</a></article>')
            if show and self.duplicate_card:card+=card
            extra='<input type="checkbox" checked>' if self.bulk else ''
            html=f'''<main><h1>My listings</h1>{extra}{aggregate}{card}<button disabled>Next</button>
                <button onclick="document.querySelector('dialog').showModal()">Deactivate</button>
                <dialog>Deactivate 1 item<button onclick="fetch('/fixture/deactivate').then(()=>this.closest('dialog').close())">Deactivate</button></dialog></main>'''
        route.fulfill(status=200,content_type='text/html',body=html)

    def authorize(self):
        self.calls+=1
        if self.calls==self.pause_at:raise ValueError('Paused')

    def end(self):return remove_listing(self.page,{'externalListingId':ID,'externalUrl':f'https://www.mercari.com/us/item/{ID}/'},self.authorize)

    def test_deactivates_one_item_and_proves_inactive_before_accepting_public_404(self):
        result=self.end();self.assertEqual(result['outcome'],'ended',result)
        self.assertTrue(result['verified']);self.assertEqual(self.mutations,1);self.assertEqual(self.calls,3)

    def test_already_inactive_listing_needs_no_second_mutation(self):
        self.inactive=True;result=self.end()
        self.assertEqual(result['outcome'],'ended',result);self.assertFalse(result['submissionStarted']);self.assertEqual(self.mutations,0)

    def test_native_inactive_banner_verifies_an_already_deactivated_exact_item(self):
        self.inactive=True;self.public_status=200;self.inactive_banner=True
        result=self.end()
        self.assertEqual(result['outcome'],'ended',result);self.assertEqual(self.mutations,0)
        self.assertFalse(result['submissionStarted'])

    def test_inactive_inventory_and_banner_cannot_override_a_live_buy_control(self):
        self.inactive=True;self.public_status=200;self.inactive_banner=True;self.public_buy=True
        result=self.end()
        self.assertEqual(result['outcome'],'failed',result);self.assertFalse(result['verified']);self.assertEqual(self.mutations,0)

    def test_carousel_repeats_inactive_ribbons_but_conflicts_or_buy_controls_prevent_confirmation(self):
        self.inactive=True;self.public_status=200;self.carousel=True
        result=self.end();self.assertEqual(result['outcome'],'ended',result)
        self.public_buy=True
        result=self.end();self.assertEqual(result['outcome'],'failed',result)
        self.public_buy=False;self.bad_ribbon=True
        result=self.end();self.assertEqual(result['outcome'],'failed',result)
        self.assertEqual(self.mutations,0)

    def test_styled_checkbox_square_uses_the_native_label_before_single_item_removal(self):
        self.covered_checkbox=True;result=self.end()
        self.assertEqual(result['outcome'],'ended',result)
        self.assertEqual(self.mutations,1);self.assertEqual(self.calls,3)

    def test_checked_aggregate_header_is_not_a_second_selected_listing(self):
        self.covered_checkbox=True;self.native_selection=True
        result=self.end()
        self.assertEqual(result['outcome'],'ended',result);self.assertEqual(self.mutations,1)

    def test_native_counter_rejects_an_additional_selection_on_another_page(self):
        self.native_selection=True;self.selected_total=2
        result=self.end()
        self.assertEqual(result['outcome'],'failed',result);self.assertEqual(self.mutations,0)

    def test_photo_and_title_links_in_one_card_are_the_same_item(self):
        self.photo_and_title=True;result=self.end()
        self.assertEqual(result['outcome'],'ended',result);self.assertEqual(self.mutations,1)

    def test_same_id_in_two_separate_cards_is_ambiguous(self):
        self.duplicate_card=True;result=self.end()
        self.assertEqual(result['outcome'],'failed',result);self.assertEqual(self.mutations,0)

    def test_existing_bulk_selection_is_never_applied_to_other_items(self):
        self.bulk=True;result=self.end()
        self.assertEqual(result['outcome'],'failed',result);self.assertEqual(self.mutations,0)

    def test_pause_before_final_confirmation_stops_deactivation(self):
        self.pause_at=3;result=self.end()
        self.assertEqual(result['outcome'],'unknown',result);self.assertEqual(self.mutations,0)

    def test_blocked_product_page_is_not_successful_removal(self):
        self.public_status=403;result=self.end()
        self.assertEqual(result['outcome'],'unknown',result);self.assertFalse(result['verified'])

    def test_paid_and_pending_orders_are_distinguished_without_sending_messages(self):
        result=scan_sales(self.page)
        self.assertTrue(result['complete'],result);self.assertEqual(result['confirmedReceiptIds'],[ID])
        self.assertEqual([row['classification'] for row in result['observations']],['confirmed_sale','not_sale'])
        self.assertEqual(self.mutations,0)

    def test_bad_order_keeps_other_confirmed_sale_and_reports_partial_coverage(self):
        self.bad_second=True;result=scan_sales(self.page)
        self.assertFalse(result['complete']);self.assertEqual(result['confirmedReceiptIds'],[ID])

    def test_cached_orders_do_not_hide_pending_orders_or_missing_pagination(self):
        self.missing_paging=True;result=scan_sales(self.page,[ID])
        self.assertFalse(result['complete']);self.assertEqual(self.reads,['m99999999999']);self.assertEqual(result['confirmedReceiptIds'],[])

    def test_time_budget_returns_confirmed_sale_without_starting_another_order(self):
        from black_cat_worker import mercari_sales
        now=[0];original=mercari_sales.read_order
        def slow_order(page,url):
            result=original(page,url);now[0]=160
            return result
        with patch.object(mercari_sales,'monotonic',side_effect=lambda:now[0]),patch.object(mercari_sales,'read_order',side_effect=slow_order):
            result=scan_sales(self.page)
        self.assertFalse(result['complete']);self.assertEqual(result['confirmedReceiptIds'],[ID])
        self.assertEqual(self.reads,[ID]);self.assertIn('time budget',result['reason'])


if __name__=='__main__':unittest.main()
