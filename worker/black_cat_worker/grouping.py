"""Frozen-order END markers. The 32-photo cap INCLUDES the terminal sticker.

Uncertain ranges are retained for review through the next verified marker; that
marker establishes a safe start for subsequent groups. No synthetic SKUs, empty
items, inferred boundaries, or arbitrary splitting is permitted. Decoded image
arrays are never retained here, only bounded intake references.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .sku import is_valid_sku

MAX_GROUP_PHOTOS = 32
MIN_BOUNDARY_GAP_S = 45.0


@dataclass
class DecodedPhoto:
    path: str
    filename: str
    sku: Optional[str] = None
    decoded_raw: Optional[str] = None
    decode_method: Optional[str] = None
    exif_dto: Optional[str] = None
    exif_subsec: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    qr_pattern_detected: bool = False
    ts: Optional[float] = None
    demoted_from: Optional[str] = None
    exclude_from_listing: bool = False
    marker_review_reason: Optional[str] = None
    marker_evidence: List[Dict] = field(default_factory=list)
    photo_id: Optional[str] = None
    sequence_index: Optional[int] = None
    source_filename: Optional[str] = None
    capture_metadata: Dict = field(default_factory=dict)

    @property
    def is_marker(self) -> bool:
        return is_valid_sku(self.sku)


@dataclass
class GroupedItem:
    sku: str
    original_qr_value: Optional[str]
    members: List[DecodedPhoto]
    marker: Optional[DecodedPhoto]
    placeholder: bool = False
    confidence: str = "high"
    reasons: List[str] = field(default_factory=list)
    closed_by: str = "qr-marker"
    log: List[Dict] = field(default_factory=list)

    def add_reason(self, reason: str, level: str) -> None:
        if reason not in self.reasons:
            self.reasons.append(reason)
        if {"high": 0, "medium": 1, "low": 2}[level] > {"high": 0, "medium": 1, "low": 2}[self.confidence]:
            self.confidence = level


@dataclass
class Problem:
    type: str
    sku: Optional[str] = None
    photo_path: Optional[str] = None
    message: str = ""


@dataclass
class GroupingResult:
    items: List[GroupedItem] = field(default_factory=list)
    needs_review: List[DecodedPhoto] = field(default_factory=list)
    problems: List[Problem] = field(default_factory=list)
    order_source: str = "exif"
    unresolved: List[Dict] = field(default_factory=list)


def _gap(a, b):
    return b.ts - a.ts if a is not None and b is not None and a.ts is not None and b.ts is not None else None


def _item_log(item: GroupedItem) -> List[Dict]:
    out, prev = [], None
    for p in item.members + ([item.marker] if item.marker else []):
        gap = _gap(prev, p)
        out.append({"file": p.filename, "role": "sku-sticker" if p is item.marker else "photo",
                    "time": p.exif_dto, "gapBeforeSec": round(gap, 1) if gap is not None else None,
                    "decode": p.decode_method, "raw": p.decoded_raw})
        prev = p
    return out


def group_photos(photos: List[DecodedPhoto], order_source: str = "exif", *, order_review_required: bool = False) -> GroupingResult:
    result = GroupingResult(order_source=order_source)
    counts = Counter(p.sku for p in photos if p.is_marker)
    current: List[DecodedPhoto] = []

    def quarantine(reason: str, code: str, marker=None):
        refs = list(current) + ([marker] if marker else [])
        if not refs:
            return
        message = f"{refs[0].filename} through {refs[-1].filename} ({len(refs)} photos): {reason}. Originals retained; review this range."
        result.needs_review.extend(refs)
        result.unresolved.append({"photoIds": [p.photo_id or p.path for p in refs], "reason": reason,
                                  "type": code, "sku": marker.sku if marker else None})
        result.problems.append(Problem(code, marker.sku if marker else None, refs[0].path, message))
        current.clear()

    for photo in photos:
        if not photo.is_marker:
            current.append(photo)
            continue
        if order_review_required:
            quarantine("source order needs confirmation", "ORDERING_AMBIGUITY", photo)
        elif not current:
            quarantine("a marker has no preceding product photos", "MARKER_NO_PHOTOS", photo)
        elif counts[photo.sku] > 1:
            quarantine("the SKU appears on multiple marker photos", "AMBIGUOUS_MARKER", photo)
        elif len(current) + 1 > MAX_GROUP_PHOTOS:
            quarantine("range exceeds the 32-photo per-item cap, including its terminal marker", "OVERSIZED_GROUP", photo)
        elif any(p.marker_review_reason for p in current) or photo.marker_review_reason:
            quarantine("an uncertain sticker may conceal an earlier item boundary", "UNCERTAIN_MARKER_RANGE", photo)
        else:
            item = GroupedItem(photo.sku, photo.decoded_raw, list(current), photo,
                               closed_by="ocr-marker" if photo.decode_method == "ocr" else "manual-marker" if photo.decode_method == "manual" else "qr-marker")
            # Time gaps are a review signal, never an automatic split or proof.
            gaps = [_gap(a, b) for a, b in zip(current, current[1:] + [photo])]
            if any(g is not None and g >= MIN_BOUNDARY_GAP_S for g in gaps):
                item.add_reason("a capture-time gap occurs inside this group; confirm one item", "medium")
            if order_source.startswith("filename"):
                item.add_reason("ordered by a consistent camera filename sequence", "medium")
            item.log = _item_log(item)
            result.items.append(item)
            current.clear()
    if current:
        quarantine("no verified terminal SKU sticker follows these photos", "UNTERMINATED_GROUP")

    # A missing number alone is not proof, but a gap plus an internal suspected
    # sticker or substantial capture pause is enough to withhold a merged range.
    previous = None
    clean = []
    for item in result.items:
        number = int(item.sku[3:])
        if previous is not None and number == previous + 2 and item.reasons and any("capture-time gap" in r for r in item.reasons):
            current.extend(item.members)
            quarantine("a capture gap and absent intervening SKU suggest a missing boundary", "MERGED_GROUP_SUSPECTED", item.marker)
        else:
            clean.append(item)
        previous = number
    result.items = clean
    return result
