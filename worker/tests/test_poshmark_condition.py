from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.poshmark_form import select_condition


class PoshmarkConditionTests(unittest.TestCase):
    def test_nwt_selects_the_menu_option_not_duplicate_explanatory_copy(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button id="selected" class="dropdown__selector" onclick="conditions.hidden=false">Select Condition</button>
                  <ul id="conditions" hidden><li><div onclick="selected.textContent=this.textContent;conditions.hidden=true">New With Tags (NWT)</div></li></ul>
                  <span onclick="window.wrong=true">New With Tags (NWT)</span>''')
                select_condition(page,'New With Tags (NWT)')
                self.assertEqual(page.locator('#selected').inner_text(),'New With Tags (NWT)')
                self.assertIsNone(page.evaluate('window.wrong'))
            finally:browser.close()
