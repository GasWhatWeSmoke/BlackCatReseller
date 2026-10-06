from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.ebay_form import set_field, field_value


class EbayRadioSpecificsTests(unittest.TestCase):
    def test_native_size_type_pills_preserve_or_change_one_pressed_choice(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<ul aria-label="Size Type">
                  <li><button aria-pressed="true" onclick="choose(this)">Regular</button></li>
                  <li><button aria-pressed="false" onclick="choose(this)">Big &amp; Tall</button></li></ul>
                  <script>window.clicks=0;function choose(target){window.clicks++;document.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===target)))}</script>''')
                self.assertEqual(set_field(page,['Size Type'],'Regular'),'Regular')
                self.assertEqual(page.evaluate('window.clicks'),0)
                self.assertEqual(set_field(page,['Size Type'],'Big & Tall'),'Big & Tall')
                self.assertEqual(page.evaluate('window.clicks'),1)
                self.assertEqual(field_value(page.get_by_label('Size Type',exact=True),['Size Type']),'Big & Tall')
            finally:browser.close()

    def test_size_type_uses_the_checked_option_instead_of_all_group_labels(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<fieldset aria-label="Size Type"><legend>Size Type</legend>
                  <label><input type="radio" name="size-type" value="regular">Regular</label>
                  <label><input type="radio" name="size-type" value="big" checked>Big &amp; Tall</label></fieldset>''')
                self.assertEqual(set_field(page,['Size Type'],'Regular'),'Regular')
                self.assertTrue(page.get_by_role('radio',name='Regular',exact=True).is_checked())
                self.assertFalse(page.get_by_role('radio',name='Big & Tall',exact=True).is_checked())
                self.assertEqual(field_value(page.get_by_label('Size Type',exact=True),['Size Type']),'Regular')
            finally:browser.close()
