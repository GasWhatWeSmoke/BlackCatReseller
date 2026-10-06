"""Pure-logic tests for the Depop poster (post_depop.py) — no Playwright, no network.

Run:  python -m unittest worker.tests.test_depop_logic   (from project root)
Covers the field building the browser driver moves into Depop's form: the
title-first description with its 1000-char trim, hashtag derivation, condition
candidate mapping, and the 8-photo cap with cover-first ordering.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest.mock import patch

_WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from black_cat_worker import post_depop as D  # noqa: E402


def item(**over):
    base = {
        "sku": "000084",
        "title": "NWT Ed Hardy Womens Colorblock Tattoo-print Shoulder Bag Pink Graphic Print",
        "description": "Bold tattoo-print shoulder bag in loud Y2K colors.",
        "brand": "Ed Hardy",
        "itemType": "Shoulder Bag",
        "categoryGroup": "Bag",
        "style": "Y2K",
        "color": "Pink",
        "pattern": "Graphic",
        "size": None,
        "sizeless": True,
        "condition": "New with tags",
        "price": 49.99,
    }
    base.update(over)
    return base


class HashtagTests(unittest.TestCase):
    def test_tags_come_from_what_the_item_is(self):
        tags = D.build_hashtags(item())
        self.assertEqual(tags, ["edhardy", "shoulderbag", "y2k", "pink", "graphic"])

    def test_tags_are_capped_and_deduped(self):
        tags = D.build_hashtags(item(style="Pink", pattern="Pink"))
        self.assertLessEqual(len(tags), D.DEPOP_MAX_TAGS)
        self.assertEqual(len(tags), len(set(tags)))

    def test_unknown_brand_contributes_no_tag(self):
        self.assertNotIn("unknown", D.build_hashtags(item(brand="Unknown")))


class DescriptionTests(unittest.TestCase):
    def test_title_is_the_first_line_and_tags_close(self):
        desc = D.build_description(item())
        self.assertTrue(desc.startswith("NWT Ed Hardy"))
        self.assertIn("Bold tattoo-print", desc)
        self.assertTrue(desc.rstrip().endswith("#graphic"))

    def test_long_body_is_trimmed_but_title_and_tags_survive(self):
        desc = D.build_description(item(description="word " * 400))
        self.assertLessEqual(len(desc), D.DEPOP_DESC_MAX)
        self.assertTrue(desc.startswith("NWT Ed Hardy"))
        self.assertIn("#edhardy", desc)

    def test_empty_description_still_produces_the_title(self):
        desc = D.build_description(item(description=""))
        self.assertTrue(desc.startswith("NWT Ed Hardy"))


class FieldTests(unittest.TestCase):
    def test_every_black_cat_condition_has_depop_candidates(self):
        for c in ["New with tags", "New without tags", "Like new", "Good", "Fair", "Pre-owned"]:
            self.assertTrue(D.DEPOP_CONDITION[c], c)

    def test_fields_carry_condition_candidates_in_preference_order(self):
        f = D.build_depop_fields(item(condition="Good"))
        self.assertEqual(f["condition_candidates"][0], "Used - Good")

    def test_unknown_brand_becomes_none_not_a_literal(self):
        self.assertIsNone(D.build_depop_fields(item(brand="Unknown"))["brand"])

    def test_category_words_lead_with_the_item_type(self):
        f = D.build_depop_fields(item())
        self.assertEqual(f["category_words"], ["Shoulder Bag", "Bag"])


class PhotoTests(unittest.TestCase):
    def test_cap_is_eight_cover_first_and_missing_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as ready:
            os.makedirs(os.path.join(ready, "listing_photos"))
            rels = []
            for i in range(1, 11):  # ten exported photos
                rel = f"listing_photos/000084_{i:02d}.jpg"
                rels.append(rel)
                if i != 9:  # photo 9 vanished from disk
                    with open(os.path.join(ready, rel.replace("/", os.sep)), "w") as f:
                        f.write("x")
            picked = D.photo_paths(ready, rels)
            self.assertEqual(len(picked), D.DEPOP_MAX_PHOTOS)
            self.assertTrue(picked[0].endswith("000084_01.jpg"), "cover photo first")

    def test_no_photos_is_empty_not_an_error(self):
        with tempfile.TemporaryDirectory() as ready:
            self.assertEqual(D.photo_paths(ready, []), [])


class AssistedBrowserTests(unittest.TestCase):
    def test_env_override_wins_for_chrome_path(self):
        from black_cat_worker import assisted_browser as AB
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as f:
            fake = f.name
        try:
            old = os.environ.get("BLACKCAT_CHROME_PATH")
            os.environ["BLACKCAT_CHROME_PATH"] = fake
            self.assertEqual(AB.find_real_chrome(), fake)
        finally:
            if old is None:
                os.environ.pop("BLACKCAT_CHROME_PATH", None)
            else:
                os.environ["BLACKCAT_CHROME_PATH"] = old
            os.unlink(fake)

    def test_free_port_returns_preferred_when_open(self):
        from black_cat_worker import assisted_browser as AB
        # An almost-certainly-free high port comes back as itself.
        self.assertEqual(AB._free_port(9351), 9351)

    @patch('black_cat_worker.work_browser.work_window_bounds', return_value={'left':167,'top':-1244,'width':1600,'height':1000})
    def test_manual_login_never_enables_debugging_or_automation(self, _display):
        from black_cat_worker import assisted_browser as AB
        args = AB.manual_login_args(
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"E:\BlackCat\depop-profile",
            "https://www.depop.com/login/",
        )
        joined = " ".join(args).lower()
        self.assertIn("--user-data-dir=", joined)
        self.assertIn("--new-window", args)
        self.assertNotIn("remote-debugging", joined)
        self.assertNotIn("enable-automation", joined)
        self.assertNotIn("webdriver", joined)


if __name__ == "__main__":
    unittest.main()
