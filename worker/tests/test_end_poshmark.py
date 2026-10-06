import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.delist_guard import assert_delist_authorized
from black_cat_worker import end_poshmark as end

IDENTITY = "abcdef123456789012345678"
REQUEST = {"externalListingId": IDENTITY, "externalUrl": f"https://poshmark.com/listing/Shirt-{IDENTITY}"}


class DelistGuardTests(unittest.TestCase):
    def test_only_the_current_sold_item_and_attempt_are_authorized(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root)/"test.db"
            connection = sqlite3.connect(file)
            try:
                connection.executescript("CREATE TABLE Item(id INTEGER,status TEXT); CREATE TABLE MarketplaceListing(id INTEGER,itemId INTEGER,marketplace TEXT,externalListingId TEXT,status TEXT,attemptCount INTEGER);")
                connection.execute("INSERT INTO Item VALUES(1,'Sold')")
                connection.execute("INSERT INTO MarketplaceListing VALUES(1,1,'poshmark',?,'delisting',2)", (IDENTITY,))
                connection.commit()
                assert_delist_authorized(1, "poshmark", IDENTITY, 2, str(file))
                for marketplace, identity, attempt in [("ebay", IDENTITY, 2), ("poshmark", "other", 2), ("poshmark", IDENTITY, 1)]:
                    with self.assertRaises(ValueError): assert_delist_authorized(1, marketplace, identity, attempt, str(file))
                connection.execute("UPDATE Item SET status='Ready for Nifty'"); connection.commit()
                with self.assertRaises(ValueError): assert_delist_authorized(1, "poshmark", IDENTITY, 2, str(file))
            finally: connection.close()

    def test_a_missing_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root)/"missing.db"
            with self.assertRaises(ValueError): assert_delist_authorized(1, "poshmark", IDENTITY, 1, str(file))
            self.assertFalse(file.exists())


class PoshmarkRemovalTests(unittest.TestCase):
    def page(self):
        page = MagicMock()
        page.url = f"https://poshmark.com/edit-listing/{IDENTITY}"
        page.locator.return_value.filter.return_value.inner_text.return_value = "For Sale"
        return page

    def test_missing_authorization_stops_before_any_page_action(self):
        with patch.object(end, "inspect_availability") as inspect:
            result = end.remove_listing(self.page(), REQUEST, MagicMock(side_effect=ValueError("not authorized")))
        self.assertEqual(result["outcome"], "failed")
        self.assertFalse(result["submissionStarted"])
        inspect.assert_not_called()

    def test_already_unavailable_needs_no_update(self):
        page = self.page()
        with patch.object(end, "inspect_availability", return_value={"state": "unavailable", "url": REQUEST["externalUrl"]}):
            result = end.remove_listing(page, REQUEST, MagicMock())
        self.assertEqual(result["outcome"], "ended")
        self.assertTrue(result["verified"])
        self.assertFalse(result["submissionStarted"])
        page.get_by_role.assert_not_called()

    def test_authorization_is_rechecked_before_update(self):
        page = self.page()
        authorize = MagicMock(side_effect=[None, None, ValueError("item changed")])
        with patch.object(end, "inspect_availability", return_value={"state": "editable", "url": REQUEST["externalUrl"], "title": "Reviewed shirt"}), \
             patch("playwright.sync_api.expect", return_value=MagicMock()):
            result = end.remove_listing(page, REQUEST, authorize)
        self.assertEqual(result["outcome"], "unknown")
        self.assertTrue(result["submissionStarted"])
        page.get_by_role.assert_not_called()
        self.assertEqual(authorize.call_count, 3)

    def test_update_timeout_is_never_reported_as_removed(self):
        page = self.page()
        page.get_by_role.return_value.click.side_effect = TimeoutError("response lost")
        with patch.object(end, "inspect_availability", return_value={"state": "editable", "url": REQUEST["externalUrl"], "title": "Reviewed shirt"}), \
             patch("playwright.sync_api.expect", return_value=MagicMock()):
            result = end.remove_listing(page, REQUEST, MagicMock())
        self.assertEqual(result["outcome"], "unknown")
        self.assertFalse(result["verified"])

    def test_verified_update_retains_the_same_listing_identity(self):
        page = self.page()
        with patch.object(end, "inspect_availability", side_effect=[{"state": "editable", "url": REQUEST["externalUrl"], "title": "Reviewed shirt"}, {"state": "unavailable", "url": REQUEST["externalUrl"]}]), \
             patch("playwright.sync_api.expect", return_value=MagicMock()):
            result = end.remove_listing(page, REQUEST, MagicMock())
        self.assertEqual(result["outcome"], "ended")
        self.assertTrue(result["verified"])
        self.assertEqual(result["externalListingId"], IDENTITY)


if __name__ == "__main__": unittest.main()
