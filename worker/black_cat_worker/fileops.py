"""File operations: copy-forward into /processing, archive pristine originals.

Nothing is ever permanently deleted: working copies go to /processing, originals
are MOVED to /archive after a successful pass.
"""
from __future__ import annotations

import os
import shutil
from typing import List


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def clean_photo_name(sku: str, index: int, src: str) -> str:
    ext = os.path.splitext(src)[1].lower() or ".jpg"
    return f"{sku}_{index:02d}{ext}"


def copy_into(src: str, dst: str) -> str:
    """Copy src -> dst (creating parents). Returns dst."""
    ensure_dir(os.path.dirname(dst))
    shutil.copy2(src, dst)
    return dst


def move_into(src: str, dst_dir: str) -> str:
    """Move src into dst_dir (creating it). Returns the new path.

    If a name collision occurs, a numeric suffix is added (never overwrite).
    """
    ensure_dir(dst_dir)
    base = os.path.basename(src)
    dst = os.path.join(dst_dir, base)
    if os.path.exists(dst):
        stem, ext = os.path.splitext(base)
        n = 1
        while os.path.exists(dst):
            dst = os.path.join(dst_dir, f"{stem}__{n}{ext}")
            n += 1
    shutil.move(src, dst)
    return dst


def is_stable(path: str, min_age_seconds: float, now: float) -> bool:
    """True if the file hasn't been modified within the stability window."""
    try:
        return (now - os.path.getmtime(path)) >= min_age_seconds
    except OSError:
        return False
