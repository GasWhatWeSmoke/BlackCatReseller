"""Unavailable inventory is not empty inventory: preserve all existing photos."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import process
from black_cat_worker.decode import DecodeOutcome


class WorkerDatabaseBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="blackcat-database-boundary-")
        self.root = Path(self.directory.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("blackcat-database-boundary-"))
        self.addCleanup(self.directory.cleanup)
        self.settings = {key: str(self.root / name) for key, name in [
            ("incomingPath", "incoming"), ("processingPath", "processing"),
            ("needsReviewPath", "review"), ("archivePath", "archive"),
            ("readyPath", "ready"), ("exportsPath", "exports"),
            ("logsPath", "logs"), ("backupsPath", "backups")]}
        self.settings.update(dataRoot=str(self.root), visionEnabled=False, ocrEnabled=False, fileStabilitySeconds=0)
        self.incoming = Path(self.settings["incomingPath"])
        self.incoming.mkdir()
        Image.new("RGB", (40, 50), "red").save(self.incoming / "001.jpg")
        Image.new("RGB", (40, 50), "white").save(self.incoming / "002.jpg")
        self.existing = Path(self.settings["processingPath"]) / "000001/000001_01.jpg"
        self.existing.parent.mkdir(parents=True)
        Image.new("RGB", (40, 50), "blue").save(self.existing)
        self.original_hash = hashlib.sha256(self.existing.read_bytes()).hexdigest()
        self.database = self.root / "test.db"
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.executescript('CREATE TABLE AppSettings(id INTEGER,data TEXT); CREATE TABLE Item(sku TEXT); CREATE TABLE FileHash(sha256 TEXT);')
            db.execute("INSERT INTO AppSettings VALUES(1,?)", (json.dumps(self.settings),))
            db.execute("INSERT INTO Item VALUES('000001')")
            db.commit()
        self.sku = "000001"

    def edit_database(self, statement, values=()):
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute(statement, values)
            db.commit()

    def assert_preserved(self):
        self.assertEqual(self.original_hash, hashlib.sha256(self.existing.read_bytes()).hexdigest())
        self.assertEqual({"001.jpg", "002.jpg"}, {file.name for file in self.incoming.iterdir()})

    def run_worker(self, dry=False):
        sku = self.sku
        class Decoder:
            def __init__(self, _settings): pass
            def engine_status(self): return {"qr_opencv": True, "qr_pyzbar": True, "ocr_paddle": True}
            def decode(self, filename):
                return DecodeOutcome(sku, sku, "qr-opencv", True) if Path(filename).name == "002.jpg" else DecodeOutcome(None, None, None)
        with patch.dict(os.environ, {"BLACKCAT_DB_PATH": str(self.database), "BLACKCAT_DATA_ROOT": str(self.root)}), \
                patch.object(process, "Decoder", Decoder), contextlib.redirect_stdout(io.StringIO()):
            return process.run(SimpleNamespace(incoming=None, dry_run=dry), cancel_check=lambda: None)

    def test_missing_database_stops_before_copy_and_is_not_created(self):
        self.database = self.root / "missing.db"
        with self.assertRaisesRegex(process.dbmod.InventoryReadError, "database is unavailable"):
            self.run_worker()
        self.assertFalse(self.database.exists())
        self.assert_preserved()

    def test_missing_or_invalid_settings_never_fall_back_to_other_folders(self):
        for value in [None, "not json", "[]", "null"]:
            with self.subTest(settings=value):
                self.edit_database("DELETE FROM AppSettings")
                if value is not None: self.edit_database("INSERT INTO AppSettings VALUES(1,?)", (value,))
                with self.assertRaisesRegex(process.dbmod.InventoryReadError, "settings"):
                    self.run_worker()
                self.assert_preserved()

    def test_denied_sku_or_hash_queries_cannot_replace_existing_photos(self):
        for blocked in ["Item", "FileHash"]:
            with self.subTest(table=blocked):
                db = sqlite3.connect(self.database)
                db.set_authorizer(lambda action, table, *_: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == blocked else sqlite3.SQLITE_OK)
                with patch.object(process.dbmod, "connect", return_value=db), self.assertRaises(process.dbmod.InventoryReadError):
                    self.run_worker()
                self.assert_preserved()
                with self.assertRaises(sqlite3.ProgrammingError): db.execute("SELECT 1")

    def test_valid_existing_sku_still_uses_collision_processing(self):
        result = self.run_worker()
        self.assertEqual([], result["items"])
        self.assertEqual("000001", result["collisions"][0]["sku"])
        self.assert_preserved()

    def test_valid_empty_inventory_can_import_a_new_sku(self):
        self.edit_database("DELETE FROM Item")
        self.sku = "000002"
        result = self.run_worker()
        self.assertEqual("000002", result["items"][0]["sku"])
        self.assertEqual([], result["collisions"])
        self.assert_preserved()

    def test_inventory_added_during_analysis_is_a_collision_before_copying(self):
        self.sku = "000002"
        def enrich(items, *_args, **_kwargs):
            self.edit_database("INSERT INTO Item VALUES('000002')")
            return {id(item): {} for item in items}
        with patch.object(process, "_precompute_enrichments", side_effect=enrich):
            result = self.run_worker()
        self.assertEqual([], result["items"])
        self.assertEqual("000002", result["collisions"][0]["sku"])
        self.assert_preserved()

    def test_read_failure_after_analysis_stops_before_mutation(self):
        db = sqlite3.connect(self.database)
        def enrich(items, *_args, **_kwargs):
            db.set_authorizer(lambda action, table, *_: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == "Item" else sqlite3.SQLITE_OK)
            return {id(item): {} for item in items}
        with patch.object(process.dbmod, "connect", return_value=db), \
                patch.object(process, "_precompute_enrichments", side_effect=enrich), \
                self.assertRaises(process.dbmod.InventoryReadError):
            self.run_worker()
        self.assert_preserved()

    def test_read_only_dry_run_can_inspect_without_an_initialized_database(self):
        self.database = self.root / "missing.db"
        result = self.run_worker(dry=True)
        self.assertEqual("000001", result["items"][0]["sku"])
        self.assertFalse(self.database.exists())
        self.assert_preserved()


if __name__ == "__main__": unittest.main()
