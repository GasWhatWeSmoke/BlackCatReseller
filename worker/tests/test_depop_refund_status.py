import sys
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.depop_sales import RECEIPT_SNAPSHOT, normalize_receipt


class DepopRefundStatusTests(unittest.TestCase):
    def test_dated_refund_label_is_not_a_sale_but_refund_actions_are_not_status(self):
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=find_real_chrome())
            try:
                page = browser.new_page()
                for refund, expected in [
                    ('<b>Payment refunded on</b><span>11 September 2026</span>', 'not_sale'),
                    ('<button><b>Payment refunded on</b></button>', 'confirmed_sale'),
                    ('<a href="/help"><b>Payment refunded on</b></a>', 'confirmed_sale'),
                ]:
                    with self.subTest(refund=refund):
                        page.set_content('<main><h2>1 item sold</h2>'
                                         '<a href="https://www.depop.com/products/seller-shirt/">Shirt</a>'
                                         '<b>Payment received</b>' + refund + '</main>')
                        snapshot = page.locator('main').evaluate(RECEIPT_SNAPSHOT)
                        result = normalize_receipt({**snapshot, 'receiptId': '123456'}, '123456')
                        self.assertEqual(result[0]['classification'], expected)
            finally:
                browser.close()
