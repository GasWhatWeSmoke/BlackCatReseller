"""Recheck the active publication reservation immediately before a final click."""
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from .photo_snapshot import assert_photo_snapshot

_AUTHORIZATION_ONLY = object()


def assert_publish_authorized(item_id, sku, marketplace, database_path=None, *,
                              photo_snapshot=_AUTHORIZATION_ONLY, photo_paths=None):
    database = database_path or os.environ.get("BLACKCAT_DB_PATH")
    if type(item_id) is not int or item_id < 1 or not database or not Path(database).is_absolute() or not Path(database).is_file():
        raise ValueError("Publication requires the app's existing item and database")
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        def check_reservation():
            rows = connection.execute(
                'SELECT i.sku,i.status,r.status,l.status FROM Item i '
                'JOIN PublishJob j ON j.itemId=i.id AND j.marketplace=? '
                'JOIN PublishRun r ON r.id=j.runId '
                'JOIN MarketplaceListing l ON l.itemId=i.id AND l.marketplace=j.marketplace '
                'WHERE i.id=? AND j.status=?', (marketplace, item_id, "publishing"),
            ).fetchall()
            if len(rows) != 1 or rows[0] not in {(sku, "Ready", "running", "unknown"), (sku, "Ready for Nifty", "running", "unknown")}:
                raise ValueError("Publication is no longer authorized: the item sold, changed status, or its run stopped")
        check_reservation()
        if photo_snapshot is not _AUTHORIZATION_ONLY:
            assert_photo_snapshot(connection, item_id, sku, photo_snapshot, photo_paths)
            check_reservation()  # Hashing must not hide a sale or cancellation that just arrived.
