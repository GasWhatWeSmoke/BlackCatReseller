"""Read-only authorization check for a queued, single-item marketplace removal."""
import os
import sqlite3
from contextlib import closing
from pathlib import Path


def assert_delist_authorized(listing_row_id, marketplace, external_id, attempt, database_path=None):
    if type(listing_row_id) is not int or listing_row_id < 1 or type(attempt) is not int or attempt < 1:
        raise ValueError("Removal needs a valid listing row and attempt")
    database = database_path or os.environ.get("BLACKCAT_DB_PATH")
    if not database or not Path(database).is_absolute() or not Path(database).is_file():
        raise ValueError("Removal requires the app's existing absolute database path")
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        row = connection.execute(
            'SELECT l.marketplace,l.externalListingId,l.status,l.attemptCount,i.status '
            'FROM MarketplaceListing l JOIN Item i ON i.id=l.itemId WHERE l.id=?', (listing_row_id,),
        ).fetchone()
    if not row or row != (marketplace, external_id, "delisting", attempt, "Sold"):
        raise ValueError("Removal is no longer authorized for this exact item, listing and attempt")
