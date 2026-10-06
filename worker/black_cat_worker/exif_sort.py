"""EXIF reading + chronological sort.

Sort order (per spec): EXIF DateTimeOriginal -> EXIF SubSecTimeOriginal ->
natural filename -> filesystem mtime (last resort).  Never creation date alone.
Pillow is imported lazily so pure-logic tests run without it.
"""
from __future__ import annotations

import os
import re
from typing import List, Optional, Tuple

# EXIF tag IDs (avoid importing PIL.ExifTags at module load).
_TAG_DATETIME_ORIGINAL = 36867   # DateTimeOriginal
_TAG_SUBSEC_ORIGINAL = 37521     # SubSecTimeOriginal


def get_exif(path: str) -> Tuple[Optional[str], Optional[str], Optional[int], Optional[int]]:
    """Return (DateTimeOriginal, SubSecTimeOriginal, width, height).

    Any field may be None if Pillow is missing or the tag is absent.
    """
    try:
        from PIL import Image  # lazy
    except Exception:
        return (None, None, None, None)
    try:
        with Image.open(path) as img:
            width, height = img.size
            dto = subsec = None
            exif = img.getexif()
            if exif:
                dto = exif.get(_TAG_DATETIME_ORIGINAL)
                # SubSec lives in the Exif IFD on most cameras.
                try:
                    sub_ifd = exif.get_ifd(0x8769)  # ExifOffset
                    subsec = sub_ifd.get(_TAG_SUBSEC_ORIGINAL)
                    if dto is None:
                        dto = sub_ifd.get(_TAG_DATETIME_ORIGINAL)
                except Exception:
                    pass
            return (
                str(dto) if dto else None,
                str(subsec) if subsec is not None else None,
                width,
                height,
            )
    except Exception:
        return (None, None, None, None)


_NATURAL_RE = re.compile(r"(\d+)")
_DTO_RE = re.compile(r"^(\d{4})\D(\d{2})\D(\d{2})\D(\d{2})\D(\d{2})\D(\d{2})")


def natural_key(name: str):
    """Natural sort key so IMG_2, IMG_10 order correctly."""
    return [
        int(part) if part.isdigit() else part.lower()
        for part in _NATURAL_RE.split(name)
    ]


def parse_exif_ts(dto: Optional[str], subsec: Optional[str]) -> Optional[float]:
    """EXIF 'YYYY:MM:DD HH:MM:SS' (+SubSec fraction) -> epoch-ish seconds.

    Uses calendar.timegm on the raw fields (no TZ guessing) — only *relative*
    gaps between photos of one batch matter, so any consistent epoch works.
    """
    if not dto:
        return None
    m = _DTO_RE.match(str(dto).strip())
    if not m:
        return None
    try:
        import calendar
        y, mo, d, h, mi, s = (int(x) for x in m.groups())
        base = float(calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0)))
    except Exception:
        return None
    frac = 0.0
    if subsec:
        digits = re.sub(r"\D", "", str(subsec))
        if digits:
            frac = float(f"0.{digits}")
    return base + frac


def order_photos(photos: List) -> str:
    """Chronologically order photos IN PLACE; returns the order source used.

    - "exif":           every photo had a parseable EXIF time (subsec + natural
                        filename break ties).
    - "filename-mixed": SOME photos lacked EXIF. The old behavior sorted those
                        to the FRONT of the whole batch (empty string sorts
                        first), tearing them out of their real position and
                        merging items. Filename order (camera counters are
                        monotonic) keeps every photo in its true slot, so the
                        whole batch falls back to it.
    - "filename":       no EXIF at all (e.g. photos passed through a stripper).

    Each photo's .ts is populated from EXIF where available either way.
    """
    for p in photos:
        p.ts = parse_exif_ts(p.exif_dto, p.exif_subsec)
    with_ts = sum(1 for p in photos if p.ts is not None)
    if photos and with_ts == len(photos):
        photos.sort(key=lambda p: (p.ts, natural_key(p.filename), _safe_mtime(p.path)))
        return "exif"
    photos.sort(key=lambda p: (natural_key(p.filename), _safe_mtime(p.path)))
    return "filename" if with_ts == 0 else "filename-mixed"


def sort_decoded(photos: List) -> None:
    """Legacy shim — order_photos() is the real API (returns the order source)."""
    order_photos(photos)


def _safe_mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0
