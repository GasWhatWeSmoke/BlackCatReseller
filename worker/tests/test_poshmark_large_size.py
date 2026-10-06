import sys
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.poshmark_form import select_size, fill_size


class PoshmarkLargeSizeTests(unittest.TestCase):
    def test_womens_alphabetic_jeans_size_uses_exact_custom_label_when_only_numbers_are_offered(self):
        from black_cat_worker.poshmark_form import verify_reviewed_size_selection
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button id="selected" class="dropdown__selector" onclick="menu.hidden=false">Select Size</button>
                  <div id="menu" hidden><button onclick="window.wrong=true">10</button><button onclick="window.wrong=true">12</button>
                  <span onclick="custom.hidden=false">Custom</span><div id="custom" hidden><input id="customSizeInput0">
                  <button onclick="window.pending=document.querySelector('input').value">Save</button></div>
                  <button onclick="selected.textContent=window.pending;menu.hidden=true">Done</button></div>''')
                self.assertEqual(fill_size(page,'Large','Women','Jeans'),'L')
                self.assertIsNone(page.evaluate('window.wrong'))
                verify_reviewed_size_selection(page,{'department':'Women','size':'L','reviewedSizeScale':True})
                page.locator('#selected').evaluate("e=>e.textContent='XL'")
                with self.assertRaises(AssertionError):verify_reviewed_size_selection(page,{'department':'Women','size':'L','reviewedSizeScale':True})
            finally:browser.close()

    def test_existing_alphabetic_jeans_size_is_preferred_to_custom(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page();page.set_content('''<button onclick="window.selected='L'">L</button><span onclick="window.wrong=true">Custom</span>''')
                self.assertEqual(select_size(page,'L','Women','Jeans'),'L')
                self.assertEqual(page.evaluate('window.selected'),'L');self.assertIsNone(page.evaluate('window.wrong'))
            finally:browser.close()

    def test_custom_alphabetic_jeans_size_is_limited_to_verified_single_womens_jeans(self):
        from black_cat_worker.poshmark_form import alphabetic_jeans_size
        self.assertTrue(alphabetic_jeans_size('Women','Jeans','Large',1))
        for args in [('Men','Jeans','L',1),('Women','Pants','L',1),('Women','Jeans','L',2),('Women','Jeans','27',1)]:
            self.assertFalse(alphabetic_jeans_size(*args))

    def test_reviewed_junior_number_uses_exact_custom_size_instead_of_nearby_adult_size(self):
        from black_cat_worker.poshmark_form import verify_reviewed_size_selection
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button id="selected" class="dropdown__selector" onclick="menu.hidden=false">Select Size</button>
                  <div id="menu" hidden><button onclick="window.wrong=true">2</button><button onclick="window.wrong=true">4</button>
                  <span onclick="custom.hidden=false">Custom</span><div id="custom" hidden><input id="customSizeInput0">
                  <button onclick="window.pending=document.querySelector('input').value">Save</button></div>
                  <button onclick="selected.textContent=window.pending;menu.hidden=true">Done</button></div>''')
                self.assertEqual(fill_size(page,'3','Women','Jeans',1,True),'3')
                self.assertIsNone(page.evaluate('window.wrong'))
                verify_reviewed_size_selection(page,{'department':'Women','size':'3','reviewedSizeScale':True})
                page.locator('#selected').evaluate("e=>e.textContent='4'")
                with self.assertRaises(AssertionError):verify_reviewed_size_selection(page,{'department':'Women','size':'3','reviewedSizeScale':True})
            finally:browser.close()

    def test_child_category_and_gendered_size_must_survive_photo_suggestions(self):
        from black_cat_worker.poshmark_form import verify_reviewed_size_selection
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page();page.set_default_timeout(100)
                page.set_content('<div class="dropdown__selector">Kids Bottoms</div><div class="dropdown__selector">Jeans</div><div id="size" class="dropdown__selector">8 (Boy)</div>')
                verify_reviewed_size_selection(page,{'department':'Kids','size':'8 (Boy)'})
                page.locator('#size').evaluate("e=>e.textContent='8 (Girl)'")
                with self.assertRaises(AssertionError):verify_reviewed_size_selection(page,{'department':'Kids','size':'8 (Boy)'})
            finally:browser.close()

    def test_juniors_tab_is_preferred_to_custom_or_a_nearby_standard_size(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<div id="standard"><button onclick="window.wrong=true">2</button><button onclick="window.wrong=true">4</button></div>
                  <span onclick="standard.hidden=true;juniors.hidden=false">Juniors</span><span onclick="window.wrong=true">Custom</span>
                  <div id="juniors" hidden><button onclick="window.chosen='3 (Juniors)'">3</button></div>''')
                self.assertEqual(select_size(page,'3','Women','Jeans',1,True),'3 (Juniors)')
                self.assertEqual(page.evaluate('window.chosen'),'3 (Juniors)');self.assertIsNone(page.evaluate('window.wrong'))
            finally:browser.close()

    def test_boys_size_uses_the_boys_tab_even_when_the_same_girls_number_is_visible(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<span onclick="girls.hidden=true;boys.hidden=false">Boys</span>
                  <div id="girls"><button onclick="window.chosen='8 (Girl)'">8</button></div>
                  <div id="boys" hidden><button onclick="window.chosen='8 (Boy)'">8</button></div>''')
                self.assertEqual(select_size(page,'8','Boys','Jeans'),'8 (Boy)')
                self.assertEqual(page.evaluate('window.chosen'),'8 (Boy)')
                with self.assertRaisesRegex(ValueError,'multi-unit'):select_size(page,'8','Boys','Jeans',2)
            finally:browser.close()

    def test_one_size_bag_retains_native_os_without_searching_for_select_size(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page();page.set_content('<button class="dropdown__selector" onclick="window.opened=true">OS</button>')
                self.assertEqual(fill_size(page,'One Size','Women','Shoulder Bag'),'OS')
                self.assertIsNone(page.evaluate('window.opened'))
            finally:browser.close()

    def test_belt_custom_size_requires_done_and_preserves_numeric_title_size(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button id="selected" class="dropdown__selector" onclick="menu.hidden=false">OS</button>
                  <div id="menu" hidden><button>One Size</button><span onclick="custom.hidden=false">Custom</span>
                  <div id="custom" hidden><input id="customSizeInput0"><button onclick="window.pending=document.querySelector('input').value">Save</button></div>
                  <button onclick="selected.textContent=window.pending;menu.hidden=true">Done</button></div>''')
                self.assertEqual(fill_size(page,'32','Men','Belt'),'32')
                self.assertEqual(page.locator('#selected').inner_text(),'32')
                self.assertTrue(page.locator('#menu').is_hidden())
            finally:browser.close()

    def test_petite_title_size_uses_petite_tab_and_never_regular_six(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button onclick="window.chosen='6'">6</button>
                  <span onclick="document.querySelector('#petites').hidden=false">\n Petite\n </span>
                  <div id="petites" hidden><button onclick="window.chosen='6P'">6P</button>
                  <button onclick="window.chosen='8P'">8P</button></div>''')
                self.assertEqual(select_size(page,'6p','Women'),'6P')
                self.assertEqual(page.evaluate('window.chosen'),'6P')
            finally:browser.close()

    def test_numeric_title_size_uses_the_exact_native_waist_label(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button onclick="window.chosen='Waist 28'">Waist 28</button>
                  <button onclick="window.chosen='Waist 38'">Waist 38</button>''')
                self.assertEqual(select_size(page,'28','Men'),'Waist 28')
                self.assertEqual(page.evaluate('window.chosen'),'Waist 28')
            finally:browser.close()

    def test_womens_xxl_selects_exact_plus_label_without_substituting_2x(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button onclick="window.opened=true;sizes.hidden=false">Plus</button>
                  <div id="sizes" hidden><button onclick="window.chosen='2X'">2X</button>
                    <button onclick="window.chosen='XXL'">XXL</button></div>''')
                self.assertEqual(select_size(page,'2XL','Women'),'XXL')
                self.assertEqual(page.evaluate('window.chosen'),'XXL')
                self.assertTrue(page.evaluate('window.opened'))
            finally:browser.close()

    def test_plain_xxl_uses_big_size_tab_without_selecting_tall_or_changing_other_sizes(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<button onclick="window.chosen='M'">M</button>
                  <button onclick="window.opened=true;sizes.hidden=false">Big &amp; Tall</button>
                  <div id="sizes" hidden><button onclick="window.chosen='2XLT'">2XLT</button>
                    <button onclick="window.chosen='XXL'">XXL</button></div>''')
                self.assertEqual(select_size(page,'Medium','Men'),'M')
                self.assertIsNone(page.evaluate('window.opened'))
                self.assertEqual(select_size(page,'2XL','Men'),'XXL')
                self.assertEqual(page.evaluate('window.chosen'),'XXL')
                self.assertTrue(page.evaluate('window.opened'))
            finally:browser.close()
