"""Validate one localized Black Cat inventory candidate; never issue or guess SKUs."""
from __future__ import annotations

import re
from typing import Iterable, Optional

_DASHES = str.maketrans({c: "-" for c in "‐‑‒–—−﹘﹣－"})
_EXACT = re.compile(r"BC-[0-9]{6}\Z")


def normalize(raw: Optional[str], prefixes: Iterable[str] = ("BC-",), length: int = 6) -> Optional[str]:
    """Conservative whitespace/case/dash normalization of a complete region.

    Historical settings do not relax the Black Cat BC-###### boundary format.
    Bare numbers, SKU wrappers, partial/longer identifiers and character guesses
    are rejected. Existing database identities are not rewritten by this parser.
    """
    if not isinstance(raw, str):
        return None
    candidate = re.sub(r"\s+", "", raw.translate(_DASHES)).upper()
    return candidate if _EXACT.fullmatch(candidate) else None


def coerce_to_sku(text: Optional[str], prefixes: Iterable[str] = ("BC-",), length: int = 6) -> Optional[str]:
    """Compatibility entrypoint; uncertain OCR characters now require review."""
    return normalize(text, prefixes, length)


def is_valid_sku(sku: Optional[str], length: int = 6) -> bool:
    return isinstance(sku, str) and bool(_EXACT.fullmatch(sku))


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]
