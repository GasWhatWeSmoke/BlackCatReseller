"""A failed click is not proof that Depop rejected the listing."""
import os
import sys
import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import post_depop


class SubmissionTests(unittest.TestCase):
    def drive(self, failure=None, mode="post"):
        session = MagicMock()
        session.page.url = "https://www.depop.com/products/seller-shirt/"
        button = MagicMock()
        if failure == "click":
            button.click.side_effect = RuntimeError("click timed out")
        fields = {
            "price": 25, "description": "Shirt", "brand": None,
            "category_words": [], "size": None, "condition_candidates": [], "color": None,
        }
        reports = []
        with ExitStack() as stack:
            for name, value in [
                ("_ready_dir", "unused"), ("_load_item_json", {"listingPhotos": ["shirt.jpg"]}),
                ("build_depop_fields", fields), ("photo_paths", ["shirt.jpg"]),
                ("AssistedSession", session), ("_looks_logged_out", False),
                ("fill_listing_fields", {"description": True, "price": True}), ("_find_button", button),
                ("_save_failure_artifacts", None),
                ("assert_publish_authorized", None),
            ]:
                stack.enter_context(patch.object(post_depop, name, return_value=value))
            upload = stack.enter_context(patch.object(post_depop, "_upload_photos", return_value=1))
            if failure == "upload":
                upload.side_effect = RuntimeError("upload timed out")
            stack.enter_context(patch.object(post_depop, "_done", side_effect=reports.append))
            stack.enter_context(patch("playwright.sync_api.sync_playwright"))
            result = post_depop.run_post({"dataRoot": "unused"}, "000001", None, mode)
        session.close.assert_called_once()
        return result, reports, button

    def test_upload_failure_proves_no_submission_started(self):
        result, reports, button = self.drive("upload")
        self.assertEqual(result, 1)
        self.assertFalse(reports[-1]["submissionStarted"])
        button.click.assert_not_called()

    def test_click_timeout_is_ambiguous(self):
        result, reports, button = self.drive("click")
        self.assertEqual(result, 1)
        self.assertTrue(reports[-1]["submissionStarted"])
        self.assertEqual(reports[-1]["outcome"], "failed")
        button.click.assert_called_once()

    def test_success_retains_listing_url(self):
        result, reports, button = self.drive()
        self.assertEqual(result, 0)
        self.assertTrue(reports[-1]["submissionStarted"])
        self.assertEqual(reports[-1]["outcome"], "posted")
        self.assertEqual(reports[-1]["url"], "https://www.depop.com/products/seller-shirt/")
        button.click.assert_called_once()

    def test_handing_form_to_operator_is_also_potential_submission(self):
        result, reports, button = self.drive(mode="fill")
        self.assertEqual(result, 0)
        self.assertTrue(reports[-1]["submissionStarted"])
        self.assertEqual(reports[-1]["outcome"], "filled")
        button.click.assert_not_called()


if __name__ == "__main__":
    unittest.main()
