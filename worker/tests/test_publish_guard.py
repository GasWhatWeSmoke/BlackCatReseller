import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.publish_guard import assert_publish_authorized


class PublishGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = str(Path(self.directory.name, "guard.db"))
        self.connection = sqlite3.connect(self.database)
        self.connection.executescript('''
            CREATE TABLE Item(id INTEGER,sku TEXT,status TEXT);
            CREATE TABLE PublishRun(id INTEGER,status TEXT);
            CREATE TABLE PublishJob(itemId INTEGER,runId INTEGER,marketplace TEXT,status TEXT);
            CREATE TABLE MarketplaceListing(itemId INTEGER,marketplace TEXT,status TEXT);
            INSERT INTO Item VALUES(1,'000001','Ready for Nifty');
            INSERT INTO PublishRun VALUES(1,'running');
            INSERT INTO PublishJob VALUES(1,1,'etsy','publishing');
            INSERT INTO MarketplaceListing VALUES(1,'etsy','unknown');
        ''')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def check(self):
        assert_publish_authorized(1, "000001", "etsy", self.database)

    def test_current_reserved_attempt_can_publish(self): self.check()

    def test_sale_or_paused_run_stops_the_final_click(self):
        for statement in ["UPDATE Item SET status='Sold'", "UPDATE PublishRun SET status='paused'",
                          "UPDATE PublishJob SET status='cancelled'", "UPDATE MarketplaceListing SET status='published'"]:
            self.connection.execute("SAVEPOINT scenario")
            self.connection.execute(statement)
            self.connection.execute("RELEASE scenario")
            self.connection.commit()
            with self.assertRaises(ValueError): self.check()
            self.connection.execute("UPDATE Item SET status='Ready for Nifty'")
            self.connection.execute("UPDATE PublishRun SET status='running'")
            self.connection.execute("UPDATE PublishJob SET status='publishing'")
            self.connection.execute("UPDATE MarketplaceListing SET status='unknown'")
            self.connection.commit()

    def test_wrong_sku_or_ambiguous_active_job_cannot_publish(self):
        with self.assertRaises(ValueError): assert_publish_authorized(1, "000002", "etsy", self.database)
        self.connection.execute("INSERT INTO PublishJob VALUES(1,1,'etsy','publishing')")
        self.connection.commit()
        with self.assertRaises(ValueError): self.check()

    def test_missing_database_is_never_created(self):
        missing = str(Path(self.directory.name, "missing.db"))
        with self.assertRaises(ValueError): assert_publish_authorized(1, "000001", "etsy", missing)
        self.assertFalse(Path(missing).exists())
