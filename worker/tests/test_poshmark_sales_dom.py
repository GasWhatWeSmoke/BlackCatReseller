"""Synthetic seller DOM matching the observed Sold journey; no live accounts."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.poshmark_sales import scan_sales, main

NEW = 'a' * 24
OLD = 'b' * 24
LISTING = 'c' * 24
LINE = 'd' * 24


class PoshmarkSalesDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.reads = []
        self.bad_old = False
        self.pending = False
        self.two_pages = False
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.page.close()

    def route(self, route):
        url = route.request.url
        identifier = url.rsplit('/', 1)[-1]
        if identifier in (NEW, OLD):
            self.reads.append(identifier)
            status = 'Sold' if identifier == NEW else 'Order Complete'
            order = {'id':identifier, 'state':'payment_pending' if self.pending else 'seller_confirm_initiated',
                     'display_status':status, 'cancelled_on':None, 'inventory_booked_at':'2026-09-18T07:59:10-07:00',
                     'total_price_amount':{'currency_code':'USD','val':'17.0'},
                     'order_events':[{'title':'Sold','completion_status':'in_progress'}],
                     'line_items':[{'id':LINE,'status':'r','product_id':LISTING,'parent_post_id':None,
                                    'product_url':f'https://poshmark.com/listing/{LISTING}','sku':'000136'}]}
            visible = 'Cancelled' if self.bad_old and identifier == OLD else status
            html = f'''<main><div class="order-status__display">{visible}</div>
              <div class="order-journey__item order-journey__marker--in-progress"><div class="order-journey__marker--in-progress__title">Sold</div></div>
              <div class="order-info__container"><span class="order-items__item-price">$17.00</span></div>
              <script>document.querySelector('.order-info__container').__vue__={{$props:{{isSale:true,order:{json.dumps(order)}}}}};</script></main>'''
        else:
            # A known first page must not hide an unseen sale on the next page.
            identifiers = ([OLD] if '?page=2' not in url else [NEW]) if self.two_pages else [NEW, OLD]
            start, end = ((1, 1) if '?page=2' not in url else (2, 2)) if self.two_pages else (1, 2)
            links = ''.join(f'<a class="my-sales-desktop-table__item-title" href="/order/sales/{value}">Item</a>' for value in identifiers)
            html = f'''<main>{links}<span class="my-sales-desktop-table__pagination-info">Showing {start}-{end} of 2</span>
              <button data-et-name="pagination_next" onclick="location.href='/order/sales?page=2'">Next</button></main>'''
        route.fulfill(status=200, content_type='text/html', body=html)

    def test_known_receipt_is_never_opened_and_new_sold_order_is_confirmed(self):
        result = scan_sales(self.page, known_receipts=[OLD])
        self.assertTrue(result['complete'])
        self.assertEqual(self.reads, [NEW])
        self.assertEqual(result['confirmedReceiptIds'], [NEW])
        self.assertEqual(result['observations'][0]['financials']['salePriceCents'], 1700)
        self.assertEqual(result['observations'][0]['financials']['soldAt'], '2026-09-18T14:59:10.000Z')

    def test_repeat_scan_opens_no_known_orders(self):
        result = scan_sales(self.page, known_receipts=[NEW, OLD])
        self.assertTrue(result['complete'])
        self.assertEqual(self.reads, [])
        self.assertEqual(result['ordersRead'], 0)

    def test_a_broken_older_order_retains_the_new_sale_and_partial_coverage(self):
        self.bad_old = True
        result = scan_sales(self.page)
        self.assertFalse(result['complete'])
        self.assertEqual(result['confirmedReceiptIds'], [NEW])
        self.assertEqual(result['checkedReceiptIds'], [NEW])
        self.assertEqual(len(result['observations']), 1)

    def test_pending_native_state_stays_uncached_for_another_check(self):
        self.pending = True
        result = scan_sales(self.page, known_receipts=[OLD])
        self.assertEqual(result['confirmedReceiptIds'], [])
        self.assertEqual(result['observations'][0]['classification'], 'requires_review')

    def test_known_first_page_does_not_hide_new_orders_on_later_pages(self):
        self.two_pages = True
        result = scan_sales(self.page, known_receipts=[OLD])
        self.assertTrue(result['complete'])
        self.assertEqual(self.reads, [NEW])

    def test_receipt_limit_retains_verified_sales_without_claiming_full_coverage(self):
        result = scan_sales(self.page, max_receipts=1)
        self.assertFalse(result['complete'])
        self.assertEqual(self.reads, [NEW])
        self.assertEqual(result['confirmedReceiptIds'], [NEW])

    def test_worker_entrypoint_consumes_the_confirmed_receipt_ids_from_stdin(self):
        class Session:
            page = self.page
            def close(self): pass
        output = io.StringIO()
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps({'receiptIds':[OLD]}).encode()))
        with patch.object(sys, 'argv', ['poshmark_sales']), patch.object(sys, 'stdin', stdin), \
             patch('black_cat_worker.poshmark_sales.config.load_settings', return_value={'dataRoot':'unused'}), \
             patch('black_cat_worker.poshmark_sales.AssistedSession', return_value=Session()), \
             patch('playwright.sync_api.sync_playwright') as playwright, contextlib.redirect_stdout(output):
            playwright.return_value.__enter__.return_value = self.pw
            self.assertEqual(main(), 0)
        result = json.loads(output.getvalue().split('POSHMARK_SALES_DONE ')[1])
        self.assertTrue(result['ok'])
        self.assertEqual(self.reads, [NEW])


if __name__ == '__main__': unittest.main()
