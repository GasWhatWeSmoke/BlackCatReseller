"""Only the selected receipt's item subtotal feeds earnings."""
import sys
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.depop_sales import read_receipt


class DepopReceiptMoneyTests(unittest.TestCase):
    def test_receipt_subtotal_excludes_background_orders_and_net_total(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.route('**/*',lambda route:route.fulfill(content_type='text/html',body='''
                  <main><table><tr><td class="x__labelText">Items Price</td><td class="x__priceText">US$999.99</td></tr></table></main>
                  <div role="dialog" aria-label="View Receipt modal"><h2>1 item sold</h2><b>Payment received</b>
                  <a href="https://www.depop.com/products/seller-shirt/">Item</a>
                  <table><tr><td class="x__labelText">Items Price</td><td class="x__priceText">US$15.99</td></tr>
                  <tr><td class="x__labelText">Total</td><td class="x__priceText">US$14.89</td></tr></table></div>'''))
                self.assertEqual(read_receipt(page,'123')[0]['financials'],{'currency':'USD','salePriceCents':1599})
            finally:browser.close()
