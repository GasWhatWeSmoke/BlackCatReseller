"""Canonical spellings for brands and attributes (worker side).

Reads the SAME config/normalization.json that src/lib/normalize.ts reads, for
the same reason config/defaults.json is shared: two hand-maintained copies of a
brand list would drift within a week.

The policy is deliberately conservative and is the whole point of the module:

  * An exact alias match is applied. "quicksilver" becomes "Quiksilver".
  * A near miss is only SUGGESTED, never applied. OCR read "QLIKSILVER" and
    "QUIKSILVAR" off two real tags; those are worth flagging for review, and
    silently rewriting them is how an item ends up confidently mislabelled.
  * An unrecognized value is returned untouched. On a graphic tee the brand
    field legitimately holds "Megadeth" or "Saint Pablo Tour Merch", and a
    dictionary that has never heard of those must not damage them.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

_TABLE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "config", "normalization.json",
)

_FIELD_SECTIONS = {
    "brand": "brands",
    "material": "materials",
    "color": "colors",
    "fit": "fits",
}

# Below five characters an edit distance of two is most of the word, which would
# turn "Vans" into "Vera" and call it a correction. Five is deliberate: it is
# what lets "Roast" reach "Roar", the exact brand misread this was built for.
MIN_FUZZY_LENGTH = 5
MAX_FUZZY_DISTANCE = 2

_TABLE: Optional[Dict] = None
_INDEXES: Dict[str, Dict[str, str]] = {}


@dataclass
class NormalizedValue:
    value: str                      # what to use
    canonical: bool = False         # an alias or canonical spelling matched
    suggestion: Optional[str] = None  # near miss, NOT applied
    original: str = ""


def _load_table() -> Dict:
    global _TABLE
    if _TABLE is None:
        try:
            with open(_TABLE_PATH, encoding="utf-8") as handle:
                loaded = json.load(handle)
            _TABLE = loaded if isinstance(loaded, dict) else {}
        except Exception:
            # A missing or broken table means no normalization, not a dead batch.
            _TABLE = {}
    return _TABLE


def reset_cache() -> None:
    """Drop the loaded table and indexes. For tests."""
    global _TABLE
    _TABLE = None
    _INDEXES.clear()


def normalize_key(raw: str) -> str:
    """Lowercase, drop apostrophes so "Levi's" == "Levis", collapse the rest."""
    lowered = (raw or "").lower().replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", " ", lowered).strip()


def _tidy(raw: str) -> str:
    return re.sub(r"\s+", " ", (raw or "")).strip()


def _index_for(field: str) -> Dict[str, str]:
    cached = _INDEXES.get(field)
    if cached is not None:
        return cached
    section = _FIELD_SECTIONS.get(field)
    table = _load_table().get(section) if section else None
    index: Dict[str, str] = {}
    if isinstance(table, dict):
        for canonical, aliases in table.items():
            if not isinstance(canonical, str):
                continue
            index[normalize_key(canonical)] = canonical
            if not isinstance(aliases, list):
                continue
            for alias in aliases:
                if not isinstance(alias, str):
                    continue
                key = normalize_key(alias)
                # First writer wins: a canonical spelling is never displaced by
                # some other entry's alias.
                if key and key not in index:
                    index[key] = canonical
    _INDEXES[field] = index
    return index


def edit_distance(a: str, b: str, max_distance: int = 3) -> int:
    """Levenshtein distance, abandoning the row once it exceeds max_distance."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_distance:
        return max_distance + 1
    previous = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i]
        best = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            value = min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
            row.append(value)
            best = min(best, value)
        if best > max_distance:
            return max_distance + 1
        previous = row
    return previous[len(b)]


def _nearest_known(key: str, index: Dict[str, str]) -> Optional[str]:
    if len(key) < MIN_FUZZY_LENGTH:
        return None
    best: Optional[str] = None
    best_distance = MAX_FUZZY_DISTANCE + 1
    tied = False
    for candidate_key, canonical in index.items():
        distance = edit_distance(key, candidate_key, MAX_FUZZY_DISTANCE)
        if distance > MAX_FUZZY_DISTANCE:
            continue
        if distance < best_distance:
            best_distance, best, tied = distance, canonical, False
        elif distance == best_distance and canonical != best:
            tied = True
    # An ambiguous near miss is a coin flip, not a suggestion.
    return None if tied else best


def normalize_value(field: str, raw: object) -> NormalizedValue:
    original = _tidy(raw if isinstance(raw, str) else "")
    if not original:
        return NormalizedValue(value="", canonical=False, original="")
    key = normalize_key(original)
    if not key:
        return NormalizedValue(value=original, canonical=False, original=original)

    index = _index_for(field)
    exact = index.get(key)
    if exact:
        return NormalizedValue(value=exact, canonical=True, original=original)

    suggestion = _nearest_known(key, index)
    return NormalizedValue(
        value=original, canonical=False, suggestion=suggestion, original=original,
    )


def canonical_brand(raw: object) -> str:
    return normalize_value("brand", raw).value


def canonical_material(raw: object) -> str:
    return normalize_value("material", raw).value


def canonical_color(raw: object) -> str:
    return normalize_value("color", raw).value


def canonical_fit(raw: object) -> str:
    return normalize_value("fit", raw).value


def detect_sub_brand(brand: str, text: Optional[str]) -> Optional[str]:
    """The sub-brand named in `text`, if any. "Levi's Silver Tab" is not "Levi's"."""
    subs = _load_table().get("subBrands", {}).get(brand)
    if not isinstance(subs, list) or not text:
        return None
    haystack = normalize_key(text)
    for sub in subs:
        if not isinstance(sub, str):
            continue
        key = normalize_key(sub)
        if key and re.search(rf"(^| ){re.escape(key)}( |$)", haystack):
            return sub
    return None


def canonical_names(field: str) -> List[str]:
    section = _FIELD_SECTIONS.get(field)
    table = _load_table().get(section) if section else None
    return sorted(table.keys()) if isinstance(table, dict) else []
