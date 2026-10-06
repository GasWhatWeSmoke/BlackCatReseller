import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO / "scripts" / "relocate_sqlite_paths.py"
SPEC = importlib.util.spec_from_file_location("relocate_sqlite_paths", MODULE_PATH)
relocate = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = relocate
SPEC.loader.exec_module(relocate)


SCHEMA = """
CREATE TABLE Item (
    id INTEGER PRIMARY KEY,
    processingFolderPath TEXT,
    readyFolderPath TEXT
);
CREATE TABLE Photo (
    id INTEGER PRIMARY KEY,
    storedPath TEXT NOT NULL,
    thumbPath TEXT
);
CREATE TABLE FileHash (
    id INTEGER PRIMARY KEY,
    processedPath TEXT
);
CREATE TABLE ProblemLog (
    id INTEGER PRIMARY KEY,
    photoPath TEXT,
    message TEXT
);
CREATE TABLE AppSettings (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE Collision (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    incomingPhotosJson TEXT NOT NULL
);
"""


class RelocationFixture:
    def __init__(self, base: Path):
        self.base = base
        self.old_root = base / "old-checkout"
        self.new_root = base / "current-checkout"
        self.db = base / "black-cat.db"
        self.new_root.mkdir()

        self.paths = {
            "processing": self.new_root / "var" / "processing" / "000001",
            "ready": self.new_root / "var" / "ready-for-nifty" / "000001",
            "stored": self.new_root / "var" / "processing" / "000001" / "photo.jpg",
            "thumb": self.new_root / "var" / "processing" / "000001" / "thumbs" / "photo.jpg",
            "collision": self.new_root / "var" / "processing" / "000002" / "photo.jpg",
            "python": self.new_root / "worker" / ".venv" / "Scripts" / "python.exe",
        }
        for key in ("processing", "ready"):
            self.paths[key].mkdir(parents=True, exist_ok=True)
        for key in ("stored", "thumb", "collision", "python"):
            self.paths[key].parent.mkdir(parents=True, exist_ok=True)
            self.paths[key].write_bytes(key.encode("ascii"))
        for leaf in (
            "incoming",
            "processing",
            "ready-for-nifty",
            "needs-review",
            "archive",
            "exports",
            "logs",
            "backups",
        ):
            (self.new_root / "var" / leaf).mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(self.db)
        conn.executescript(SCHEMA)
        conn.execute(
            "INSERT INTO Item VALUES (1, ?, ?)",
            (self.old_value(self.paths["processing"]), self.old_value(self.paths["ready"])),
        )
        # Store one path with forward slashes to exercise both historical styles.
        conn.execute(
            "INSERT INTO Photo VALUES (1, ?, ?)",
            (
                self.old_value(self.paths["stored"]).replace("\\", "/"),
                self.old_value(self.paths["thumb"]),
            ),
        )
        conn.execute(
            "INSERT INTO FileHash VALUES (1, ?)",
            (self.old_value(self.paths["stored"]),),
        )
        # ProblemLog paths are historical; missing mapped files are expected.
        historical_path = self.old_value(self.new_root / "var" / "incoming" / "gone.jpg")
        historical_forward = historical_path.replace("\\", "/")
        conn.execute(
            "INSERT INTO ProblemLog VALUES (1, ?, ?)",
            (
                historical_path,
                f"kept context: {historical_path}; forward={historical_forward}; suffix unchanged",
            ),
        )
        conn.execute("INSERT INTO AppSettings VALUES (1, ?)", (json.dumps(self.settings()),))
        collision = [{
            "storedPath": self.old_value(self.paths["collision"]).replace("\\", "/"),
            "thumbPath": None,
            "sha256": "abc",
        }]
        conn.execute(
            "INSERT INTO Collision VALUES (1, 'pending', ?)",
            (json.dumps(collision),),
        )
        conn.commit()
        conn.close()

    def old_value(self, target: Path) -> str:
        relative = target.relative_to(self.new_root)
        return str(self.old_root / relative)

    def settings(self) -> dict:
        var = self.old_root / "var"
        return {
            "dataRoot": str(var),
            "incomingPath": str(var / "incoming"),
            "processingPath": str(var / "processing"),
            "readyPath": str(var / "ready-for-nifty"),
            "needsReviewPath": str(var / "needs-review"),
            "archivePath": str(var / "archive"),
            "exportsPath": str(var / "exports"),
            "logsPath": str(var / "logs"),
            "backupsPath": str(var / "backups"),
            "pythonWorkerPath": self.old_value(self.paths["python"]),
            "visionEnabled": True,
        }

    def scalar(self, table: str, column: str, row_id: int = 1):
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute(
                f"SELECT [{column}] FROM [{table}] WHERE id=?", (row_id,)
            ).fetchone()[0]
        finally:
            conn.close()


class RelocateSqlitePathsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = RelocationFixture(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_dry_run_is_default_read_only_and_plans_both_slash_styles(self):
        before = self.fixture.db.read_bytes()
        plan = relocate.dry_run(
            self.fixture.db,
            str(self.fixture.old_root),
            str(self.fixture.new_root),
        )

        self.assertEqual(before, self.fixture.db.read_bytes())
        self.assertGreater(len(plan.changes), 0)
        self.assertGreater(plan.references["old"], 0)
        self.assertGreater(plan.references["historical_old"], 0)
        self.assertEqual(1, len(plan.missing_historical))
        self.assertEqual(
            [],
            list((self.fixture.new_root / "var" / "backups").glob("*-pre-relocation-*.db")),
        )

    def test_apply_creates_sqlite_backup_verifies_counts_and_is_idempotent(self):
        backup = self.fixture.base / "backups" / "before.db"
        plan, actual_backup = relocate.apply_relocation(
            self.fixture.db,
            str(self.fixture.old_root),
            str(self.fixture.new_root),
            backup,
        )

        self.assertEqual(backup.resolve(), actual_backup)
        self.assertTrue(backup.is_file())
        self.assertGreater(len(plan.changes), 0)
        self.assertTrue(
            self.fixture.scalar("Photo", "storedPath").startswith(
                str(self.fixture.new_root).replace("\\", "/")
            )
        )
        self.assertEqual(
            str(self.fixture.paths["thumb"]),
            self.fixture.scalar("Photo", "thumbPath"),
        )
        expected_message = (
            f"kept context: {self.fixture.new_root / 'var' / 'incoming' / 'gone.jpg'}; "
            f"forward={str(self.fixture.new_root / 'var' / 'incoming' / 'gone.jpg').replace(chr(92), '/')}; "
            "suffix unchanged"
        )
        self.assertEqual(
            expected_message,
            self.fixture.scalar("ProblemLog", "message"),
        )
        self.assertEqual(1, plan.field_changes["ProblemLog.message"])

        settings = json.loads(self.fixture.scalar("AppSettings", "data"))
        self.assertEqual(str(self.fixture.new_root / "var"), settings["dataRoot"])
        self.assertTrue(settings["visionEnabled"])
        collision = json.loads(self.fixture.scalar("Collision", "incomingPhotosJson"))
        self.assertTrue(
            collision[0]["storedPath"].startswith(
                str(self.fixture.new_root).replace("\\", "/")
            )
        )

        backup_conn = sqlite3.connect(backup)
        try:
            old_stored = backup_conn.execute("SELECT storedPath FROM Photo WHERE id=1").fetchone()[0]
            self.assertIn(str(self.fixture.old_root).replace("\\", "/"), old_stored)
            old_message = backup_conn.execute(
                "SELECT message FROM ProblemLog WHERE id=1"
            ).fetchone()[0]
            self.assertIn(str(self.fixture.old_root), old_message)
            self.assertEqual("ok", backup_conn.execute("PRAGMA quick_check").fetchone()[0])
        finally:
            backup_conn.close()

        unused_backup = self.fixture.base / "backups" / "unused.db"
        second_plan, second_backup = relocate.apply_relocation(
            self.fixture.db,
            str(self.fixture.old_root),
            str(self.fixture.new_root),
            unused_backup,
        )
        self.assertEqual([], second_plan.changes)
        self.assertIsNone(second_backup)
        self.assertFalse(unused_backup.exists())

    def test_unknown_active_prefix_aborts_before_backup_or_mutation(self):
        conn = sqlite3.connect(self.fixture.db)
        conn.execute("UPDATE Photo SET storedPath=? WHERE id=1", (r"Z:\external\photo.jpg",))
        conn.commit()
        conn.close()
        before = self.fixture.db.read_bytes()
        backup = self.fixture.base / "unknown-backup.db"

        with self.assertRaisesRegex(relocate.RelocationError, "unknown active path prefix"):
            relocate.apply_relocation(
                self.fixture.db,
                str(self.fixture.old_root),
                str(self.fixture.new_root),
                backup,
            )

        self.assertEqual(before, self.fixture.db.read_bytes())
        self.assertFalse(backup.exists())

    def test_missing_active_target_aborts_but_missing_history_is_allowed(self):
        self.fixture.paths["thumb"].unlink()
        with self.assertRaisesRegex(relocate.RelocationError, "mapped active target"):
            relocate.dry_run(
                self.fixture.db,
                str(self.fixture.old_root),
                str(self.fixture.new_root),
            )

    def test_missing_or_foreign_file_hash_target_aborts(self):
        self.fixture.paths["stored"].unlink()
        with self.assertRaisesRegex(relocate.RelocationError, "mapped active target"):
            relocate.dry_run(
                self.fixture.db,
                str(self.fixture.old_root),
                str(self.fixture.new_root),
            )

        self.fixture.paths["stored"].write_bytes(b"stored")
        conn = sqlite3.connect(self.fixture.db)
        conn.execute(
            "UPDATE FileHash SET processedPath=? WHERE id=1",
            (r"Z:\external\dedup-photo.jpg",),
        )
        conn.commit()
        conn.close()
        with self.assertRaisesRegex(relocate.RelocationError, "unknown active path prefix"):
            relocate.dry_run(
                self.fixture.db,
                str(self.fixture.old_root),
                str(self.fixture.new_root),
            )

    def test_failure_after_first_update_rolls_back_transaction(self):
        before = self.fixture.scalar("Item", "processingFolderPath")
        backup = self.fixture.base / "rollback-backup.db"
        real_apply = relocate._apply_changes

        def fail_after_update(conn, plan):
            first_only = relocate.RelocationPlan(changes=plan.changes[:1])
            real_apply(conn, first_only)
            raise relocate.RelocationError("injected failure")

        with mock.patch.object(relocate, "_apply_changes", side_effect=fail_after_update):
            with self.assertRaisesRegex(relocate.RelocationError, "injected failure"):
                relocate.apply_relocation(
                    self.fixture.db,
                    str(self.fixture.old_root),
                    str(self.fixture.new_root),
                    backup,
                )

        self.assertEqual(before, self.fixture.scalar("Item", "processingFolderPath"))
        self.assertTrue(backup.is_file())


if __name__ == "__main__":
    unittest.main()
