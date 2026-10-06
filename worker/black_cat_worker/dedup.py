"""Exact-file duplicate detection via SHA-256 of the file bytes.

Exact-file semantics: a re-dropped identical file is skipped; legitimate
re-shoots (different bytes) are kept.
"""
from __future__ import annotations

import hashlib
from typing import Callable, Optional


def sha256_of_file(
    path: str,
    chunk_size: int = 1 << 20,
    *,
    cancel_check: Optional[Callable[[], None]] = None,
) -> str:
    """Hash one file while keeping cooperative cancellation observable."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            if cancel_check is not None:
                cancel_check()
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
            if cancel_check is not None:
                cancel_check()
    return h.hexdigest()
