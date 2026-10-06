import os
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import end_depop as end

REQUEST = {"externalListingId": "seller-shirt", "externalUrl": "https://www.depop.com/products/seller-shirt/"}


class DepopRemovalTests(unittest.TestCase):
    def page(self):
        page = MagicMock()
        page.url = end.ACTIVE_URL
        return page

    def test_wrong_identity_is_rejected_before_any_page_action(self):
        page = self.page()
        result = end.remove_listing(page, {**REQUEST, "externalListingId": "other"}, MagicMock())
        self.assertEqual(result["outcome"], "failed")
        page.goto.assert_not_called()

    def test_missing_authorization_stops_before_navigation(self):
        page = self.page()
        result = end.remove_listing(page, REQUEST, MagicMock(side_effect=ValueError("item changed")))
        self.assertFalse(result["submissionStarted"])
        page.goto.assert_not_called()

    def test_already_sold_does_not_open_manage_or_confirm(self):
        page = self.page()
        with patch.object(end, "inspect_availability", return_value={"state": "unavailable"}), patch.object(end, "find_active_row") as find:
            result = end.remove_listing(page, REQUEST, MagicMock())
        self.assertEqual(result["outcome"], "ended")
        self.assertTrue(result["verified"])
        self.assertFalse(result["submissionStarted"])
        find.assert_not_called()
        page.get_by_role.assert_not_called()

    def test_authorization_is_rechecked_immediately_before_confirm(self):
        page = self.page()
        authorize = MagicMock(side_effect=[None, None, ValueError("item changed")])
        with patch.object(end, "inspect_availability", return_value={"state": "editable"}), patch.object(end, "find_active_row"), patch("playwright.sync_api.expect"):
            result = end.remove_listing(page, REQUEST, authorize)
        self.assertEqual(result["outcome"], "failed")
        self.assertFalse(result["submissionStarted"])
        self.assertEqual(authorize.call_count, 3)
        page.get_by_role.return_value.get_by_role.assert_called_once_with("menuitem", name="Mark as sold", exact=True)

    def test_lost_confirm_response_is_unknown(self):
        page = self.page()
        page.get_by_role.return_value.get_by_role.return_value.click.side_effect = [None, TimeoutError("response lost")]
        with patch.object(end, "inspect_availability", return_value={"state": "editable"}), patch.object(end, "find_active_row"), patch("playwright.sync_api.expect"):
            result = end.remove_listing(page, REQUEST, MagicMock())
        self.assertEqual(result["outcome"], "unknown")
        self.assertFalse(result["verified"])
        self.assertTrue(result["submissionStarted"])

    def test_final_product_check_must_confirm_sold(self):
        for final in ["editable", "unavailable"]:
            with self.subTest(final=final), patch.object(end, "inspect_availability", side_effect=[{"state": "editable"}, {"state": final}]), patch.object(end, "find_active_row"), patch("playwright.sync_api.expect"):
                result = end.remove_listing(self.page(), REQUEST, MagicMock())
            self.assertEqual(result["outcome"], "ended" if final == "unavailable" else "unknown")
            self.assertEqual(result["verified"], final == "unavailable")


if __name__ == "__main__": unittest.main()
