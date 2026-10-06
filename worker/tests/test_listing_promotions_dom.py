"""Paid boost selection and final checks against a local native-form fixture."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.depop_form import configure_boost
from black_cat_worker.ebay_promotion import configure_promotion, validate_ad_rate


class DepopBoostDomTests(unittest.TestCase):
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
        self.page.set_content('<label><input type="checkbox">Promote your item in search. '
                              'If it sells, pay an extra fee (12%, excluding shipping).</label>')

    def tearDown(self):
        self.page.close()

    def test_enabled_boost_is_retained_and_final_check_never_repairs_a_reset(self):
        configure_boost(self.page, True)
        configure_boost(self.page, True, verify_only=True)
        box = self.page.get_by_role('checkbox')
        box.uncheck()
        self.page.set_default_timeout(100)
        with self.assertRaises(AssertionError):
            configure_boost(self.page, True, verify_only=True)
        self.assertFalse(box.is_checked())

    def test_disabled_boost_removes_a_preselected_paid_option(self):
        self.page.get_by_role('checkbox').check()
        configure_boost(self.page, False)
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())

    def test_changed_or_missing_fee_and_invalid_setting_cannot_enable_boost(self):
        for rate in ['15%', '112%', '2.12%', '']:
            self.page.set_content(f'<label><input type="checkbox">Promote your item in search. Fee {rate}</label>')
            with self.assertRaisesRegex(ValueError, 'fee changed'):
                configure_boost(self.page, True)
            self.assertFalse(self.page.get_by_role('checkbox').is_checked())
        for value in ['true', 1, None]:
            with self.assertRaisesRegex(ValueError, 'true or false'):
                configure_boost(self.page, value)


class EbayPromotionDomTests(unittest.TestCase):
    setUpClass = classmethod(DepopBoostDomTests.setUpClass.__func__)
    tearDownClass = classmethod(DepopBoostDomTests.tearDownClass.__func__)
    setUp = DepopBoostDomTests.setUp
    tearDown = DepopBoostDomTests.tearDown

    def ebay_fixture(self):
        self.page.set_content('''<label><input type="checkbox" role="switch" id="general">Toggle General</label>
          <label><input type="checkbox" role="switch" id="priority" checked>Toggle Priority</label>
          <label><input type="radio" name="strategy" id="dynamic" checked>Dynamic ad rate Recommended</label>
          <label><input type="radio" name="strategy" id="fixed">Fixed ad rate Manually manage</label>
          <label>Ad rate<input type="text" id="rate" value="12"></label>''')

    def test_fixed_rate_disables_priority_and_dynamic_and_verifies_saved_value(self):
        self.ebay_fixture()
        configure_promotion(self.page, 2.5)
        configure_promotion(self.page, 2.5, verify_only=True)
        self.assertTrue(self.page.locator('#general').is_checked())
        self.assertFalse(self.page.locator('#priority').is_checked())
        self.assertFalse(self.page.locator('#dynamic').is_checked())
        self.assertEqual(self.page.locator('#rate').input_value(), '2.5')
        self.page.locator('#rate').fill('12')
        with self.assertRaisesRegex(ValueError, 'ad rate changed'):
            configure_promotion(self.page, 2.5, verify_only=True)
        self.assertEqual(self.page.locator('#rate').input_value(), '12')

    def test_disabled_promotions_clear_existing_paid_controls(self):
        self.ebay_fixture()
        self.page.locator('#general').check()
        configure_promotion(self.page, None)
        self.assertFalse(self.page.locator('#general').is_checked())
        self.assertFalse(self.page.locator('#priority').is_checked())

    def test_bad_rates_or_missing_general_control_fail_without_enabling_paid_ads(self):
        for rate in [True, '2', 0, 1.9, 100.1, 2.25, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):validate_ad_rate(rate)
        self.page.set_content('<label><input type="checkbox">Promote your listing</label>')
        with self.assertRaisesRegex(ValueError, 'General promotion control is missing'):
            configure_promotion(self.page, 2)
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())

    def test_native_editor_manual_listing_rate_is_filled_and_rechecked(self):
        self.page.set_content('''<label><input type="checkbox" role="switch">Toggle General</label>
          <label><input type="checkbox" role="switch">Toggle Priority</label>
          <span>Listing ad rate</span><button aria-label="Help tip for Listing ad rate field">?</button>
          <input aria-label="Ad rate in percent" value="12">''')
        configure_promotion(self.page, 2)
        configure_promotion(self.page, 2, verify_only=True)
        self.assertEqual(self.page.get_by_role('textbox').input_value(), '2')

    def test_priority_reenabled_after_filling_fails_final_check(self):
        self.ebay_fixture()
        configure_promotion(self.page, 2)
        self.page.locator('#priority').check()
        with self.assertRaises(AssertionError):
            configure_promotion(self.page, 2, verify_only=True)
        self.assertTrue(self.page.locator('#priority').is_checked())


if __name__ == '__main__':
    unittest.main()
