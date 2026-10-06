import io
import json
import math
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.direct_listing import MAX_INPUT_BYTES, canonical_item_and_photos, read_listing_input
from black_cat_worker import post_depop


class DirectListingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.photos = []
        for number in (2, 1):
            name = f"000001_{number:02d}.jpg"
            filename = os.path.join(self.temp.name, name)
            with open(filename, "wb") as photo:
                photo.write(b"fixture")
            self.photos.append({"name": name, "path": filename})
        self.listing = {
            "sku": "000001", "title": "Current reviewed title", "description": "Current reviewed description",
            "price": 34.99, "condition": "Good", "quantity": 1, "size": "M", "brand": "Current brand",
            "color": None, "material": "", "photos": self.photos,
        }

    def test_current_copy_nulls_and_photo_order_survive_transport(self):
        serialized = io.BytesIO(json.dumps(self.listing).encode("utf-8"))
        item, photos = canonical_item_and_photos(read_listing_input(serialized), "000001")
        self.assertEqual(item["title"], "Current reviewed title")
        self.assertEqual(item["price"], 34.99)
        self.assertIsNone(item["color"])
        self.assertEqual(item["material"], "")
        self.assertEqual(photos, [entry["path"] for entry in self.photos])
        self.assertTrue(photos[0].endswith("000001_02.jpg"))

    def test_different_item_cannot_supply_photos_for_the_requested_sku(self):
        with self.assertRaisesRegex(ValueError, "SKU"):
            canonical_item_and_photos(self.listing, "000002")
        self.listing["photos"][0]["name"] = "000002_01.jpg"
        with self.assertRaisesRegex(ValueError, "another SKU"):
            canonical_item_and_photos(self.listing, "000001")

    def test_missing_and_duplicate_photos_stop_the_upload(self):
        self.listing["photos"] = [self.photos[0], self.photos[0]]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            canonical_item_and_photos(self.listing, "000001")
        self.listing["photos"] = self.photos
        os.unlink(self.photos[0]["path"])
        with self.assertRaisesRegex(ValueError, "missing"):
            canonical_item_and_photos(self.listing, "000001")

    def test_empty_stock_invalid_price_and_incomplete_copy_are_rejected(self):
        for value in [0, -1, True, math.nan, math.inf, "25"]:
            with self.subTest(price=value), self.assertRaisesRegex(ValueError, "price"):
                canonical_item_and_photos({**self.listing, "price": value}, "000001")
        for value in [0, -1, True, 1.5, "2"]:
            with self.subTest(quantity=value), self.assertRaisesRegex(ValueError, "quantity"):
                canonical_item_and_photos({**self.listing, "quantity": value}, "000001")
        with self.assertRaisesRegex(ValueError, "description"):
            canonical_item_and_photos({**self.listing, "description": ""}, "000001")

    def test_malformed_and_oversized_input_is_not_a_listing(self):
        for raw in [b"not json", b"null", b"[]", b" " * (MAX_INPUT_BYTES + 1)]:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                read_listing_input(io.BytesIO(raw))

    def test_worker_rejects_wrong_sku_before_opening_a_browser_or_loading_old_export(self):
        reports = []
        with patch.object(post_depop, "AssistedSession") as browser, \
             patch.object(post_depop, "_load_item_json") as old_export, \
             patch.object(post_depop, "_done", side_effect=reports.append):
            result = post_depop.run_post({"dataRoot": self.temp.name}, "000002", None, "post", self.listing)
        self.assertEqual(result, 1)
        browser.assert_not_called()
        old_export.assert_not_called()
        self.assertFalse(reports[-1]["submissionStarted"])

    def test_worker_uses_current_description_and_price_instead_of_old_export(self):
        from unittest.mock import MagicMock
        from contextlib import ExitStack, closing
        import sqlite3
        session = MagicMock()
        session.page.url = "https://www.depop.com/products/seller-shirt/"
        self.listing.update(itemId=1, brand=None, size=None, color=None, condition="Good")
        database = os.path.join(self.temp.name, "reservation.db")
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript('''
                CREATE TABLE Item(id INTEGER,sku TEXT,status TEXT);
                CREATE TABLE PublishRun(id INTEGER,status TEXT);
                CREATE TABLE PublishJob(itemId INTEGER,runId INTEGER,marketplace TEXT,status TEXT);
                CREATE TABLE MarketplaceListing(itemId INTEGER,marketplace TEXT,status TEXT);
                INSERT INTO Item VALUES(1,'000001','Ready');
                INSERT INTO PublishRun VALUES(1,'running');
                INSERT INTO PublishJob VALUES(1,1,'depop','publishing');
                INSERT INTO MarketplaceListing VALUES(1,'depop','unknown');
            ''')
            from photo_snapshot_fixture import attach_photo_snapshot
            attach_photo_snapshot(connection, self.temp.name, self.listing)
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"BLACKCAT_DB_PATH": database}))
            stack.enter_context(patch("playwright.sync_api.sync_playwright"))
            stack.enter_context(patch.object(post_depop, "AssistedSession", return_value=session))
            old_export = stack.enter_context(patch.object(post_depop, "_load_item_json", return_value={"price": 1, "description": "Old"}))
            stack.enter_context(patch.object(post_depop, "_looks_logged_out", return_value=False))
            stack.enter_context(patch.object(post_depop, "_upload_photos", return_value=2))
            fill = stack.enter_context(patch.object(post_depop, "fill_listing_fields", return_value={"description": True, "price": True}))
            stack.enter_context(patch.object(post_depop, "_find_button", return_value=MagicMock()))
            stack.enter_context(patch.object(post_depop, "_done"))
            self.assertEqual(post_depop.run_post({"dataRoot": self.temp.name}, "000001", None, "post", self.listing), 0)
        old_export.assert_not_called()
        current_item, current_fields = fill.call_args.args[1:]
        self.assertEqual(current_item["price"], 34.99)
        self.assertIn("Current reviewed description", current_fields["description"])
        self.assertNotEqual(current_item["price"], 1)


if __name__ == "__main__":
    unittest.main()
