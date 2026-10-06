"""Reconcile what the tags said with what the model concluded.

Every attribute the app stores has always looked equally true: one flat column,
plus a single item-level confidence the model scored itself on. That is the
wrong shape. "95% cotton", printed on a care label and read character by
character, is not the same kind of claim as a colour the model inferred from a
photo, and an operator triaging fifty items needs to see which is which.

Three statuses, and the rules that assign them:

    verified   OCR and vision agree, or OCR matched a structured pattern that
               identifies itself (a fabric percentage, MADE IN, an RN number).
    inferred   vision said it and nothing contradicted it.
    uncertain  OCR and vision disagree. BOTH values are kept -- the vision value
               stays in the field, the tag reading goes in the evidence -- because
               picking a winner automatically is exactly the move that produces a
               confidently mislabelled listing.

This module is pure so the rules are testable without PaddleOCR or a GPU.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from . import normalize

VERIFIED = "verified"
INFERRED = "inferred"
UNCERTAIN = "uncertain"

# Fields the vision model reports that are worth an evidence record. Everything
# else rides the raw JSON unchanged.
_TRACKED = (
    "brand", "size", "itemType", "category", "department", "color", "pattern",
    "material", "fit", "styleNumber", "countryOfOrigin",
)


def _entry(value: Any, status: str, sources: List[str], raw_ocr: Optional[str] = None,
           note: Optional[str] = None) -> Dict[str, Any]:
    record: Dict[str, Any] = {"value": value, "status": status, "sources": sources}
    if raw_ocr:
        record["rawOcr"] = raw_ocr
    if note:
        record["note"] = note
    return record


def _same_brand(a: str, b: str) -> bool:
    """Brand equality after canonicalization, tolerating OCR word-joining.

    PaddleOCR returned "BrooksiBrathers" and "QUIKSILVER" for tags whose brands
    are "Brooks Brothers" and "Quiksilver"; comparing raw strings would call both
    a disagreement.
    """
    ka, kb = normalize.normalize_key(a), normalize.normalize_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    # Spaces are the first thing a tag reader loses.
    ja, jb = ka.replace(" ", ""), kb.replace(" ", "")
    if ja == jb:
        return True
    if len(ja) >= 5 and len(jb) >= 5 and (ja in jb or jb in ja):
        return True
    return normalize.edit_distance(ja, jb, 2) <= 2


def _same_size(a: str, b: str) -> bool:
    return normalize.normalize_key(a).replace(" ", "") == normalize.normalize_key(b).replace(" ", "")


def _pretty_country(raw: str) -> str:
    """Title-case a country without flattening its acronyms: USA stays USA."""
    words = []
    for word in raw.split():
        words.append(word.upper() if len(word) <= 3 else word.title())
    return " ".join(words)


def _best_fabric(fabric: List[Tuple[int, str]]) -> Optional[str]:
    """The dominant fibre, title-cased: [(95,'COTTON'),(5,'SPANDEX')] -> 'Cotton'."""
    if not fabric:
        return None
    percent, material = max(fabric, key=lambda pair: pair[0])
    if percent < 50:
        return None
    return normalize.canonical_material(material.title()) or material.title()


def build_evidence(parsed: Dict, fields: Dict, reading: Any = None) -> Tuple[Dict, Dict]:
    """Return (evidence, derived).

    `evidence` is the per-attribute record. `derived` holds values OCR supplied
    that the model did not -- material, country of origin, style number -- for the
    caller to merge into the raw payload so they reach the database. OCR fills a
    gap; it never overwrites a value the model already produced.
    """
    parsed = parsed or {}
    fields = fields or {}
    evidence: Dict[str, Dict] = {}
    derived: Dict[str, Any] = {}

    def stored(name: str) -> Optional[str]:
        value = fields.get(name)
        if value is None:
            value = parsed.get(name)
        if value is None or not str(value).strip():
            return None
        return str(value).strip()

    has_ocr = reading is not None and getattr(reading, "lines", None)

    # --- brand ------------------------------------------------------------
    brand = stored("brand")
    if brand:
        candidates = list(getattr(reading, "brand_candidates", []) or []) if has_ocr else []
        match = next((c for c in candidates if _same_brand(brand, c)), None)
        if match:
            evidence["brand"] = _entry(brand, VERIFIED, ["vision", "ocr"], raw_ocr=match)
        elif candidates:
            evidence["brand"] = _entry(
                brand, UNCERTAIN, ["vision"], raw_ocr=candidates[0],
                note="the tag did not read as this brand",
            )
        else:
            evidence["brand"] = _entry(brand, INFERRED, ["vision"])

    # --- size -------------------------------------------------------------
    size = stored("size")
    ocr_sizes = list(getattr(reading, "size_candidates", []) or []) if has_ocr else []
    if size:
        match = next((s for s in ocr_sizes if _same_size(size, s)), None)
        if match:
            evidence["size"] = _entry(size, VERIFIED, ["vision", "ocr"], raw_ocr=match)
        elif ocr_sizes:
            evidence["size"] = _entry(
                size, UNCERTAIN, ["vision"], raw_ocr=ocr_sizes[0],
                note="the tag read a different size",
            )
        else:
            evidence["size"] = _entry(size, INFERRED, ["vision"])
    elif ocr_sizes:
        # The model had nothing; the tag did. This is a gap fill, not a conflict.
        derived["size"] = ocr_sizes[0]
        evidence["size"] = _entry(ocr_sizes[0], VERIFIED, ["ocr"], raw_ocr=ocr_sizes[0])

    # The ruler's numbers were dropped from the reading, but the vision model saw
    # the same ruler. A size that is one of those numbers and nothing a tag said
    # is not wrong for certain - the tag may say 10 as well - but it is a reason
    # to look, which is what UNCERTAIN means.
    ruler_numbers = set(getattr(reading, "props_ignored", None) or []) if reading is not None else set()
    if size and size in ruler_numbers and evidence.get("size", {}).get("status") == INFERRED:
        evidence["size"] = _entry(size, UNCERTAIN, ["vision"], note="this number is printed on the ruler")

    # --- material ---------------------------------------------------------
    material = stored("material")
    ocr_material = _best_fabric(list(getattr(reading, "fabric", []) or [])) if has_ocr else None
    if ocr_material and not material:
        # eBay makes Exterior Material REQUIRED on bags and blocks the whole
        # listing without it; one item burned a 211s publish attempt on exactly
        # this. A care label states it outright.
        derived["material"] = ocr_material
        evidence["material"] = _entry(ocr_material, VERIFIED, ["ocr"], raw_ocr=ocr_material)
    elif material and ocr_material:
        if normalize.normalize_key(material) == normalize.normalize_key(ocr_material):
            evidence["material"] = _entry(material, VERIFIED, ["vision", "ocr"], raw_ocr=ocr_material)
        else:
            evidence["material"] = _entry(
                material, UNCERTAIN, ["vision"], raw_ocr=ocr_material,
                note="the care label reads differently",
            )
    elif material:
        evidence["material"] = _entry(material, INFERRED, ["vision"])

    # --- style number -----------------------------------------------------
    ocr_styles = list(getattr(reading, "style_numbers", []) or []) if has_ocr else []
    style_number = stored("styleNumber")
    if ocr_styles:
        chosen = ocr_styles[0]
        if not style_number:
            derived["styleNumber"] = chosen
            evidence["styleNumber"] = _entry(chosen, VERIFIED, ["ocr"], raw_ocr=chosen)
        else:
            match = next((value for value in ocr_styles
                          if value.strip().casefold() == style_number.casefold()), None)
            evidence["styleNumber"] = (
                _entry(style_number, VERIFIED, ["vision", "ocr"], raw_ocr=match)
                if match else _entry(style_number, UNCERTAIN, ["vision"], raw_ocr=chosen,
                                     note="the tag read a different style number")
            )
    elif style_number:
        evidence["styleNumber"] = _entry(style_number, INFERRED, ["vision"])

    # --- country of origin ------------------------------------------------
    stored_country = stored("countryOfOrigin")
    country = getattr(reading, "country", None) if has_ocr else None
    if country:
        pretty = _pretty_country(str(country))
        # "MADE IN USA" is a real value signal on vintage denim, and it is only
        # allowed into a title because it was read off a label, not guessed.
        if not stored_country:
            derived["countryOfOrigin"] = pretty
            evidence["countryOfOrigin"] = _entry(pretty, VERIFIED, ["ocr"], raw_ocr=str(country))
        elif normalize.normalize_key(stored_country) == normalize.normalize_key(pretty):
            evidence["countryOfOrigin"] = _entry(stored_country, VERIFIED, ["vision", "ocr"], raw_ocr=str(country))
        else:
            evidence["countryOfOrigin"] = _entry(
                stored_country, UNCERTAIN, ["vision"], raw_ocr=str(country),
                note="the tag read a different country of origin",
            )
    elif stored_country:
        evidence["countryOfOrigin"] = _entry(stored_country, INFERRED, ["vision"])

    # --- everything else vision reported ----------------------------------
    for name in ("itemType", "category", "color", "pattern", "fit"):
        value = stored(name)
        if value and name not in evidence:
            evidence[name] = _entry(value, INFERRED, ["vision"])

    # A near-miss spelling is a reason to look, so it downgrades an otherwise
    # confident field rather than sitting silently in the raw JSON.
    suggestions = parsed.get("normalizationSuggestions")
    if isinstance(suggestions, dict):
        for name, suggestion in suggestions.items():
            record = evidence.get(name)
            if record and record.get("status") != UNCERTAIN:
                record["status"] = UNCERTAIN
                record["note"] = f"did you mean {suggestion}?"
            elif record:
                record["note"] = f"{record.get('note', '')} did you mean {suggestion}?".strip()

    return evidence, derived


def summarize(evidence: Dict) -> Dict[str, int]:
    """Counts per status, for a one-line progress message."""
    totals = {VERIFIED: 0, INFERRED: 0, UNCERTAIN: 0}
    for record in (evidence or {}).values():
        status = record.get("status")
        if status in totals:
            totals[status] += 1
    return totals
