"""Seed the isolated E2E stack's AppSettings row.

config/template.db ships with no AppSettings row, so getSettings() would fall
back to defaults — which have vision off, while the mixed-batch suite asserts
that AI ran for every item. Stored settings are merged OVER the defaults
(src/lib/settings.ts), so writing the one key that differs is enough and keeps
the environment-derived paths computed at runtime.

Usage: python seed_settings.py <db-path> [key=value ...]   (values are JSON)
"""
from __future__ import annotations

import json
import sqlite3
import sys


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: seed_settings.py <db-path> [key=json-value ...]", file=sys.stderr)
        return 2
    db_path, pairs = argv[0], argv[1:]
    data = {"visionEnabled": True}
    for pair in pairs:
        key, _, raw = pair.partition("=")
        try:
            data[key] = json.loads(raw)
        except json.JSONDecodeError:
            data[key] = raw
    db = sqlite3.connect(db_path)
    try:
        db.execute(
            "insert or replace into AppSettings (id, data, updatedAt) values (1, ?, 0)",
            (json.dumps(data),),
        )
        db.commit()
    finally:
        db.close()
    print(f"seeded AppSettings: {json.dumps(data)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
