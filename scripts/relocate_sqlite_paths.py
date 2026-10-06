"""Safely relocate Black Cat's persisted absolute paths after moving the repo.

The default mode is a read-only dry run. ``--apply`` acquires a write lock,
creates a consistent SQLite backup with the backup API, applies only the known
schema fields in one transaction, and verifies the result before committing.
"""

from __future__ import annotations

import argparse
import json
import ntpath
import os
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO_ROOT / "data" / "black-cat.db"


class RelocationError(RuntimeError):
    """The database cannot be relocated safely without operator action."""


@dataclass(frozen=True)
class ScalarPathField:
    table: str
    column: str
    active: bool
    expected_kind: str

    @property
    def key(self) -> str:
        return f"{self.table}.{self.column}"


SCALAR_PATH_FIELDS = (
    ScalarPathField("Item", "processingFolderPath", True, "directory"),
    ScalarPathField("Item", "readyFolderPath", True, "directory"),
    ScalarPathField("Photo", "storedPath", True, "file"),
    ScalarPathField("Photo", "thumbPath", True, "file"),
    # FileHash is the active deduplication ledger and must keep pointing at the
    # retained processed photo. ProblemLog alone is historical and may refer to
    # an incoming file that was intentionally removed after processing.
    ScalarPathField("FileHash", "processedPath", True, "file"),
    ScalarPathField("ProblemLog", "photoPath", False, "file"),
)

# Human-readable audit text is not an active path source, but retaining an old
# checkout root in these messages makes diagnostics misleading after a move.
HISTORICAL_TEXT_FIELDS = (("ProblemLog", "message"),)

SETTINGS_PATH_FIELDS = {
    "dataRoot": "directory",
    "incomingPath": "directory",
    "processingPath": "directory",
    "readyPath": "directory",
    "needsReviewPath": "directory",
    "archivePath": "directory",
    "exportsPath": "directory",
    "logsPath": "directory",
    "backupsPath": "directory",
    "pythonWorkerPath": "file",
}

COLLISION_PATH_FIELDS = {
    "processingFolderPath": "directory",
    "storedPath": "file",
    "thumbPath": "file",
    "photoPath": "file",
    "processedPath": "file",
    "readyFolderPath": "directory",
}
COLLISION_PATH_LIST_FIELDS = {"originalPaths": "file"}


@dataclass(frozen=True)
class RowChange:
    table: str
    column: str
    row_id: int
    before: str
    after: str


@dataclass
class RelocationPlan:
    changes: list[RowChange] = field(default_factory=list)
    references: Counter[str] = field(default_factory=Counter)
    field_changes: Counter[str] = field(default_factory=Counter)
    missing_active: list[str] = field(default_factory=list)
    missing_historical: list[str] = field(default_factory=list)
    unknown_active: list[str] = field(default_factory=list)
    row_counts: dict[str, int] = field(default_factory=dict)

    def validate(self) -> None:
        errors: list[str] = []
        if self.unknown_active:
            sample = "\n  ".join(self.unknown_active[:10])
            errors.append(
                "unknown active path prefix(es); every active path must be under "
                f"the declared old or current root:\n  {sample}"
            )
        if self.missing_active:
            sample = "\n  ".join(self.missing_active[:10])
            errors.append(f"mapped active target(s) do not exist or have the wrong type:\n  {sample}")
        if errors:
            raise RelocationError("\n".join(errors))


def _normalized_windows_path(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RelocationError("encountered an empty path value")
    normalized = ntpath.normpath(value.strip().replace("/", "\\"))
    if not ntpath.isabs(normalized):
        raise RelocationError(f"path is not absolute: {value!r}")
    return normalized


def _path_under(value: str, root: str) -> tuple[bool, str]:
    normalized = _normalized_windows_path(value)
    normalized_root = _normalized_windows_path(root).rstrip("\\")
    folded = ntpath.normcase(normalized)
    folded_root = ntpath.normcase(normalized_root)
    if folded == folded_root:
        return True, ""
    prefix = folded_root + "\\"
    if folded.startswith(prefix):
        return True, normalized[len(normalized_root) :].lstrip("\\")
    return False, ""


def rewrite_path(value: str, old_root: str, new_root: str) -> tuple[str, str]:
    """Return ``(value, state)`` where state is old/current/unknown.

    Comparison is Windows-case-insensitive and separator-insensitive. The output
    preserves a forward-slash-only source style so both historical storage styles
    remain readable and idempotent.
    """

    under_new, _ = _path_under(value, new_root)
    if under_new:
        return value, "current"

    under_old, tail = _path_under(value, old_root)
    if not under_old:
        return value, "unknown"

    separator = "/" if "/" in value and "\\" not in value else "\\"
    destination = _normalized_windows_path(new_root)
    if tail:
        destination = destination.rstrip("\\") + "\\" + tail
    if separator == "/":
        destination = destination.replace("\\", "/")
    return destination, "old"


def _target_exists(path_value: str, expected_kind: str) -> bool:
    if expected_kind == "file":
        return os.path.isfile(path_value)
    if expected_kind == "directory":
        return os.path.isdir(path_value)
    raise AssertionError(f"unsupported expected path kind: {expected_kind}")


def _record_path(
    plan: RelocationPlan,
    *,
    label: str,
    value: Any,
    old_root: str,
    new_root: str,
    active: bool,
    expected_kind: str,
) -> str:
    if not isinstance(value, str) or not value.strip():
        if active:
            plan.unknown_active.append(f"{label}: empty or non-string path")
        return value

    try:
        rewritten, state = rewrite_path(value, old_root, new_root)
    except RelocationError as exc:
        if active:
            plan.unknown_active.append(f"{label}: {exc}")
        else:
            plan.references["historical_malformed"] += 1
        return value

    plan.references[state if active else f"historical_{state}"] += 1
    if state == "unknown":
        if active:
            plan.unknown_active.append(f"{label}: {value}")
        return value

    if not _target_exists(rewritten, expected_kind):
        detail = f"{label}: {rewritten} (expected {expected_kind})"
        if active:
            plan.missing_active.append(detail)
        else:
            plan.missing_historical.append(detail)
    return rewritten


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info([{table}])")}


def _validate_schema(conn: sqlite3.Connection) -> None:
    required: dict[str, set[str]] = {
        "AppSettings": {"id", "data"},
        "Collision": {"id", "status", "incomingPhotosJson"},
    }
    for spec in SCALAR_PATH_FIELDS:
        required.setdefault(spec.table, {"id"}).add(spec.column)
    for table, column in HISTORICAL_TEXT_FIELDS:
        required.setdefault(table, {"id"}).add(column)

    missing: list[str] = []
    for table, columns in required.items():
        actual = _table_columns(conn, table)
        if not actual:
            missing.append(f"table {table}")
            continue
        for column in sorted(columns - actual):
            missing.append(f"column {table}.{column}")
    if missing:
        raise RelocationError("database schema is not supported; missing " + ", ".join(missing))


def _row_counts(conn: sqlite3.Connection) -> dict[str, int]:
    tables = [
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    return {
        table: int(
            conn.execute(
                f'SELECT count(*) FROM "{table.replace(chr(34), chr(34) * 2)}"'
            ).fetchone()[0]
        )
        for table in tables
    }


def _rewrite_collision_json(
    value: Any,
    *,
    label: str,
    old_root: str,
    new_root: str,
    active: bool,
    plan: RelocationPlan,
) -> Any:
    if isinstance(value, list):
        return [
            _rewrite_collision_json(
                child,
                label=f"{label}[{index}]",
                old_root=old_root,
                new_root=new_root,
                active=active,
                plan=plan,
            )
            for index, child in enumerate(value)
        ]
    if not isinstance(value, dict):
        return value

    result = dict(value)
    for key, child in value.items():
        child_label = f"{label}.{key}"
        if key in COLLISION_PATH_FIELDS and child is not None:
            result[key] = _record_path(
                plan,
                label=child_label,
                value=child,
                old_root=old_root,
                new_root=new_root,
                active=active,
                expected_kind=COLLISION_PATH_FIELDS[key],
            )
        elif key in COLLISION_PATH_LIST_FIELDS:
            if not isinstance(child, list):
                if active:
                    plan.unknown_active.append(f"{child_label}: expected a path list")
                continue
            result[key] = [
                _record_path(
                    plan,
                    label=f"{child_label}[{index}]",
                    value=entry,
                    old_root=old_root,
                    new_root=new_root,
                    active=active,
                    expected_kind=COLLISION_PATH_LIST_FIELDS[key],
                )
                for index, entry in enumerate(child)
            ]
        elif isinstance(child, (dict, list)):
            result[key] = _rewrite_collision_json(
                child,
                label=child_label,
                old_root=old_root,
                new_root=new_root,
                active=active,
                plan=plan,
            )
    return result


def build_plan(conn: sqlite3.Connection, old_root: str, new_root: str) -> RelocationPlan:
    old_root = _normalized_windows_path(old_root)
    new_root = _normalized_windows_path(new_root)
    if ntpath.normcase(old_root) == ntpath.normcase(new_root):
        raise RelocationError("old root and new root must be different")
    if not os.path.isdir(new_root):
        raise RelocationError(f"current repository root does not exist: {new_root}")

    _validate_schema(conn)
    plan = RelocationPlan(row_counts=_row_counts(conn))

    for spec in SCALAR_PATH_FIELDS:
        rows = conn.execute(
            f"SELECT id, [{spec.column}] FROM [{spec.table}] "
            f"WHERE [{spec.column}] IS NOT NULL AND trim(CAST([{spec.column}] AS TEXT)) <> ''"
        ).fetchall()
        for row_id, before in rows:
            after = _record_path(
                plan,
                label=f"{spec.key} id={row_id}",
                value=before,
                old_root=old_root,
                new_root=new_root,
                active=spec.active,
                expected_kind=spec.expected_kind,
            )
            if after != before:
                plan.changes.append(RowChange(spec.table, spec.column, int(row_id), before, after))
                plan.field_changes[spec.key] += 1

    old_backslash = _normalized_windows_path(old_root)
    new_backslash = _normalized_windows_path(new_root)
    text_replacements = (
        (old_backslash, new_backslash),
        (old_backslash.replace("\\", "/"), new_backslash.replace("\\", "/")),
    )
    for table, column in HISTORICAL_TEXT_FIELDS:
        rows = conn.execute(
            f"SELECT id, [{column}] FROM [{table}] "
            f"WHERE [{column}] IS NOT NULL AND trim(CAST([{column}] AS TEXT)) <> ''"
        ).fetchall()
        for row_id, before in rows:
            after = before
            replacements = 0
            for old_spelling, new_spelling in text_replacements:
                replacements += after.count(old_spelling)
                after = after.replace(old_spelling, new_spelling)
            if replacements:
                key = f"{table}.{column}"
                plan.references["historical_text_old"] += replacements
                plan.changes.append(RowChange(table, column, int(row_id), before, after))
                plan.field_changes[key] += 1

    settings_rows = conn.execute("SELECT id, data FROM AppSettings ORDER BY id").fetchall()
    if len(settings_rows) != 1 or int(settings_rows[0][0]) != 1:
        raise RelocationError("AppSettings must contain exactly the canonical id=1 row")
    settings_id, settings_raw = settings_rows[0]
    try:
        settings = json.loads(settings_raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RelocationError(f"AppSettings.data is not valid JSON: {exc}") from exc
    if not isinstance(settings, dict):
        raise RelocationError("AppSettings.data must be a JSON object")

    updated_settings = dict(settings)
    for key, expected_kind in SETTINGS_PATH_FIELDS.items():
        if key not in settings:
            plan.unknown_active.append(f"AppSettings.data.{key}: missing required path")
            continue
        updated_settings[key] = _record_path(
            plan,
            label=f"AppSettings.data.{key}",
            value=settings[key],
            old_root=old_root,
            new_root=new_root,
            active=True,
            expected_kind=expected_kind,
        )
    if updated_settings != settings:
        settings_after = json.dumps(updated_settings, ensure_ascii=False, separators=(",", ":"))
        plan.changes.append(RowChange("AppSettings", "data", int(settings_id), settings_raw, settings_after))
        plan.field_changes["AppSettings.data"] += 1

    collision_rows = conn.execute(
        "SELECT id, status, incomingPhotosJson FROM Collision ORDER BY id"
    ).fetchall()
    for row_id, status, raw in collision_rows:
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise RelocationError(
                f"Collision.incomingPhotosJson id={row_id} is not valid JSON: {exc}"
            ) from exc
        if not isinstance(payload, list):
            raise RelocationError(f"Collision.incomingPhotosJson id={row_id} must be a JSON list")
        active = str(status).lower() == "pending"
        updated_payload = _rewrite_collision_json(
            payload,
            label=f"Collision.incomingPhotosJson id={row_id}",
            old_root=old_root,
            new_root=new_root,
            active=active,
            plan=plan,
        )
        if updated_payload != payload:
            after = json.dumps(updated_payload, ensure_ascii=False, separators=(",", ":"))
            plan.changes.append(RowChange("Collision", "incomingPhotosJson", int(row_id), raw, after))
            plan.field_changes["Collision.incomingPhotosJson"] += 1

    plan.validate()
    return plan


def create_sqlite_backup(
    source: sqlite3.Connection,
    destination: Path,
    expected_counts: dict[str, int],
) -> Path:
    """Create and validate a consistent backup using SQLite's online backup API."""

    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RelocationError(f"backup destination already exists: {destination}")

    target: sqlite3.Connection | None = None
    try:
        target = sqlite3.connect(destination)
        source.backup(target)
        target.close()
        target = None

        verify = sqlite3.connect(destination.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            quick_check = verify.execute("PRAGMA quick_check").fetchone()[0]
            if quick_check != "ok":
                raise RelocationError(f"backup quick_check failed: {quick_check}")
            if _row_counts(verify) != expected_counts:
                raise RelocationError("backup row counts do not match the source database")
        finally:
            verify.close()
    except Exception:
        if target is not None:
            target.close()
        if destination.exists():
            destination.unlink()
        raise
    return destination


def _default_backup_path(db_path: Path, new_root: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return Path(new_root) / "var" / "backups" / f"{db_path.stem}-pre-relocation-{stamp}.db"


def _apply_changes(conn: sqlite3.Connection, plan: RelocationPlan) -> None:
    for change in plan.changes:
        cursor = conn.execute(
            f"UPDATE [{change.table}] SET [{change.column}] = ? "
            f"WHERE id = ? AND [{change.column}] = ?",
            (change.after, change.row_id, change.before),
        )
        if cursor.rowcount != 1:
            raise RelocationError(
                f"optimistic update failed for {change.table}.{change.column} id={change.row_id}"
            )


def apply_relocation(
    db_path: Path,
    old_root: str,
    new_root: str,
    backup_path: Path | None = None,
) -> tuple[RelocationPlan, Path | None]:
    db_path = db_path.resolve()
    if not db_path.is_file():
        raise RelocationError(f"database does not exist: {db_path}")

    conn = sqlite3.connect(db_path, timeout=5.0, isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    backup: Path | None = None
    try:
        conn.execute("BEGIN IMMEDIATE")
        plan = build_plan(conn, old_root, new_root)
        if not plan.changes:
            conn.rollback()
            return plan, None

        backup = backup_path or _default_backup_path(db_path, new_root)
        # Back up through a separate read connection while this connection's
        # BEGIN IMMEDIATE prevents another writer from racing the snapshot.
        # Calling backup() on the transaction-owning connection can self-block.
        backup_source = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
        try:
            create_sqlite_backup(backup_source, backup, plan.row_counts)
        finally:
            backup_source.close()
        _apply_changes(conn, plan)

        if _row_counts(conn) != plan.row_counts:
            raise RelocationError("table row counts changed during path relocation")
        post_plan = build_plan(conn, old_root, new_root)
        if post_plan.changes:
            raise RelocationError(
                f"post-update verification still found {len(post_plan.changes)} change(s)"
            )
        quick_check = conn.execute("PRAGMA quick_check").fetchone()[0]
        if quick_check != "ok":
            raise RelocationError(f"database quick_check failed before commit: {quick_check}")
        conn.commit()
        return plan, backup
    except Exception:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.close()


def dry_run(db_path: Path, old_root: str, new_root: str) -> RelocationPlan:
    db_path = db_path.resolve()
    if not db_path.is_file():
        raise RelocationError(f"database does not exist: {db_path}")
    conn = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    try:
        quick_check = conn.execute("PRAGMA quick_check").fetchone()[0]
        if quick_check != "ok":
            raise RelocationError(f"database quick_check failed: {quick_check}")
        return build_plan(conn, old_root, new_root)
    finally:
        conn.close()


def _print_summary(
    plan: RelocationPlan,
    *,
    db_path: Path,
    old_root: str,
    new_root: str,
    applied: bool,
    backup: Path | None = None,
) -> None:
    print(f"mode: {'applied' if applied else 'dry-run (no database changes)'}")
    print(f"database: {db_path.resolve()}")
    print(f"old root: {old_root}")
    print(f"new root: {new_root}")
    print(f"SQL rows to update: {len(plan.changes)}")
    for key, count in sorted(plan.field_changes.items()):
        print(f"  {key}: {count}")
    print("path references:")
    for key, count in sorted(plan.references.items()):
        print(f"  {key}: {count}")
    if plan.missing_historical:
        print(f"historical targets missing (allowed): {len(plan.missing_historical)}")
    if backup:
        print(f"backup: {backup.resolve()}")
    if not applied:
        print("rerun with --apply to create a backup and commit this exact relocation")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path")
    parser.add_argument("--old-root", required=True, help="repository root stored on the old PC")
    parser.add_argument(
        "--new-root",
        default=str(REPO_ROOT),
        help="current repository root (defaults to this checkout)",
    )
    parser.add_argument(
        "--backup",
        type=Path,
        help="exact backup destination (default: <new-root>/var/backups)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="create a verified backup and apply in one transaction",
    )
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.apply:
            plan, backup = apply_relocation(
                args.db, args.old_root, args.new_root, args.backup
            )
            _print_summary(
                plan,
                db_path=args.db,
                old_root=args.old_root,
                new_root=args.new_root,
                applied=True,
                backup=backup,
            )
        else:
            plan = dry_run(args.db, args.old_root, args.new_root)
            _print_summary(
                plan,
                db_path=args.db,
                old_root=args.old_root,
                new_root=args.new_root,
                applied=False,
            )
        return 0
    except (RelocationError, sqlite3.Error, OSError) as exc:
        print(f"relocation aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
