"""Re-apply the studio-prop scrub to items imported before it existed.

Usage:  python -m black_cat_worker.scrub_props            dry run: prints what would change
        python -m black_cat_worker.scrub_props --apply    backs the database up, then writes

Intake now drops the ruler's print before anything is stored (see props.py), but
the rows it had already reached keep what was stored: "Model 403" in the model
column, "Empire" as the brand, the ruler written into the description. Clearing
a column in Review is not enough on its own, because the listing preview falls
back to aiRaw for any column that is empty, and aiRaw carries the same values.
This applies the exact functions intake runs to the stored columns AND to aiRaw,
rebuilds the tag reading and the evidence record from the cleaned answer, and
touches nothing else. A row that never mentioned a prop is left alone.

--apply first writes a VACUUM INTO snapshot to the app's backups folder (or
--backup-dir), the same consistent copy the app itself takes, so the change can
be undone by copying that file back over the database.
"""
from __future__ import annotations

import datetime
import json
import os
import sqlite3
import sys
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from . import config, evidence, props, tag_ocr, vision
from .ocr_engine import OcrLine

# What intake stores when no brand was read; the app treats it as "not set".
UNKNOWN_BRAND = "Unknown"
# A size is only ever cleared on an item that has not shipped. On a live or sold
# listing the size is what the buyer saw, right or wrong, and the record keeps it.
_UNSHIPPED = ("Photographed", "Ready for Nifty")
_SHOWN = ("brand", "model", "styleNumber", "description", "graphics", "keyDetails",
          "publicNotes", "customTitle", "aiFields")


def _loads(value: Any) -> Any:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


def _split_column(value: Any) -> List[str]:
    return [part.strip() for part in str(value or "").split("\n") if part.strip()]


def _join_column(values: Sequence[str]) -> Optional[str]:
    return "\n".join(values) if values else None


def scrub_raw(raw: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Set[str]]:
    """Scrub a stored aiRaw in place the way intake now would.

    Returns (the rebuilt evidence record, the ruler photo's numbers), or (None,
    empty) when neither the answer nor the OCR lines ever mentioned a prop - a
    clean row is not rewritten at all, since re-interpreting stored lines (which
    carry no boxes) could reorder candidates.
    """
    ocr = raw.get("ocr") if isinstance(raw.get("ocr"), dict) else None
    lines = [
        OcrLine(str(line.get("text") or ""), line.get("confidence"), None, line.get("photo"))
        for line in (ocr or {}).get("lines", []) if isinstance(line, dict)
    ]
    is_prop = lambda line: props.is_prop_line(tag_ocr.normalize_text(line.text))  # noqa: E731
    ignored = [t for t in (ocr or {}).get("propsIgnored", []) if isinstance(t, str)]
    photos_read = [p for p in (ocr or {}).get("photosRead", []) if isinstance(p, str)]
    if not any(map(is_prop, lines)) and any(map(props.is_prop_line, ignored)) \
            and len(photos_read) == 1:
        # The first version of this tool kept only the surviving lines in the record,
        # so on a row it already rewrote the ruler's lines and their photo are gone.
        # When a single photo was read, every line - the ruler included - was on it,
        # so the dropped print goes back on that photo and the pass below sees it.
        lines += [OcrLine(text, None, None, photos_read[0]) for text in ignored]
    scrubbed = props.scrub_vision(raw)
    # A registration number (RN, CA, WPL) stored as the model or style number goes
    # here, before the evidence is rebuilt, so no record keeps claiming it.
    registrations = [key for key in ("model", "styleNumber") if tag_ocr.is_registration_number(raw.get(key))]
    for key in registrations:
        raw[key] = None
    # Anything the reading would drop - the ruler's print, a measuring tool's bare
    # graduations - is reason enough to rewrite the record; a clean row is not.
    reading = tag_ocr.interpret(lines) if lines else None
    if not scrubbed and not registrations and not (reading is not None and reading.props_ignored):
        return None, set()
    ruler_numbers: Set[str] = set()
    if reading is not None and ocr is not None:
        payload = reading.to_json()
        payload["photosRead"] = ocr.get("photosRead", [])
        payload["unavailable"] = ocr.get("unavailable")
        raw["ocr"] = payload
        ruler_numbers = props.prop_numbers(reading)
        # Model and style number only: whether a stored size goes is plan_row's call,
        # because it depends on whether the operator has confirmed it.
        crossed = props.cross_check(raw, reading, keys=("model", "styleNumber"))
        scrubbed += [key for key in crossed if key not in scrubbed]
    # The same steps managed_vision runs after parsing: map, then reconcile with the tags.
    fields, _ = vision.VisionEnricher({"visionEnabled": True})._map_fields(dict(raw))
    record, derived = evidence.build_evidence(raw, fields, reading)
    for key, value in derived.items():
        if not raw.get(key):
            raw[key] = value
    raw["evidence"] = record
    if scrubbed:
        raw["propsScrubbed"] = scrubbed
    return record, ruler_numbers


def plan_row(row: Mapping[str, Any]) -> Dict[str, Any]:
    """Column -> new value for one Item row. Empty when the row is clean."""
    changes: Dict[str, Any] = {}
    if props.is_prop_brand(row.get("brand")):
        changes["brand"] = UNKNOWN_BRAND
    for key in ("model", "styleNumber"):
        if props.is_prop_code(row.get(key)):
            changes[key] = None
    if props.mentions_prop(row.get("description")):
        changes["description"] = props.scrub_text(str(row["description"])) or None
    for key in ("graphics", "keyDetails"):
        before = _split_column(row.get(key))
        after = [str(value) for value in props.scrub_list(before)]
        if after != before:
            changes[key] = _join_column(after)
    # The export writes the generated title back as the public-notes line, so the
    # ruler survived there even after the fields it came from were cleared.
    for key in ("publicNotes", "customTitle"):
        value = row.get(key)
        if isinstance(value, str) and props.has_prop_token(value):
            changes[key] = props.scrub_title(value) or None
    ai_fields = _loads(row.get("aiFields"))
    if "brand" in changes and isinstance(ai_fields, list) and "brand" in ai_fields:
        kept = [name for name in ai_fields if name != "brand"]
        changes["aiFields"] = json.dumps(kept) if kept else None
    # A registration number off the label (RN, CA, WPL) stored as the model or style
    # number: the same kind of misread, and the title would put it after the brand.
    for key in ("model", "styleNumber"):
        if tag_ocr.is_registration_number(row.get(key)):
            changes[key] = None
    raw = _loads(row.get("aiRaw"))
    if isinstance(raw, dict):
        before = json.dumps(raw, ensure_ascii=False)
        record, ruler_numbers = scrub_raw(raw)
        # A column holding one of the ruler photo's numbers came from the same read.
        for key in ("model", "styleNumber"):
            value = row.get(key)
            if isinstance(value, str) and value.strip() in ruler_numbers:
                changes[key] = None
        # A size that is one of those numbers and still unconfirmed (the operator has
        # not touched it) is the tape, not the tag: cleared, so Review asks for it. A
        # size the operator confirmed is left alone; the evidence flags it instead.
        size = row.get("size")
        current_ai = _loads(changes["aiFields"]) if "aiFields" in changes else ai_fields
        if (isinstance(size, str) and size.strip() in ruler_numbers
                and row.get("status") in _UNSHIPPED
                and isinstance(current_ai, list) and "size" in current_ai):
            changes["size"] = None
            kept = [name for name in current_ai if name != "size"]
            changes["aiFields"] = json.dumps(kept) if kept else None
            raw["size"] = None
            if record is not None:
                record.pop("size", None)
        after = json.dumps(raw, ensure_ascii=False)
        # A row that carries the ruler's lines on record is re-interpreted on every
        # run; it is only a change when something actually came out different.
        if after != before:
            changes["aiRaw"] = after
            if record is not None:
                changes["evidenceJson"] = json.dumps(record, ensure_ascii=False)
    return changes


def _backup(conn: sqlite3.Connection, folder: Optional[str]) -> str:
    if not folder:
        settings = config.load_settings(conn)
        folder = settings.get("backupsPath") or os.path.join(
            os.path.dirname(config.db_path()), "backups")
    os.makedirs(folder, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%S-") + "%03dZ" % (now.microsecond // 1000)
    dest = os.path.join(folder, "black-cat-%s.db" % stamp)
    conn.execute("VACUUM INTO ?", (dest,))
    return dest


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    apply = "--apply" in args
    backup_dir = None
    if "--backup-dir" in args:
        backup_dir = args[args.index("--backup-dir") + 1]
    path = config.db_path()
    if not os.path.exists(path):
        print("no database at %s" % path)
        return 2
    conn = sqlite3.connect(path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000;")
    plans: List[Tuple[int, str, Dict[str, Any]]] = []
    for row in conn.execute("SELECT * FROM Item ORDER BY id"):
        changes = plan_row(dict(row))
        if changes:
            plans.append((int(row["id"]), str(row["sku"]), changes))
    for item_id, sku, changes in plans:
        print("%s (id %d): %s" % (sku, item_id, ", ".join(sorted(changes))))
        for key in _SHOWN:
            if key in changes:
                print("    %s -> %r" % (key, changes[key]))
    if not plans:
        print("no item mentions a prop; nothing to do")
        return 0
    if not apply:
        print("\nDRY RUN: %d item(s) would change. Re-run with --apply to write them." % len(plans))
        return 0
    print("backup: %s" % _backup(conn, backup_dir))
    with conn:
        for item_id, _sku, changes in plans:
            columns = ", ".join("%s = ?" % key for key in changes)
            conn.execute("UPDATE Item SET %s WHERE id = ?" % columns, [*changes.values(), item_id])
    print("updated %d item(s)" % len(plans))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
