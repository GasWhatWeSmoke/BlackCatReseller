"""Seller-side Mercari timeline and its currently displayed collection."""
import json
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.mercari_sales import read_order,scan_sales

ID='m12345678901'
URL=f'https://www.mercari.com/transaction/order_status/{ID}/'


class MercariNativeSalesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.page=self.browser.new_page();self.status='Complete';self.wrong_item=False;self.more=False;self.ship_ready=False
        self.page.route('**/*',self.route)

    def tearDown(self):self.page.close()

    def route(self,route):
        if '/transaction/' in route.request.url:
            item='m99999999999' if self.wrong_item else ID
            action='<button data-testid="ShippingCTAButton">View label</button>' if self.ship_ready else ''
            html=f'''<main><h1>Order status</h1><h3>Buyer information</h3>
              <h4 data-testid="TimelineStepName">Shipped</h4><h1 data-testid="TimelineStepName">{self.status}</h1>{action}
              <div data-testid="OrderDetails"><h5>Item ID</h5><p>{ID}<a data-testid="OrderDetails-Value-Copy">Copy</a></p>
              <a data-testid="ItemNameLink" href="https://www.mercari.com/us/item/{item}/">Reviewed item</a>
              <p data-testid="You-made-label">You made</p><p data-testid="You-made-value">$19.45</p>
              <p data-testid="Sold-price-label">Sold price</p><p data-testid="Sold-price-value">$22.49</p>
              <p data-testid="Tax-value">$1.42</p><p data-testid="Delivery-value">$7.97</p></div></main>'''
        else:
            progress='/in_progress/' in route.request.url
            items=[] if progress else [{'id':ID}]
            value={'loading':False,'items':items,'criteria':{'status':'trading' if progress else 'sold_out','keyword':''},
                   'pagination':{'currentPage':1,'pageSize':20,'totalCount':None if progress else 1,'hasNext':self.more and not progress}}
            row='<div data-testid="ZeroListings">No in progress orders yet</div>' if progress else f'<a href="{URL}">View order</a>'
            html=f'''<main><h1>My listings</h1><input data-testid="SearchBarInput"><table data-testid="Listings"></table>{row}</main>
              <script>document.querySelector('table').__reactFiberFixture={{memoizedProps:{{myListings:{json.dumps(value)}}}}};</script>'''
        route.fulfill(content_type='text/html',body=html)

    def test_complete_seller_order_does_not_require_an_old_print_label_button(self):
        self.assertEqual(read_order(self.page,URL)[0]['classification'],'confirmed_sale')

    def test_pending_payment_does_not_use_future_shipped_step_as_proof(self):
        self.status='Payment pending'
        self.assertEqual(read_order(self.page,URL)[0]['classification'],'not_sale')

    def test_sale_income_is_the_sold_price_without_tax_or_net_payout_substitution(self):
        self.assertEqual(read_order(self.page,URL)[0]['financials'],{'currency':'USD','salePriceCents':2249})
        self.status='Payment pending'
        self.assertNotIn('financials',read_order(self.page,URL)[0])

    def test_enabled_shipping_action_confirms_ready_to_ship_seller_order(self):
        self.status='Ship your item';self.ship_ready=True
        self.assertEqual(read_order(self.page,URL)[0]['classification'],'confirmed_sale')

    def test_different_product_is_not_confirmed_from_a_paid_timeline(self):
        self.wrong_item=True
        with self.assertRaisesRegex(ValueError,'product differs'):read_order(self.page,URL)

    def test_empty_and_complete_collections_have_explicit_end_of_pages(self):
        result=scan_sales(self.page)
        self.assertTrue(result['complete'],result);self.assertEqual(result['confirmedReceiptIds'],[ID])

    def test_missing_next_button_does_not_override_collection_has_next(self):
        self.more=True
        result=scan_sales(self.page)
        self.assertFalse(result['complete']);self.assertEqual(result['confirmedReceiptIds'],[ID])
