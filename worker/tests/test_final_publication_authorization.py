"""Real CLI/SQLite authorization with simulated browser controls; no remote writes."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import post_depop, post_poshmark
from photo_snapshot_fixture import attach_photo_snapshot


class FinalPublicationAuthorizationTests(unittest.TestCase):
    def drive(self, market, *, initial_status="Ready", change_during_fill=None,
              click_error=None, verify_error=None, missing_database=False):
        with tempfile.TemporaryDirectory(prefix="blackcat-final-publication-") as folder:
            root = Path(folder).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("blackcat-final-publication-"))
            database = root / "test.db"
            db = sqlite3.connect(database)
            self.addCleanup(db.close)
            db.executescript('''
                CREATE TABLE Item(id INTEGER,sku TEXT,status TEXT);
                CREATE TABLE PublishRun(id INTEGER,status TEXT);
                CREATE TABLE PublishJob(itemId INTEGER,marketplace TEXT,runId INTEGER,status TEXT);
                CREATE TABLE MarketplaceListing(itemId INTEGER,marketplace TEXT,status TEXT);
                INSERT INTO PublishRun VALUES(1,'running');
            ''')
            db.execute("INSERT INTO Item VALUES(1,'000001',?)", (initial_status,))
            db.execute("INSERT INTO PublishJob VALUES(1,?,1,'publishing')", (market,))
            db.execute("INSERT INTO MarketplaceListing VALUES(1,?,'unknown')", (market,))
            db.commit()
            photo = root / "000001_01.jpg"
            photo.write_bytes(b"synthetic photo; upload is mocked")
            item = {"itemId": 1, "sku": "000001", "title": "Synthetic jacket",
                    "description": "Synthetic jacket", "condition": "Good", "price": 25,
                    "quantity": 1, "photos": [{"name": photo.name, "path": str(photo)}]}
            attach_photo_snapshot(db, root, item)
            module = post_depop if market == "depop" else post_poshmark
            session, final = MagicMock(), MagicMock()
            session.page.url = "https://www.depop.com/products/synthetic-jacket/"
            final.click.side_effect = click_error
            verified = MagicMock(return_value="https://poshmark.com/listing/" + "a" * 24,
                                 side_effect=verify_error)

            def fill(*_args, **_kwargs):
                if change_during_fill:
                    db.execute(change_during_fill)
                    db.commit()
                return {}

            output = io.StringIO()
            try:
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, {"BLACKCAT_DB_PATH": str(
                        root / "missing.db" if missing_database else database)}))
                    stack.enter_context(patch.object(sys, "argv", ["test", "--sku", "000001", "--mode", "post", "--listing-stdin"]))
                    stack.enter_context(patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(item).encode()))))
                    stack.enter_context(patch.object(module.config, "load_settings", return_value={"dataRoot": str(root)}))
                    session_factory = stack.enter_context(patch.object(module, "AssistedSession", return_value=session))
                    stack.enter_context(patch("playwright.sync_api.sync_playwright"))
                    filled = stack.enter_context(patch.object(module, "fill_listing_fields", side_effect=fill))
                    if market == "depop":
                        stack.enter_context(patch.object(module, "_looks_logged_out", return_value=False))
                        stack.enter_context(patch.object(module, "_upload_photos", return_value=1))
                        stack.enter_context(patch.object(module, "_find_button", return_value=final))
                        stack.enter_context(patch.object(module, "_save_failure_artifacts"))
                        verified = stack.enter_context(patch.object(module, "submitted_listing_url",
                            return_value=session.page.url, side_effect=verify_error))
                    else:
                        stack.enter_context(patch.object(module, "attach_photos", return_value=1))
                        stack.enter_context(patch.object(module, "verify_reviewed_size_selection"))
                        stack.enter_context(patch.object(module, "prepare_submission", return_value=(final, "a" * 24)))
                        stack.enter_context(patch.object(module.run_on_page, "__defaults__", (verified,)))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    code = module.main()
                reports = [json.loads(line.split(" ", 1)[1]) for line in output.getvalue().splitlines()
                           if line.startswith(market.upper() + "_DONE ")]
                self.assertEqual(1, len(reports))
                self.assertFalse((root / "missing.db").exists())
                return code, reports[0], final, verified, filled, session_factory
            finally:
                db.close()

    def test_an_already_sold_item_is_rejected_before_opening_a_browser(self):
        for market in ("depop", "poshmark"):
            with self.subTest(market=market):
                code, report, final, _, filled, session = self.drive(market, initial_status="Sold")
                self.assertEqual(1, code)
                self.assertEqual("failed", report["outcome"])
                self.assertFalse(report["submissionStarted"])
                final.click.assert_not_called()
                filled.assert_not_called()
                session.assert_not_called()

    def test_a_sale_during_form_filling_prevents_the_final_click(self):
        for market in ("depop", "poshmark"):
            with self.subTest(market=market):
                code, report, final, verified, filled, _ = self.drive(market, change_during_fill="UPDATE Item SET status='Sold'")
                self.assertEqual(1, code)
                self.assertFalse(report["submissionStarted"])
                self.assertIn("no longer authorized", report["reason"])
                filled.assert_called_once()
                final.click.assert_not_called()
                verified.assert_not_called()

    def test_photo_edits_during_filling_prevent_the_final_click(self):
        for market in ("depop", "poshmark"):
            for change in ["UPDATE Photo SET rotation=90", "UPDATE Photo SET includeInListing=0",
                           "UPDATE Item SET readyFolderPath='another export'"]:
                with self.subTest(market=market, change=change):
                    code, report, final, verified, filled, _ = self.drive(market, change_during_fill=change)
                    self.assertEqual(1, code)
                    self.assertFalse(report['submissionStarted'])
                    self.assertIn('Prepared photos', report['reason'])
                    filled.assert_called_once()
                    final.click.assert_not_called()
                    verified.assert_not_called()

    def test_revoked_reservations_during_fill_cannot_submit(self):
        for market in ("depop", "poshmark"):
            for change in ["UPDATE PublishRun SET status='paused'", "UPDATE PublishRun SET status='cancelled'",
                           "UPDATE PublishJob SET status='cancelled'", "UPDATE MarketplaceListing SET status='published'",
                           "UPDATE Item SET sku='000002'"]:
                with self.subTest(market=market, change=change):
                    code, report, final, _, filled, _ = self.drive(market, change_during_fill=change)
                    self.assertEqual(1, code)
                    self.assertFalse(report["submissionStarted"])
                    filled.assert_called_once()
                    final.click.assert_not_called()

    def test_authorized_reservations_keep_the_success_path(self):
        for market in ("depop", "poshmark"):
            with self.subTest(market=market):
                code, report, final, verified, _, _ = self.drive(market)
                self.assertEqual(0, code)
                self.assertEqual("posted", report["outcome"])
                self.assertTrue(report["submissionStarted"])
                final.click.assert_called_once()
                verified.assert_called_once()

    def test_click_or_verification_failures_remain_ambiguous(self):
        for market in ("depop", "poshmark"):
            for key in ("click_error", "verify_error"):
                with self.subTest(market=market, failure=key):
                    code, report, final, _, _, _ = self.drive(market, **{key: TimeoutError("synthetic response lost")})
                    self.assertEqual(1, code)
                    self.assertEqual("failed", report["outcome"])
                    self.assertTrue(report["submissionStarted"])
                    final.click.assert_called_once()

    def test_a_missing_database_does_not_create_a_file_or_open_a_browser(self):
        for market in ("depop", "poshmark"):
            with self.subTest(market=market):
                code, report, final, _, _, session = self.drive(market, missing_database=True)
                self.assertEqual(1, code)
                self.assertFalse(report["submissionStarted"])
                final.click.assert_not_called()
                session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
