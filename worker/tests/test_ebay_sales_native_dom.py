"""Native Seller Hub order layout; requests are fulfilled locally."""
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.seller_sales import discover_receipts,read_receipt,receipt_identity

ORDER='25-15073-43353'
URL=f'https://www.ebay.com/mesh/ord/details?mode=SH&orderid={ORDER}'


class EbayNativeSalesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.page=self.browser.new_page();self.paid='Aug 30, 2026';self.status='Delivered on Sep 3';self.order=ORDER;self.quantity=1;self.page_size=50;self.total=1
        self.page.route('**/*',self.route)

    def tearDown(self):self.page.close()

    def route(self,route):
        if '/mesh/ord/details' in route.request.url:
            html=f'''<h1>Order details</h1><h2>What your buyer paid</h2>
              <div class="order-info"><dl><dt>Order</dt><dd>{self.order}</dd><dt>Buyer paid</dt><dd>{self.paid}</dd></dl></div>
              <div class="status-summary"><div class="summary-content">{self.status}</div></div>
              <div id="itemInfo"><h2>Item</h2><div class="item-card"><a href="https://www.ebay.com/itm/123456789012">PAID printed shirt</a>
              <div class="quantity__value">{self.quantity}</div></div></div>'''
        else:
            html=f'''<h1>Manage orders awaiting shipment</h1><a href="#all">All orders</a><p>Results: 1-1 of {self.total}</p>
              <div id="mod-main-cntr"><a href="{URL}">{ORDER}</a></div>
              <div class="action-pagination"><div class="action-pagination__pag"></div><div class="action-pagination__ipp">Items Per Page: {self.page_size}</div></div>'''
        route.fulfill(content_type='text/html',body=html)

    def test_mesh_order_identity_and_explicit_paid_date_are_verified(self):
        self.assertEqual(receipt_identity('ebay',URL),ORDER)
        rows=read_receipt(self.page,'ebay',URL)
        self.assertEqual(rows[0]['classification'],'confirmed_sale')
        self.assertEqual(rows[0]['listingId'],'123456789012')

    def test_unpaid_status_is_not_changed_by_product_title(self):
        self.paid='--';self.status='Awaiting payment'
        self.assertEqual(read_receipt(self.page,'ebay',URL)[0]['classification'],'not_sale')

    def test_actual_subtotal_and_collected_shipping_exclude_tax_and_seller_net(self):
        original=self.route
        def money_route(route):
            if '/mesh/ord/details' not in route.request.url:return original(route)
            route.fulfill(content_type='text/html',body=f'''<h1>Order details</h1>
              <div class="buyer-paid"><h2>What your buyer paid</h2><dl><dt>Subtotal</dt><dd>$20.99</dd>
              <dt>Shipping</dt><dd>$5.89</dd><dt>Sales tax*</dt><dd>$1.26</dd><dt>Order total**</dt><dd>$28.14</dd></dl></div>
              <div class="order-info"><dl><dt>Order</dt><dd>{ORDER}</dd><dt>Buyer paid</dt><dd>Aug 30, 2026</dd></dl></div>
              <div class="status-summary"><div class="summary-content">Delivered</div></div>
              <div id="itemInfo"><h2>Item</h2><div class="item-card"><a href="https://www.ebay.com/itm/123456789012">Item</a><div class="quantity__value">1</div></div></div>
              <div class="seller-earned"><dt>Subtotal</dt><dd>$16.76</dd></div>''')
        self.page.unroute('**/*');self.page.route('**/*',money_route)
        money=read_receipt(self.page,'ebay',URL)[0]['financials']
        self.assertEqual(money,{'currency':'USD','salePriceCents':2099,'shippingChargedCents':589,'soldAt':'2026-08-30T00:00:00.000Z'})

    def test_partial_refund_does_not_restore_a_paid_item_to_available_stock(self):
        self.status='Partially refunded'
        self.assertEqual(read_receipt(self.page,'ebay',URL)[0]['classification'],'confirmed_sale')
        self.status='Cancelled and partially refunded'
        self.assertEqual(read_receipt(self.page,'ebay',URL)[0]['classification'],'not_sale')

    def test_wrong_order_identity_and_incomplete_item_count_stop_the_read(self):
        self.order='25-15073-99999'
        with self.assertRaisesRegex(ValueError,'identity'):read_receipt(self.page,'ebay',URL)
        self.order=ORDER;self.quantity=2
        with self.assertRaisesRegex(ValueError,'count'):read_receipt(self.page,'ebay',URL)

    def test_native_single_page_uses_visible_page_size_without_inventing_next(self):
        urls,complete,_=discover_receipts(self.page,'ebay',10,'All orders')
        self.assertEqual(urls,[URL]);self.assertTrue(complete)

    def test_a_full_page_without_pagination_does_not_certify_complete_history(self):
        self.page_size=1;self.total=2
        _,complete,_=discover_receipts(self.page,'ebay',10,'All orders')
        self.assertFalse(complete)
