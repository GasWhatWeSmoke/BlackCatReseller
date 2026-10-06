"""Restore a SQLite backup to a temporary copy and verify records/media references."""
import argparse
import json
import sqlite3
import tempfile
from pathlib import Path


def verify(file):
    with tempfile.TemporaryDirectory(prefix="blackcat-restore-check-") as directory:
        source = sqlite3.connect(Path(file).resolve().as_uri() + "?mode=ro", uri=True)
        restored = sqlite3.connect(str(Path(directory) / "restored.db"))
        try:
            source.backup(restored)
            integrity = restored.execute("PRAGMA integrity_check").fetchone()[0]
            foreign_keys = len(restored.execute("PRAGMA foreign_key_check").fetchall())
            items = restored.execute("SELECT count(*) FROM Item").fetchone()[0]
            photos = restored.execute("SELECT storedPath,thumbPath FROM Photo").fetchall()
            missing_photos = sum(not Path(photo[0]).is_file() for photo in photos)
            missing_thumbnails = sum(bool(photo[1]) and not Path(photo[1]).is_file() for photo in photos)
            return {"ok": integrity == "ok" and foreign_keys == 0 and missing_photos == 0 and missing_thumbnails == 0,
                    "integrity": integrity == "ok", "foreignKeyViolations": foreign_keys, "items": items, "photos": len(photos),
                    "missingPhotos": missing_photos, "missingThumbnails": missing_thumbnails, "restoredToTemporaryCopy": True}
        finally:
            source.close()
            restored.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.file)), flush=True)
    except Exception:
        print(json.dumps({"ok": False, "error": "Backup verification could not finish. Check that this is a readable Black Cat database backup."}), flush=True)
