from pathlib import Path
import sys
import unittest
from urllib.parse import urlsplit,parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.seller_sales import scan_sales


class SellerSalesDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls): cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.page=self.browser.new_page();self.page.set_default_timeout(500)
        self.reads=[];self.bad_count=False;self.missing_pagination=False;self.marketplace='ebay';self.two_pages=False
        self.page.route('**/*',self.route)

    def tearDown(self): self.page.close()

    def route(self,route):
        url=urlsplit(route.request.url);query=parse_qs(url.query)
        order=(query.get('orderid') or query.get('order_id') or [None])[0]
        if order:
            self.reads.append(order)
            prefix='itm' if self.marketplace=='ebay' else 'listing'
            first=order in {'12-12345-12345','1234567890'}
            count=2 if self.bad_count and not first else 1
            payment='Paid' if first else 'Payment processing'
            html=f'''<main><h1>Order #{order}</h1><h2>{count} item{'s' if count>1 else ''}</h2>
              <dl><dt>Payment status</dt><dd>{payment}</dd><dt>Order status</dt><dd>Ready to ship</dd></dl>
              <a href="https://www.{self.marketplace}.com/{prefix}/123456789012">Reviewed shirt</a>
              <div>Customer note: Payment received. This text must never authorize a sale.</div></main>'''
        else:
            if self.marketplace=='ebay':
                tabs='<button>All orders</button>'
                links='<a href="/sh/ord/details?orderid=12-12345-12345">12-12345-12345</a><a href="/sh/ord/details?orderid=12-12345-12346">12-12345-12346</a>'
            else:
                tabs='<button>New</button><button>Completed</button>'
                links='<a href="/your/orders/sold?order_id=1234567890">1234567890</a><a href="/your/orders/sold?order_id=1234567891">1234567891</a>'
            next_page='' if self.missing_pagination else '<button disabled>Next</button>'
            if self.two_pages:
                first_page='page' not in query
                first,second=links.split('</a>',1)
                links=first+'</a>' if first_page else second
                if first_page:next_page='<button onclick="setTimeout(()=>location.href=location.pathname+\'?page=2\',1000)">Next</button>'
                links+='<a href="/unrelated">Unrelated navigation</a>'
            html=f'<main><h1>Orders</h1>{tabs}{links}{next_page}</main>'
        route.fulfill(status=200,content_type='text/html',body=html)

    def test_both_marketplaces_read_paid_and_pending_receipts_without_mutations(self):
        for platform in ('ebay','etsy'):
            self.marketplace=platform
            result=scan_sales(self.page,platform)
            self.assertTrue(result['complete'],result)
            self.assertEqual(len(result['observations']),2,result)
            self.assertEqual([row['classification'] for row in result['observations']],['confirmed_sale','not_sale'])
            self.assertEqual(len(result['confirmedReceiptIds']),1)

    def test_confirmed_checkpoints_skip_old_receipts_but_pending_receipts_are_rechecked(self):
        result=scan_sales(self.page,'ebay',['12-12345-12345'])
        self.assertEqual(self.reads,['12-12345-12346'])
        self.assertEqual(result['confirmedReceiptIds'],[])

    def test_one_bad_receipt_retains_the_other_confirmed_sale_and_reports_partial(self):
        self.bad_count=True
        result=scan_sales(self.page,'ebay')
        self.assertFalse(result['complete'])
        self.assertEqual(result['confirmedReceiptIds'],['12-12345-12345'])
        self.assertEqual(len(result['observations']),1)

    def test_missing_pagination_never_claims_complete_coverage(self):
        self.missing_pagination=True
        result=scan_sales(self.page,'ebay')
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['observations']),2)

    def test_delayed_next_page_waits_for_order_links_not_unrelated_navigation(self):
        self.two_pages=True
        for platform in ('ebay','etsy'):
            self.marketplace=platform
            result=scan_sales(self.page,platform)
            self.assertTrue(result['complete'],result)
            self.assertEqual(len(result['observations']),2,result)


if __name__ == '__main__': unittest.main()
