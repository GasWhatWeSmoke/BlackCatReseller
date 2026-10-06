"""Reviewed field text must never select an unrelated page action."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker import ebay_form, mercari_form, poshmark_form, choice_scope


class FieldChoiceScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.external = []
        self.page.route('**/*', lambda route: (self.external.append(route.request.url), route.abort()))
        timer = patch.object(choice_scope, 'SCOPE_TIMEOUT_MS', 150)
        timer.start()
        self.addCleanup(timer.stop)

    def tearDown(self):
        self.assertEqual(self.external, [])

    def test_ebay_missing_menu_does_not_click_the_matching_final_action(self):
        self.page.set_content('''<button aria-label="Brand">Choose brand</button>
          <button onclick="window.finalClicks=(window.finalClicks||0)+1">List it</button>''')
        with self.assertRaises(ValueError):
            ebay_form.set_field(self.page, ['Brand'], 'List it')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)
        self.assertEqual(self.page.get_by_label('Brand').inner_text(), 'Choose brand')
        self.assertEqual(self.external, [])

    def test_mercari_missing_brand_menu_does_not_click_the_matching_final_action(self):
        self.page.set_content('''<button aria-label="Brand">Choose brand</button>
          <button onclick="window.finalClicks=(window.finalClicks||0)+1">List</button>''')
        with self.assertRaises(ValueError):
            mercari_form.set_value(self.page, ['Brand'], 'List')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)
        self.assertEqual(self.page.get_by_label('Brand').inner_text(), 'Choose brand')
        self.assertEqual(self.external, [])

    def test_poshmark_size_cannot_select_the_listing_next_button(self):
        self.page.set_content('''<button class="dropdown__selector">Select Size</button>
          <button onclick="window.finalClicks=(window.finalClicks||0)+1">Next</button>''')
        with self.assertRaises(ValueError):
            poshmark_form.fill_size(self.page, 'Next', 'Women', 'Shirt')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)
        self.assertEqual(self.external, [])

    def test_linked_menu_can_choose_identical_text_without_touching_outside_actions(self):
        for setter in [lambda: ebay_form.set_field(self.page, ['Brand'], 'List it'),
                       lambda: mercari_form.set_value(self.page, ['Brand'], 'List it')]:
            with self.subTest(setter=setter):
                self.page.set_content('''<script>window.optionClicks=0;window.finalClicks=0;window.otherDone=0</script>
                  <button id="brand" aria-label="Brand" aria-controls="brands"
                  onclick="brands.hidden=false">Choose brand</button>
                  <div id="brands" role="listbox" hidden><button role="option"
                  onclick="window.optionClicks=(window.optionClicks||0)+1;brand.textContent='List it';brands.hidden=true">List it</button></div>
                  <button onclick="window.finalClicks=(window.finalClicks||0)+1">List it</button>
                  <div role="dialog"><button onclick="window.otherDone=(window.otherDone||0)+1">Done</button></div>''')
                setter()
                self.assertEqual(self.page.get_by_label('Brand').inner_text(), 'List it')
                self.assertEqual(self.page.evaluate('window.optionClicks'), 1)
                self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)
                self.assertEqual(self.page.evaluate('window.otherDone||0'), 0)

    def test_an_existing_unrelated_dialog_cannot_supply_the_requested_choice(self):
        self.page.set_content('''<button aria-label="Brand">Choose brand</button>
          <div role="dialog"><button onclick="window.finalClicks=(window.finalClicks||0)+1">List it</button></div>''')
        with self.assertRaises(ValueError):
            ebay_form.set_field(self.page, ['Brand'], 'List it')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)

    def test_an_unknown_adjacent_action_panel_is_not_a_generic_dropdown(self):
        self.page.set_content('''<button aria-label="Brand" onclick="actions.hidden=false">Choose brand</button>
          <div id="actions" hidden><button onclick="window.finalClicks=(window.finalClicks||0)+1">List it</button></div>''')
        with self.assertRaises(ValueError):
            ebay_form.set_field(self.page, ['Brand'], 'List it')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)

    def test_an_invalid_explicit_link_cannot_fall_back_to_another_opened_dialog(self):
        self.page.set_content('''<button aria-label="Brand" aria-controls="missing" onclick="other.hidden=false">Choose brand</button>
          <div id="other" role="dialog" hidden><button onclick="window.finalClicks=(window.finalClicks||0)+1">List it</button></div>''')
        with self.assertRaises(ValueError):
            ebay_form.set_field(self.page, ['Brand'], 'List it')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)

    def test_ambiguous_new_panels_fail_before_selecting_any_value(self):
        self.page.set_content('''<button aria-label="Brand" onclick="a.hidden=false;b.hidden=false">Choose brand</button>
          <span></span><div role="listbox" id="a" hidden><button role="option" onclick="window.clicked=true">Nike</button></div>
          <div role="listbox" id="b" hidden><button role="option" onclick="window.clicked=true">Nike</button></div>''')
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            ebay_form.set_field(self.page, ['Brand'], 'Nike')
        self.assertIsNone(self.page.evaluate('window.clicked'))

    def test_a_new_nested_dialog_commits_only_its_own_picker(self):
        self.page.set_content('''<button id="brand" aria-label="Brand" aria-expanded="false" onclick="picker.showModal()">Choose brand</button>
          <span></span><dialog id="picker"><div role="listbox"><button role="option" onclick="window.pending='Nike'">Nike</button></div>
          <button onclick="brand.textContent=window.pending;picker.close()">Done</button></dialog>
          <button onclick="window.otherDone=true">Done</button>''')
        self.assertEqual(ebay_form.set_field(self.page, ['Brand'], 'Nike'), 'Nike')
        self.assertTrue(self.page.locator('#picker').is_hidden())
        self.assertIsNone(self.page.evaluate('window.otherDone'))

    def test_a_form_link_is_not_a_choice_container(self):
        self.page.set_content('''<main id="editor"><button aria-label="Brand" aria-controls="editor">Choose brand</button>
          <button onclick="window.finalClicks=(window.finalClicks||0)+1">List it</button></main>''')
        with self.assertRaisesRegex(ValueError, 'separately from the form'):
            ebay_form.set_field(self.page, ['Brand'], 'List it')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)

    def test_one_new_picker_can_contain_multiple_reviewed_size_groups(self):
        self.page.set_content('''<button id="size" aria-label="Size" onclick="picker.showModal()">Select</button><span></span>
          <dialog id="picker"><details open><summary>Regular</summary><div role="listbox">
          <button role="option" onclick="window.pending='Regular - M'">M</button></div></details>
          <details open><summary>Plus</summary><div role="listbox"><button role="option" onclick="window.wrong=true">M</button></div></details>
          <button onclick="size.textContent=window.pending;picker.close()">Done</button></dialog>''')
        self.assertEqual(ebay_form.set_field(self.page, ['Size'], 'M', group='Regular'), 'M')
        self.assertEqual(self.page.get_by_label('Size').inner_text(), 'Regular - M')
        self.assertIsNone(self.page.evaluate('window.wrong'))

    def test_native_adjacent_size_picker_does_not_use_the_page_next_action(self):
        self.page.set_content('''<button id="size" class="dropdown__selector" onclick="choices.hidden=false">Select Size</button>
          <div id="choices" hidden><button onclick="size.textContent='M';choices.hidden=true">M</button></div>
          <button onclick="window.finalClicks=(window.finalClicks||0)+1">Next</button>''')
        self.assertEqual(poshmark_form.fill_size(self.page, 'M', 'Women', 'Shirt'), 'M')
        self.assertEqual(self.page.locator('#size').inner_text(), 'M')
        self.assertEqual(self.page.evaluate('window.finalClicks||0'), 0)


if __name__ == '__main__':
    unittest.main()
