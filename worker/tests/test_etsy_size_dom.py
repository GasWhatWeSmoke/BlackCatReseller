from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.etsy_form import fill_size


class EtsySizeDomTests(unittest.TestCase):
    def test_button_down_uses_chest_letter_size_without_changing_collar_size(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<label>Scale<select id="attributes-1-scale-select">
                  <option value="41">in</option><option value="42">US letter</option></select></label>
                  <label>Chest size<input id="chest" onclick="sizeChoices.hidden=false"></label>
                  <label>Collar size<input id="collar"></label>
                  <div id="sizeChoices" hidden><button role="menuitemradio"
                    onclick="chest.value='XL';sizeChoices.hidden=true">XL</button></div>''')
                item={'department':'Men','itemType':'long sleeve button down','size':'XL'}
                self.assertEqual(fill_size(page,item),'XL')
                self.assertEqual(page.get_by_label('Chest size',exact=True).input_value(),'XL')
                self.assertEqual(page.get_by_label('Collar size',exact=True).input_value(),'')
                self.assertEqual(page.locator('#attributes-1-scale-select').input_value(),'42')
                self.assertEqual(item['size'],'XL')
            finally:browser.close()

    def test_shorts_use_waist_label_and_keep_the_reviewed_letter_size(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<label>Choose a scale<select id="attributes-1-scale-select">
                  <option value="43">in</option><option value="44">US letter</option></select></label>
                  <label>Waist size<input id="waist" onclick="sizeChoices.hidden=false"></label>
                  <div id="sizeChoices" hidden><button role="menuitemradio"
                    onclick="waist.value='M';sizeChoices.hidden=true">M</button></div>''')
                item={'department':'Men','itemType':'Shorts','size':'M'}
                self.assertEqual(fill_size(page,item),'M')
                self.assertEqual(page.get_by_label('Waist size',exact=True).input_value(),'M')
                self.assertEqual(page.locator('#attributes-1-scale-select').input_value(),'44')
                self.assertEqual(item['size'],'M')
            finally:browser.close()
