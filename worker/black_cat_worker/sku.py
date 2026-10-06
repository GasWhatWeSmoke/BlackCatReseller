"""SKU normalization + OCR format-correction.

Decoded sticker values look like: "000001", "BC-000001", "SKU: 000001",
"SKU: BC-000001".  All normalize to a zero-padded N-digit string ("000001").

The app READS SKUs only (an external label printer owns numbering), so this
module never issues numbers — it only parses/repairs what the camera saw.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

# Common OCR confusions for the *numeric* region of a label (letter -> digit).
_OCR_CONFUSION = {
    "O": "0", "Q": "0", "D": "0",
    "I": "1", "L": "1", "|": "1",
    "Z": "2",
    "S": "5",
    "G": "6",
    "B": "8",
    "A": "4",
}


def _strip_prefixes(text: str, prefixes: Iterable[str]) -> str:
    t = text.strip()
    # Strip a leading "SKU:" (any case / spacing) first.
    t = re.sub(r"^\s*sku\s*:?\s*", "", t, flags=re.IGNORECASE)
    for p in prefixes:
        if p and t.upper().startswith(p.upper()):
            t = t[len(p):]
            break
    return t.strip()


def normalize(
    raw: Optional[str],
    prefixes: Iterable[str] = ("BC-",),
    length: int = 6,
) -> Optional[str]:
    """Strict normalization of a CLEAN decoded value (QR path).

    Returns the zero-padded numeric SKU, or None if it isn't a valid SKU.
    Leading zeros are preserved.
    """
    if not raw:
        return None
    body = _strip_prefixes(str(raw), prefixes)
    m = re.fullmatch(r"(\d{%d})" % length, body)
    if m:
        return m.group(1)
    # Tolerate a value that is purely digits of the right length even with stray
    # separators removed (e.g. "00 00 01").
    digits = re.sub(r"\D", "", body)
    if len(digits) == length:
        return digits
    return None


def coerce_to_sku(
    text: Optional[str],
    prefixes: Iterable[str] = ("BC-",),
    length: int = 6,
) -> Optional[str]:
    """Lenient format-correction for the OCR-fallback path.

    Applies an allowlist + the OCR confusion map, then tries to extract exactly
    `length` digits.  This (not the OCR engine choice) is the dominant accuracy
    lever for fixed-format labels.  Returns a normalized SKU or None.
    """
    if not text:
        return None
    t = _strip_prefixes(str(text).upper(), prefixes)
    # NOISE GATE: real sticker text is digits plus at most a stray confusable
    # letter; garment prints ("SAW CLOTHING", "IF FO FOTOADUE") are mostly
    # letters OUTSIDE the confusion map. Without this gate such prints coerced
    # into plausible-looking SKUs (the 100040/541016 incidents) and spawned
    # phantom items. More than one non-digit, non-confusable, non-separator
    # character -> this is not a SKU.
    noise = sum(
        1 for ch in t
        if not (ch.isdigit() or ch in _OCR_CONFUSION or ch in " -_.:/#\t")
    )
    if noise > 1:
        return None
    # Map confusable letters to digits, drop everything else.
    mapped = "".join(_OCR_CONFUSION.get(ch, ch) for ch in t)
    mapped = re.sub(r"[^0-9]", "", mapped)
    if len(mapped) == length:
        return mapped
    # If we over-captured (e.g. a stray digit), prefer the last `length` run.
    if len(mapped) > length:
        return mapped[-length:]
    return None


def levenshtein(a: str, b: str) -> int:
    """Plain Levenshtein edit distance (used for nearest-valid-SKU ranking)."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def is_valid_sku(sku: Optional[str], length: int = 6) -> bool:
    return bool(sku) and bool(re.fullmatch(r"\d{%d}" % length, sku))
