"""Seller sign-in is distinct from empty sales or a verified receipt list."""
import sys
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker import depop_sales as sales


class DepopSalesAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()

    def tearDown(self):
        self.page.close()

    def show(self, html, url=sales.RECEIPTS_URL):
        self.page.route('**/*', lambda route: route.fulfill(content_type='text/html', body=html))
        self.page.goto(url)

    def test_login_hydrating_after_navigation_has_an_actionable_error_and_reads_no_receipts(self):
        self.page.route('**/*', lambda route: route.fulfill(content_type='text/html', body="""
          <main>private fixture text</main><script>
          setTimeout(()=>document.body.innerHTML='<h1>Sign up or log in</h1>',50);
          </script>"""))
        with patch.object(sales, 'RECEIPT_LIST_SNAPSHOT', '()=>{window.receiptsRead=true;return null}'), \
                self.assertRaisesRegex(ValueError, 'sign-in is required.*Re-link Depop') as failure:
            sales.discover_receipts(self.page)
        self.assertNotIn('private fixture text', str(failure.exception))
        self.assertFalse(self.page.evaluate('!!window.receiptsRead'))

    def test_receipt_redirect_to_login_is_never_classified_as_a_sale(self):
        def route(request):
            if '/sellinghub/' in request.request.url:
                request.fulfill(status=302, headers={'location': 'https://www.depop.com/login/'})
            else:
                request.fulfill(content_type='text/html', body='<h1>Sign up or log in</h1>')
        self.page.route('**/*', route)
        with self.assertRaisesRegex(ValueError, 'sign-in is required'):
            sales.read_receipt(self.page, '123')

    def test_signed_in_views_pass_but_do_not_claim_receipt_coverage_by_themselves(self):
        self.show('<h1>Sold</h1>')
        self.assertIsNone(sales.wait_for_seller_view(self.page))
        self.page.set_content('<div role="dialog" aria-label="View Receipt modal"><h2>1 item sold</h2></div>')
        self.assertIsNone(sales.wait_for_seller_view(self.page, 'receipt'))
        with self.assertRaises(ValueError):
            sales.normalize_receipt_list({'urls': [], 'hasMore': False, 'loading': False})

    def test_login_during_pagination_takes_priority_over_a_stale_sold_view(self):
        self.show('<h1>Sold</h1><h1>Sign up or log in</h1>')
        with patch.object(sales, 'RECEIPT_LIST_SNAPSHOT', '()=>{window.receiptsRead=true;return null}'), \
                self.assertRaisesRegex(ValueError, 'sign-in is required'):
            sales.wait_for_receipt_list(self.page, 20)
        self.assertFalse(self.page.evaluate('!!window.receiptsRead'))

    def test_security_checks_and_foreign_pages_are_not_treated_as_verified_seller_views(self):
        self.show('<title>Just a moment...</title><h1>Verify you are human</h1><button onclick="window.clicked=true">Verify</button>')
        with self.assertRaisesRegex(ValueError, 'finish the check yourself'):
            sales.wait_for_seller_view(self.page)
        self.assertFalse(self.page.evaluate('!!window.clicked'))
        self.page.goto('https://not-depop.invalid/sellinghub/sold-items/')
        with self.assertRaisesRegex(ValueError, 'could not be verified'):
            sales.wait_for_seller_view(self.page)

    def test_timeouts_do_not_expose_receipt_or_customer_text_as_an_error(self):
        page = MagicMock()
        page.wait_for_function.side_effect = PlaywrightTimeoutError('PRIVATE CUSTOMER FIXTURE')
        for read in [sales.wait_for_seller_view, sales.wait_for_receipt_list]:
            with self.assertRaises(ValueError) as failure:
                read(page)
            self.assertNotIn('PRIVATE CUSTOMER FIXTURE', str(failure.exception))

    def test_expired_login_preserves_prior_new_sales_and_never_checkpoints_the_unread_receipt(self):
        with patch.object(sales, 'discover_receipts', return_value={'receiptIds': ['10', '1', '2'], 'complete': True}), \
                patch.object(sales, 'read_receipt', side_effect=[[{'classification': 'confirmed_sale'}], ValueError(sales.LOGIN_REQUIRED)]) as read:
            result = sales.scan_receipts(MagicMock(), known_confirmed_receipts=['10'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['checkedReceiptIds'], ['1'])
        self.assertEqual(result['confirmedReceiptIds'], ['1'])
        self.assertIn('Re-link Depop', result['reason'])
        self.assertEqual([call.args[1] for call in read.call_args_list], ['1', '2'])


if __name__ == '__main__':
    unittest.main()
