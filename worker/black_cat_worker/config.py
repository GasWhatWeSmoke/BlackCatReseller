"""Configuration resolution for the worker.

Settings come from the DB (AppSettings row, written by the Next.js side); if the
DB isn't reachable yet, sensible defaults are derived from env + project layout.
Non-path defaults are loaded from config/defaults.json — the SINGLE source shared
with src/lib/settings.ts and scripts/init-db.mjs (§28), so they can't drift.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Optional

from . import db as dbmod

# black_cat_worker/config.py -> worker -> BlackCatAgent
PROJECT_ROOT = Path(__file__).resolve().parents[2]
# Single source of truth for the non-path defaults, shared with src/lib/settings.ts and
# scripts/init-db.mjs (§28). Env-derived paths are still computed below, per-runtime.
DEFAULTS_JSON = PROJECT_ROOT / "config" / "defaults.json"

_MANAGED_VISION_SETTING_KEYS = frozenset({
    "visionEnabled",
    "visionMaxPhotos",
    "visionFields",
    "visionTimeoutSeconds",
    "visionMaxTokens",
})
_MAX_VISION_PHOTOS = 4
_MAX_VISION_OUTPUT_TOKENS = 1800


_RETIRED_APP_SETTINGS = frozenset(['marketEnabled', 'marketAutoRefreshEnabled', 'marketRefreshIntervalHours', 'niftyUploadUrl', 'niftySelectors', 'draftMode', 'autoMode', 'depopBoost', 'niftyInventoryUrl', 'syncEnabled', 'syncIntervalHours'])


def _strip_retired_vision_settings(data: object) -> Dict:
    """Drop every legacy vision transport/lifecycle control in memory."""
    if not isinstance(data, dict):
        return {}
    return {
        key: value for key, value in data.items()
        if key not in _RETIRED_APP_SETTINGS and not (
            isinstance(key, str)
            and key.startswith("vision")
            and key not in _MANAGED_VISION_SETTING_KEYS
        )
    }


def _normalize_managed_vision_settings(data: object) -> Dict:
    """Normalize stale allowed keys onto the same bounds as the Settings API."""
    cleaned = _strip_retired_vision_settings(data)
    defaults = {
        "visionEnabled": False,
        "visionMaxPhotos": 4,
        "visionFields": ["size", "color", "pattern", "itemType", "brand"],
        "visionTimeoutSeconds": 120,
        "visionMaxTokens": 1800,
    }
    result = dict(cleaned)
    if type(result.get("visionEnabled")) is not bool:
        result["visionEnabled"] = defaults["visionEnabled"]

    def bounded_integer(key: str, minimum: int, maximum: int) -> None:
        value = result.get(key)
        if type(value) is not int or not minimum <= value <= maximum:
            result[key] = defaults[key]

    bounded_integer("visionMaxPhotos", 1, _MAX_VISION_PHOTOS)
    bounded_integer("visionTimeoutSeconds", 10, 900)
    bounded_integer("visionMaxTokens", 128, _MAX_VISION_OUTPUT_TOKENS)
    fields = result.get("visionFields")
    supported = {"size", "color", "pattern", "itemType", "brand"}
    if not (
        isinstance(fields, list) and fields
        and all(isinstance(field, str) and field in supported for field in fields)
        and len(set(fields)) == len(fields)
    ):
        result["visionFields"] = list(defaults["visionFields"])
    return result


def db_path() -> str:
    return os.environ.get("BLACKCAT_DB_PATH") or str(PROJECT_ROOT / "data" / "black-cat.db")


def _static_defaults() -> Dict:
    """The shared non-path defaults from config/defaults.json. Empty on failure — the DB
    settings row (seeded from the same file) then fills these in via load_settings()."""
    try:
        with open(DEFAULTS_JSON, "r", encoding="utf-8") as f:
            return json.load(f).get("defaults", {})
    except Exception as exc:  # missing/corrupt file shouldn't hard-crash the worker
        print(f"[config] WARN: could not read {DEFAULTS_JSON}: {exc}", flush=True)
        return {}


def default_settings() -> Dict:
    data_root = Path(os.environ.get("BLACKCAT_DATA_ROOT") or (PROJECT_ROOT / "var"))
    j = lambda *p: str(data_root.joinpath(*p))
    settings = {
        "dataRoot": str(data_root),
        "incomingPath": j("incoming"),
        "processingPath": j("processing"),
        "readyPath": j("ready"),
        "needsReviewPath": j("needs-review"),
        "archivePath": j("archive"),
        "exportsPath": j("exports"),
        "logsPath": j("logs"),
        "backupsPath": j("backups"),
        "pythonWorkerPath": str(PROJECT_ROOT / "worker" / ".venv" / "Scripts" / "python.exe"),
    }
    settings.update(_normalize_managed_vision_settings(_static_defaults()))
    return _normalize_managed_vision_settings(settings)


# Merge only bounded managed-vision behavior; retired transport/process keys
# remain inert even when an old database row still contains them.
def load_settings(conn: Optional[object] = None, *, require_database: bool = False) -> Dict:
    """Merge DB settings over defaults. Pass an open sqlite connection or None."""
    settings = default_settings()
    own_conn = False
    if conn is None:
        conn = dbmod.connect(db_path())
        own_conn = True
    try:
        if conn is None and require_database:
            raise dbmod.InventoryReadError("The inventory database is unavailable. Intake stopped before changing photos.")
        if conn is not None:
            data = dbmod.get_settings_data(conn, required=require_database)
            if data:
                settings.update(_normalize_managed_vision_settings(data))
    finally:
        if own_conn and conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return _normalize_managed_vision_settings(settings)


def ensure_dirs(settings: Dict) -> None:
    for key in (
        "incomingPath", "processingPath", "readyPath", "needsReviewPath",
        "archivePath", "exportsPath", "logsPath", "backupsPath",
    ):
        path = settings.get(key)
        if path:
            os.makedirs(path, exist_ok=True)
