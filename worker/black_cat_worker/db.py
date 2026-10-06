"""Read-only SQLite access for the worker.

The worker reads settings + existing hashes/SKUs to make decisions, but it does
NOT write Item/Photo/Batch rows — it returns a structured result that Next.js
persists via Prisma (single writer for app data; avoids cross-encoding of
DateTime columns).  Reading only string columns here is safe regardless of how
Prisma encodes dates.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Optional, Set


class InventoryReadError(RuntimeError):
    """An unavailable inventory must never be interpreted as empty stock."""


def connect(db_path: str) -> Optional[sqlite3.Connection]:
    conn = None
    try:
        # The Python worker is a reader. A normal sqlite3.connect silently
        # creates a missing database, which would mutate disk before managed
        # vision admission. URI mode=ro makes a missing or inaccessible DB a
        # clean default-settings fallback instead.
        uri = Path(db_path).resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, timeout=5.0, uri=True)
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn
    except Exception:
        if conn is not None:
            conn.close()
        return None


def get_settings_data(conn: sqlite3.Connection, *, required: bool = False) -> Optional[dict]:
    try:
        row = conn.execute('SELECT "data" FROM "AppSettings" WHERE "id"=1').fetchone()
        if row and row[0]:
            data = json.loads(row[0])
            if isinstance(data, dict):
                return data
    except Exception as error:
        if required:
            raise InventoryReadError("Saved settings could not be read; intake cannot choose safe photo folders.") from error
        return None
    if required:
        raise InventoryReadError("Saved settings are missing or invalid; intake cannot choose safe photo folders.")
    return None


def existing_hashes(conn: sqlite3.Connection) -> Set[str]:
    try:
        rows = conn.execute('SELECT "sha256" FROM "FileHash"').fetchall()
        return {r[0] for r in rows if r and r[0]}
    except Exception as error:
        raise InventoryReadError("Stored photo identities could not be read. Intake stopped before changing photos.") from error


def existing_skus(conn: sqlite3.Connection) -> Set[str]:
    try:
        rows = conn.execute('SELECT "sku" FROM "Item"').fetchall()
        return {r[0] for r in rows if r and r[0]}
    except Exception as error:
        raise InventoryReadError("Inventory SKUs could not be read. Intake stopped before changing photos.") from error
