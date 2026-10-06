from contextlib import ExitStack
import os
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import post_etsy as post


class EtsyPostingTests(unittest.TestCase):
    item = {"itemId": 1, "sku": "000001", "title": "Reviewed shirt", "description": "Reviewed details", "price": 25,
            "quantity": 1, "trueVintage": True, "whenMade": "1990s (Vintage)"}
    options = {"shippingProfileName": "clothes", "autoRenew": False}

    def run_case(self, mode="post", authorization_error=None, verification=None, click_error=None):
        page = MagicMock()
        page.locator.return_value.first.evaluate.return_value = "https://i.etsystatic.com/1/r/il/a/123456/il_224xN.123456_a.jpg"
        page.locator.return_value.get_by_role.return_value.click.side_effect = click_error
        authorize = MagicMock(side_effect=authorization_error)
        verify = MagicMock(return_value=verification or "https://www.etsy.com/listing/12345/updated-slug")
        with ExitStack() as stack:
            for name in ["fill_category", "fill_size", "fill_reviewed_core", "fill_shipping_profile", "fill_package", "set_renewal", "verify_filled_listing"]:
                stack.enter_context(patch.object(post, name))
            stack.enter_context(patch.object(post, "attach_photos", return_value=2))
            stack.enter_context(patch.object(post, "wait_published_url", return_value="https://www.etsy.com/listing/12345/shirt"))
            stack.enter_context(patch("playwright.sync_api.expect"))
            result = post.run_on_page(page, self.item, ["a", "b"], self.options, mode, authorize, verify)
        return result, page, authorize, verify

    def test_fill_mode_never_clicks_either_publish_button(self):
        result, page, authorize, verify = self.run_case("fill")
        self.assertEqual(result["outcome"], "filled")
        self.assertFalse(result["submissionStarted"])
        page.locator.return_value.get_by_role.return_value.click.assert_not_called()
        authorize.assert_not_called(); verify.assert_not_called()

    def test_cancelled_run_stops_before_submission(self):
        result, page, _, verify = self.run_case(authorization_error=ValueError("run paused"))
        self.assertFalse(result["submissionStarted"])
        page.locator.return_value.get_by_role.return_value.click.assert_not_called()
        verify.assert_not_called()

    def test_first_publish_timeout_stays_uncertain(self):
        result, _, _, verify = self.run_case(click_error=TimeoutError("lost response"))
        self.assertEqual(result["outcome"], "failed")
        self.assertTrue(result["submissionStarted"])
        verify.assert_not_called()

    def test_success_requires_same_id_after_public_verification_and_checks_authority_three_times(self):
        result, _, authorize, verify = self.run_case()
        self.assertEqual(result["outcome"], "posted")
        self.assertEqual(authorize.call_count, 3)
        self.assertEqual(verify.call_args.args[2], "123456")
        result, _, _, _ = self.run_case(verification="https://www.etsy.com/listing/99999/shirt")
        self.assertEqual(result["outcome"], "failed")
        self.assertTrue(result["submissionStarted"])

    def test_listing_and_photo_identity_reject_unrelated_hosts_and_owner_preview_urls(self):
        self.assertEqual(post.listing_id("https://www.etsy.com/listing/12345/shirt?ref=shop"), "12345")
        for url in [post.CREATE_URL, "https://www.etsy.com.evil.test/listing/12345", "https://user:secret@www.etsy.com/listing/12345"]:
            self.assertIsNone(post.listing_url(url))
        self.assertEqual(post.image_id("https://i.etsystatic.com/1/r/il/a/123456/il_fullxfull.123456_a.jpg"), "123456")
        self.assertIsNone(post.image_id("https://example.com/123456/il_fullxfull.123456_a.jpg"))
