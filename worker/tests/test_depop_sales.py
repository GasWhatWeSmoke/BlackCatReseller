import os
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.depop_sales import normalize_receipt, product_identity, normalize_receipt_list, scan_receipts


def snapshot():
    return {"receiptId": "123456", "heading": "1 item sold", "paymentReceived": True, "negativeMarkers": [],
            "products": ["https://www.depop.com/products/seller-shirt/"]}


class DepopSalesTests(unittest.TestCase):
    def test_payment_receipt_confirms_exact_products_without_customer_data(self):
        value = snapshot(); value["buyer"] = "not collected"
        result = normalize_receipt(value, "123456")[0]
        self.assertEqual(result["classification"], "confirmed_sale")
        self.assertEqual(result["listingId"], "seller-shirt")
        self.assertNotIn("buyer", result)

    def test_missing_payment_or_refund_marker_cannot_confirm_a_sale(self):
        value = snapshot(); value["paymentReceived"] = False
        self.assertEqual(normalize_receipt(value, "123456")[0]["classification"], "requires_review")
        value = snapshot(); value["negativeMarkers"] = ["Refund sent"]
        self.assertEqual(normalize_receipt(value, "123456")[0]["classification"], "not_sale")

    def test_image_and_title_links_do_not_duplicate_one_sale(self):
        value = snapshot(); value["products"] *= 2
        self.assertEqual(len(normalize_receipt(value, "123456")), 1)

    def test_incomplete_bundles_or_wrong_receipts_are_rejected(self):
        value = snapshot(); value["heading"] = "2 items sold"
        with self.assertRaises(ValueError): normalize_receipt(value, "123456")
        with self.assertRaises(ValueError): normalize_receipt(snapshot(), "654321")

    def test_product_identity_never_accepts_create_pages_or_other_hosts(self):
        for value in ["https://www.depop.com/products/create/", "https://depop.com.evil.test/products/seller-shirt/", "https://user:password@depop.com/products/seller-shirt/"]:
            self.assertIsNone(product_identity(value))

    def test_receipt_discovery_deduplicates_links_and_requires_known_pagination(self):
        value = {"urls": ["https://www.depop.com/sellinghub/sold-items/123/"] * 3,
                 "hasMore": True, "loading": False}
        self.assertEqual(normalize_receipt_list(value), {"receiptIds": ["123"], "hasMore": True, "loading": False})
        for invalid in [None, {**value, "hasMore": "false"}, {**value, "urls": []},
                        {**value, "urls": ["https://example.com/sellinghub/sold-items/123/"]},
                        {**value, "urls": ["https://www.depop.com/sellinghub/sold-items/"]}]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError): normalize_receipt_list(invalid)

    def test_limited_receipt_reads_remain_incomplete(self):
        with patch("black_cat_worker.depop_sales.discover_receipts", return_value={"receiptIds": ["1", "2"], "complete": True}), \
             patch("black_cat_worker.depop_sales.read_receipt", return_value=[{"classification": "confirmed_sale"}]) as read:
            result = scan_receipts(MagicMock(), max_receipts=1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["checkedReceiptIds"], ["1"])
        self.assertEqual(result["confirmedReceiptIds"], ["1"])
        self.assertEqual(read.call_count, 1)

    def test_only_prior_confirmed_receipts_are_skipped_and_pending_states_are_not_cached(self):
        with patch("black_cat_worker.depop_sales.discover_receipts", return_value={"receiptIds": ["1", "2", "3"], "complete": True}), \
             patch("black_cat_worker.depop_sales.read_receipt", side_effect=[[{"classification": "requires_review"}], [{"classification": "confirmed_sale"}]]) as read:
            result = scan_receipts(MagicMock(), known_confirmed_receipts=["1"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["checkedReceiptIds"], ["2", "3"])
        self.assertEqual(result["confirmedReceiptIds"], ["3"])
        self.assertEqual([call.args[1] for call in read.call_args_list], ["2", "3"])

    def test_partial_discovery_never_becomes_a_complete_scan(self):
        with patch("black_cat_worker.depop_sales.discover_receipts", return_value={"receiptIds": ["1"], "complete": False, "reason": "page limit"}), \
             patch("black_cat_worker.depop_sales.read_receipt", return_value=[{"classification": "confirmed_sale"}]):
            result = scan_receipts(MagicMock())
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "page limit")

    def test_unread_receipts_are_not_silently_recorded_as_checked(self):
        with patch("black_cat_worker.depop_sales.discover_receipts", return_value={"receiptIds": ["1", "2", "3"], "complete": True}), \
             patch("black_cat_worker.depop_sales.read_receipt", side_effect=[[{"classification": "confirmed_sale"}], ValueError("receipt failed")]) as read:
            result = scan_receipts(MagicMock())
        self.assertFalse(result["complete"])
        self.assertEqual(result["checkedReceiptIds"], ["1"])
        self.assertEqual(result["confirmedReceiptIds"], ["1"])
        self.assertEqual(result["errors"][0]["receiptId"], "2")
        self.assertEqual(read.call_count, 2)

    def test_invalid_prior_receipts_are_rejected_before_browser_navigation(self):
        page = MagicMock()
        with self.assertRaises(ValueError): scan_receipts(page, known_confirmed_receipts=["not-an-id"])
        page.goto.assert_not_called()


if __name__ == "__main__": unittest.main()
