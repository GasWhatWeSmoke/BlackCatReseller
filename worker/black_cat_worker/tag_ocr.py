"""Read the clothing tags: brand, size, style number, fabric, country.

Why this exists: a general vision model looking at a 40-pixel neck tag is
guessing, and it guessed wrong in production — "Roar" came back as "Roast",
"Burberry Brit" was clipped to "Burberry", and sizes were missed outright. A
dedicated OCR pass reads text from the item's photos and hands it to the vision
model as fallible evidence. The text can come from labels, graphics, care text or
the background; neither a match nor the early-stop heuristic verifies its source.

Two kinds of field come out of here and they are NOT equally certain:

  * Pattern-matched text (RN 12345, 100% COTTON, MADE IN MEXICO, STYLE 501).
    These have recognizable formats, but the OCR can misread them and the source
    may not be a clothing label. A pattern match is not independent verification.
  * Candidates (which line is the brand, which token is the size). These are
    ranked guesses. They go to the vision model as hints, and the reconciliation
    in vision.py decides.

Everything below the OCR call is pure string work, so the whole interpretation
layer is tested without PaddleOCR installed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from itertools import groupby
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import ocr_engine, props
from .ocr_engine import OcrLine
from .photo_orientation import rotate_cv_image, validate_rotation

# Longest side the tag image is scaled to before OCR. Measured on real tag
# shots (a 4000x4000 Brooks Brothers care-tag close-up), CPU PP-OCR:
#
#   1600px  22.1s  Brooks/1818/SLIM FIT/95%COTTON/5%SPANDEX/MADE IN VIETNAM
#   1280px  15.1s  same fields
#   1024px  11.7s  same fields, cleanest composition read of the four
#    900px   8.5s  same fields
#
# This close-up retained the same fields down to ~900px; 1024 took about half
# the time of 1600. This sample does not establish accuracy or timing for other
# photos, especially small or unclear print.
TAG_MAX_SIDE = 1024

# How far back from the SKU sticker to look for tags. The scan still stops at the
# first tag-like reading, so a tag shot last can cost one photo as before;
# this bound only decides how deep we keep looking when nothing has been found.
DEFAULT_MAX_PHOTOS = 8
DEFAULT_MIN_CONFIDENCE = 0.6

# ---------------------------------------------------------------------------
# Patterns. Uppercase-normalized text is matched, so these are all upper-case.
# ---------------------------------------------------------------------------
_RN_RE = re.compile(r"\bRN\s*#?\s*(\d{4,6})\b")
_CA_RE = re.compile(r"\bCA\s*#?\s*(\d{4,6})\b")
# A registration the label carries - RN, CA, or the wool-products WPL - which the
# vision model has offered as a style number ("WPL 10167" on 000129).
# OCR splits the digits sometimes ("RN4 11965" on 000137), so spaces inside them count.
_REGISTRATION_RE = re.compile(r"^(?:RN|CA|WPL)\s*#?\s*:?\s*\d[\d\s]{1,8}\d$", re.I)
_STYLE_RE = re.compile(
    r"\b(?:STYLE\s*NO|STYLE\s*#|STYLE|MODEL\s*NO|MODEL|ART\s*NO|ART)\s*[:#.]?\s*"
    r"([A-Z0-9][A-Z0-9\-/]{2,19})\b"
)
_FABRIC_RE = re.compile(r"(\d{1,3})\s*%\s*([A-Z][A-Z ]{2,19}?)(?=\s*(?:\d{1,3}\s*%|$|[,/]))")
# Where a captured material name has run on into the next sentence on the label. A
# narrow care label wraps, so "100% COTTON" and "MADE IN HONDURAS" arrive as one line
# and the material swallowed the next fact - a real read came back as "COTTON MADE".
# A detached "100%" / "MADE" must also be rejected at the start of the capture.
# The lookahead is (?![A-Z]) rather than a word boundary on purpose: written as the
# usual escape through a shell heredoc, this line has twice reached the file as a
# literal backspace byte instead.
_MATERIAL_TAIL_RE = re.compile(
    r"(?:^|\s+)(?:MADE|ASSEMBLED|SEWN|KNIT|WOVEN|DYED|PRINTED|FINISHED|IMPORTED|EXCLUSIVE"
    r"|BODY|SHELL|LINING)(?![A-Z]).*$"
)

_COUNTRY_RE = re.compile(r"\bMADE\s+IN\s+([A-Z][A-Z .]{1,24}?)(?=\s*$|[,/]|\s{2,})")

# Size shapes that are unambiguous wherever they appear.
_SIZE_WAIST_X_RE = re.compile(r"\b(\d{2})\s*[X×]\s*(\d{2})\b")
_SIZE_WL_RE = re.compile(r"\bW\s*(\d{2})\s*L\s*(\d{2})\b")
_SIZE_LABELLED_RE = re.compile(
    r"\bSIZE\s*[:.]?\s*([A-Z0-9]{1,4}(?:\s*/\s*[A-Z0-9]{1,4})?)\b"
)
# Letter sizes only trusted when they stand alone or are explicitly labelled --
# a bare "L" inside a sentence of care instructions is not a size.
_LETTER_SIZES = {
    "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL",
    "2XL", "3XL", "4XL", "5XL", "1X", "2X", "3X",
    "OS", "OSFA", "ONE SIZE",
}
_NUMERIC_SIZE_RE = re.compile(r"^\d{1,2}(?:\.\d)?$")

# Vocabulary that proves a line is care/legal text rather than a brand.
_CARE_WORDS = {
    "WASH", "WASHING", "MACHINE", "TUMBLE", "DRY", "DRYER", "BLEACH", "IRON",
    "IRONING", "COLD", "WARM", "HOT", "HAND", "LINE", "HANG", "FLAT", "COOL",
    "DO", "NOT", "ONLY", "WITH", "LIKE", "COLORS", "COLOURS", "INSIDE", "OUT",
    "PROFESSIONAL", "CLEAN", "CLEANING", "DRYCLEAN", "TEMPERATURE", "REMOVE",
    "PROMPTLY", "GENTLE", "CYCLE", "SEPARATELY", "CHLORINE", "NON", "LOW",
    "MEDIUM", "HIGH", "KEEP", "AWAY", "FROM", "FIRE", "EXCLUSIVE", "OF",
    "DECORATION", "TRIM", "IMPORTED", "MADE", "IN", "FABRIC", "SHELL", "BODY",
    "LINING", "CONTENT", "CARE", "INSTRUCTIONS", "STYLE", "SIZE", "RN", "CA",
    "COTTON", "POLYESTER", "RAYON", "NYLON", "SPANDEX", "ELASTANE", "WOOL",
    "ACRYLIC", "LINEN", "VISCOSE", "MODAL", "LYOCELL", "SILK", "LEATHER",
    # Fit words share the tag with the brand ("SLIM FIT" sat right under the
    # Brooks Brothers mark on the shirt this was tuned against) and would
    # otherwise be offered as a brand candidate.
    "FIT", "SLIM", "REGULAR", "RELAXED", "SKINNY", "STRAIGHT", "ATHLETIC",
    "PETITE", "TALL", "BIG", "SLIMFIT",
}

# Signals that this photo really was a tag shot, used to stop reading early.
# Any one of these is a structured, machine-printed fact that garment photos and
# background clutter do not produce by accident.
_STRONG_SIGNAL_MIN_CONFIDENT_LINES = 3
_STRONG_SIGNAL_CONFIDENCE = 0.9


@dataclass
class TagReading:
    """Everything the tag pass learned about one item."""
    lines: List[OcrLine] = field(default_factory=list)
    brand_candidates: List[str] = field(default_factory=list)
    size_candidates: List[str] = field(default_factory=list)
    style_numbers: List[str] = field(default_factory=list)
    rn_numbers: List[str] = field(default_factory=list)
    ca_numbers: List[str] = field(default_factory=list)
    fabric: List[Tuple[int, str]] = field(default_factory=list)
    country: Optional[str] = None
    photos_read: List[str] = field(default_factory=list)
    unavailable_reason: Optional[str] = None
    # Prop print dropped before reading: the ruler's own maker and model. See props.py.
    props_ignored: List[str] = field(default_factory=list)
    # The dropped lines themselves, photo and all, so the stored record stays complete.
    dropped_lines: List[OcrLine] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.lines

    def to_json(self) -> Dict[str, Any]:
        """Bounded, JSON-safe form for `raw.ocr` — kept for debugging.

        Line count is capped because this rides through the enrichment IPC
        validator, which bounds total node count.
        """
        def line_json(ln: OcrLine, prop: bool) -> Dict[str, Any]:
            record: Dict[str, Any] = {
                "text": ln.text,
                "confidence": round(ln.confidence, 3) if ln.confidence is not None else None,
                "photo": ln.source,
            }
            if prop:
                record["prop"] = True
            return record

        # The COMPLETE record of what OCR read: the prop lines ride along, marked,
        # because "which photo was the ruler on" is a question a later pass over a
        # stored row has to be able to answer. Kept lines first.
        lines = [line_json(ln, False) for ln in self.lines]
        lines += [line_json(ln, True) for ln in self.dropped_lines]
        return {
            "lines": lines[:60],
            "extracted": {
                "brandCandidates": self.brand_candidates[:5],
                "sizeCandidates": self.size_candidates[:5],
                "styleNumbers": self.style_numbers[:5],
                "rnNumbers": self.rn_numbers[:3],
                "caNumbers": self.ca_numbers[:3],
                "fabric": [{"percent": p, "material": m} for p, m in self.fabric[:6]],
                "country": self.country,
            },
            "photosRead": self.photos_read[:8],
            "propsIgnored": self.props_ignored[:8],
            "unavailable": self.unavailable_reason,
        }


# ---------------------------------------------------------------------------
# Pure text interpretation
# ---------------------------------------------------------------------------
def normalize_text(text: str) -> str:
    """Upper-case, collapse whitespace, and unify the dash/quote variants OCR emits."""
    if not text:
        return ""
    cleaned = (
        text.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("–", "-")
        .replace("—", "-")
    )
    return re.sub(r"\s+", " ", cleaned).strip().upper()


def select_tag_photos(paths: Sequence[str], max_photos: int = DEFAULT_MAX_PHOTOS) -> List[str]:
    """Pick which photos to OCR: the LAST few.

    Tags are shot last in this workflow — that is the same assumption the vision
    photo selector already encodes by always including the final frame. Reading
    from the end finds neck/care/waist tags without paying OCR on every hero shot.
    """
    if max_photos <= 0:
        return []
    ordered = [p for p in paths if p]
    if len(ordered) <= max_photos:
        return list(ordered)
    return list(ordered[-max_photos:])


def extract_rn_numbers(texts: Sequence[str]) -> List[str]:
    return _dedupe(m.group(1) for t in texts for m in _RN_RE.finditer(t))


def extract_ca_numbers(texts: Sequence[str]) -> List[str]:
    return _dedupe(m.group(1) for t in texts for m in _CA_RE.finditer(t))


def is_registration_number(value: object) -> bool:
    """RN 12345 / CA 34567 / WPL 10167: a label registration, never a style number."""
    return isinstance(value, str) and bool(_REGISTRATION_RE.match(value.strip()))


def extract_style_numbers(texts: Sequence[str]) -> List[str]:
    out = []
    for t in texts:
        for m in _STYLE_RE.finditer(t):
            value = m.group(1).strip(" -/")
            # A style number that is only letters is almost always the next word
            # of a sentence ("STYLE NUMBER"), not an identifier.
            if value and any(ch.isdigit() for ch in value):
                out.append(value)
    return _dedupe(out)


def extract_fabric(texts: Sequence[str]) -> List[Tuple[int, str]]:
    """Fabric composition as (percent, material) pairs, e.g. (100, "COTTON")."""
    out: List[Tuple[int, str]] = []
    seen = set()
    for t in texts:
        for m in _FABRIC_RE.finditer(t):
            try:
                pct = int(m.group(1))
            except ValueError:
                continue
            material = re.sub(r"\s+", " ", m.group(2)).strip()
            # A narrow care label wraps, so "100% COTTON" and "MADE IN HONDURAS" arrive
            # as one line and the material swallowed the next sentence -- a real read
            # came back as "COTTON MADE". Cut at the words that start the NEXT fact.
            material = _MATERIAL_TAIL_RE.sub("", material).strip()
            if not (0 < pct <= 100) or len(material) < 3:
                continue
            key = (pct, material)
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
    return out


def extract_country(texts: Sequence[str]) -> Optional[str]:
    """The country of manufacture, preferring the most complete reading.

    The same tag is often caught twice across photos, once clipped by the frame
    edge: a real run produced both "MADE IN VIETNA" and "MADE IN VIETNAM". Taking
    the first match would have kept the truncated one, so the longest wins.
    """
    best: Optional[str] = None
    for t in texts:
        for m in _COUNTRY_RE.finditer(t):
            country = m.group(1).strip(" .")
            if len(country) < 2:
                continue
            if best is None or len(country) > len(best):
                best = country
    return best


def extract_size_candidates(texts: Sequence[str]) -> List[str]:
    """Size tokens, only where the shape is unambiguous.

    A bare "L" in the middle of "TUMBLE DRY LOW" is not a size, so single
    letters count only when the whole line is that token or the line says SIZE.
    """
    out: List[str] = []
    for t in texts:
        for m in _SIZE_WL_RE.finditer(t):
            out.append(f"W{m.group(1)} L{m.group(2)}")
        for m in _SIZE_WAIST_X_RE.finditer(t):
            out.append(f"{m.group(1)}x{m.group(2)}")
        for m in _SIZE_LABELLED_RE.finditer(t):
            token = re.sub(r"\s*/\s*", "/", m.group(1).strip())
            if token:
                out.append(token)
        stripped = t.strip(" :.-")
        if stripped in _LETTER_SIZES or _NUMERIC_SIZE_RE.match(stripped):
            out.append(stripped)
    return _dedupe(out)


def _looks_like_brand(text: str) -> bool:
    """A short, mostly-alphabetic line that is not care text, size, or legal boilerplate."""
    if not (2 <= len(text) <= 30):
        return False
    if not any(ch.isalpha() for ch in text):
        return False
    if text in _LETTER_SIZES or _NUMERIC_SIZE_RE.match(text):
        return False
    letters = sum(1 for ch in text if ch.isalpha())
    if letters / max(len(text), 1) < 0.55:
        return False
    words = [w for w in re.split(r"[^A-Z']+", text) if w]
    if not words or len(words) > 4:
        return False
    # Any care/legal vocabulary at all disqualifies the line: brands do not read
    # "TUMBLE DRY LOW", and a line mixing both is care text with a word that
    # happens to look like a name.
    if any(w in _CARE_WORDS for w in words):
        return False
    if _RN_RE.search(text) or _CA_RE.search(text) or "%" in text:
        return False
    return True


def rank_brand_candidates(lines: Sequence[OcrLine]) -> List[str]:
    """Rank plausible brand lines, biggest and most confident text first.

    Box height is the useful signal here: on a neck tag the brand is printed
    larger than the care text beneath it, so a taller line is more likely the
    name. Confidence breaks ties when boxes are unavailable.
    """
    scored: List[Tuple[float, str]] = []
    seen = set()
    for ln in lines:
        text = normalize_text(ln.text)
        if not _looks_like_brand(text) or text in seen:
            continue
        seen.add(text)
        height = 0.0
        if ln.box:
            try:
                height = float(ln.box[3] - ln.box[1])
            except Exception:
                height = 0.0
        confidence = ln.confidence if ln.confidence is not None else 0.5
        scored.append((height * 10.0 + confidence, text))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [text for _, text in scored]


def stitch_wrapped(texts: Sequence[str], max_join: int = 3) -> List[str]:
    """The original lines PLUS every run of consecutive lines joined together.

    A care label is printed narrow, so OCR returns it wrapped: a real tag read
    "100% Cotton Made" / "in Honduras" on two lines, and the country pattern —
    which quite reasonably wants MADE IN <somewhere> — matched neither of them.
    The country was simply lost, on a field the vision model cannot supply and
    the title needs to justify saying "Made in USA".

    Runs are capped at three lines: beyond that the joins start manufacturing
    phrases that were never adjacent on the label. Windows are taken from the
    ORIGINAL lines, never from earlier joins — growing the list while walking it
    produced six-word Frankenstein phrases out of three-line runs.

    This view is a FALLBACK, never a replacement. See interpret().
    """
    base = [t for t in texts if t]
    out: List[str] = list(base)
    for width in range(2, max_join + 1):
        for i in range(len(base) - width + 1):
            out.append(" ".join(base[i:i + width]))
    return out


def interpret(lines: Sequence[OcrLine]) -> TagReading:
    """Turn raw OCR lines into the structured tag reading."""
    texts = [normalize_text(ln.text) for ln in lines]
    # The ruler laid beside the garment for scale is the crispest print in the
    # frame and it is not the item. Its lines leave before anything is read off
    # them; props.py has the whole story of "Model 403".
    lines, texts, dropped_lines, props_ignored = props.split_prop_lines(lines, texts)
    texts = [t for t in texts if t]

    # Wrapped-line rescue, and deliberately a FALLBACK rather than a wider net: the
    # stitched view contains phrases that were never printed as one line, and feeding
    # it in alongside the real lines broke a rule that was already right. The same tag
    # photographed twice gives "MADE IN VIETNA" (clipped by the frame) and "MADE IN
    # VIETNAM"; extract_country prefers the longer, complete reading, but stitching
    # also offers "MADE IN VIETNA MADE IN VIETNAM", which is longer still and wrong.
    # So the real lines answer first, and the joins only get asked when they found
    # nothing at all.
    def _or_stitched(extract):
        found = extract(texts)
        if found:
            return found
        # Only adjacent lines from one photo can complete a wrapped label.
        # Collected OCR spans photos; joining their edges invents new facts.
        stitched = []
        for _source, photo_lines in groupby(lines, key=lambda line: line.source):
            stitched.extend(stitch_wrapped([normalize_text(line.text) for line in photo_lines]))
        return extract(stitched)

    return TagReading(
        lines=list(lines),
        brand_candidates=rank_brand_candidates(lines),
        size_candidates=extract_size_candidates(texts),
        style_numbers=extract_style_numbers(texts),
        rn_numbers=extract_rn_numbers(texts),
        ca_numbers=extract_ca_numbers(texts),
        fabric=_or_stitched(extract_fabric),
        country=_or_stitched(extract_country),
        props_ignored=props_ignored,
        dropped_lines=dropped_lines,
    )


def has_strong_tag_signal(reading: TagReading) -> bool:
    """Heuristic for stopping after tag-like text, not proof of a label.

    Structured formats and confident brand candidates can justify an early stop,
    but graphics or OCR errors can also satisfy these conditions. The fallback
    is intended for brand-only woven labels; it does not verify the candidate.
    """
    if reading.fabric or reading.country or reading.rn_numbers or reading.style_numbers:
        return True
    if reading.ca_numbers:
        return True
    # The confident-line fallback exists for brand-only woven labels, so it may
    # only fire when a brand actually came out of the reading. Without this guard
    # ANY three crisp lines ended the scan - a slogan across the chest, a size
    # sticker, a care tag whose words all parsed into nothing - on a reading that
    # carried no usable fact at all, and the real tag a few frames earlier was
    # never read. Measured on 000131: the scan stopped at the last photo on a
    # five-line reading with zero candidates while "NABEE" sat two photos back.
    if not reading.brand_candidates:
        return False
    confident = sum(
        1 for ln in reading.lines
        if ln.confidence is not None and ln.confidence >= _STRONG_SIGNAL_CONFIDENCE
    )
    return confident >= _STRONG_SIGNAL_MIN_CONFIDENT_LINES


def prompt_snippet(reading: TagReading, limit: int = 600) -> str:
    """The evidence block injected into the vision prompt.

    Kept small on purpose. The vision context is 8192 tokens with four images
    costing 1024 each and 1800 reserved for the answer, so this has to earn its
    place in roughly 2300 tokens of prompt. The raw lines are what matter — the
    model needs to see the actual characters to correct its own reading.

    Original casing is preserved here even though every pattern match upstream
    runs on the uppercased form. It carries real signal: a production read
    returned "BrooksiBrathers", which is recognizable as Brooks Brothers at a
    glance, while the normalized "BROOKSIBRATHERS" throws that word boundary away.
    """
    if reading.is_empty():
        return ""
    seen = set()
    parts: List[str] = []
    for ln in reading.lines:
        text = re.sub(r"\s+", " ", (ln.text or "")).strip()
        key = text.upper()
        if not text or key in seen:
            continue
        seen.add(key)
        parts.append(text)
    if not parts:
        return ""

    body = ""
    for part in parts:
        candidate = f'{body} | "{part}"' if body else f'"{part}"'
        if len(candidate) > limit:
            break
        body = candidate
    if not body:
        return ""
    return (
        "Text read by OCR from the item's photos (may include labels, graphics, "
        "care text or scanning errors; matching text alone does not verify brand "
        f"or size): {body}"
    )


def _dedupe(values) -> List[str]:
    out: List[str] = []
    seen = set()
    for v in values:
        v = (v or "").strip()
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


# ---------------------------------------------------------------------------
# The impure part: actually running OCR
# ---------------------------------------------------------------------------
def _load_for_ocr(path: str, rotation: int = 0):
    """Downscale and orient tag pixels; only unrotated reads may fall back to a path."""
    validate_rotation(rotation)
    try:
        import cv2  # type: ignore
        img = cv2.imread(path)
        if img is None:
            if rotation:
                raise ValueError("Rotated tag photo could not be decoded")
            return path
        longest = max(img.shape[0], img.shape[1])
        if longest > TAG_MAX_SIDE:
            s = TAG_MAX_SIDE / float(longest)
            img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        img = rotate_cv_image(cv2, img, rotation)
        return img
    except Exception:
        if rotation:
            raise  # Never silently read the unrotated source instead.
        return path


def read_tags(
    photo_paths: Sequence[str],
    settings: Optional[dict] = None,
    cancel_check=None,
    *,
    rotations: Optional[Dict[str, int]] = None,
) -> TagReading:
    """OCR the tag photos for one item and interpret what came back.

    Missing OCR returns an empty reading with a reason; unreadable photos are
    skipped. Cancellation may propagate through cancel_check. This is optional
    text assistance, not verified identification — the item still enriches
    without it.
    """
    settings = settings or {}
    if not settings.get("tagOcrEnabled", True):
        return TagReading(unavailable_reason="tag OCR disabled in settings")

    max_photos = _bounded_int(settings.get("tagOcrMaxPhotos"), DEFAULT_MAX_PHOTOS, 1, 8)
    min_conf = _bounded_float(settings.get("tagOcrMinConfidence"), DEFAULT_MIN_CONFIDENCE, 0.0, 1.0)

    engine = ocr_engine.shared_engine()
    if not engine:
        return TagReading(unavailable_reason="PaddleOCR unavailable")

    # Read backwards and stop on the heuristic above. In the measured shirt
    # sample the final close-up supplied the candidate fields in ~12s versus
    # ~46s for all four photos. Other photos can take longer or cause a false
    # early stop; this is not a general speed or accuracy guarantee.
    chosen = list(reversed(select_tag_photos(photo_paths, max_photos)))
    collected: List[OcrLine] = []
    read_ok: List[str] = []
    for path in chosen:
        if cancel_check is not None:
            cancel_check()
        try:
            rotation = validate_rotation((rotations or {}).get(path, 0))
            image = _load_for_ocr(path, rotation=rotation) if rotation else _load_for_ocr(path)
            for line in ocr_engine.read_lines(image, engine):
                if line.confidence is not None and line.confidence < min_conf:
                    continue
                collected.append(line.with_source(path))
            read_ok.append(path)
        except Exception:
            # One unreadable photo must not lose the tags found on the others.
            continue
        if has_strong_tag_signal(interpret(collected)):
            break

    reading = interpret(collected)
    reading.photos_read = read_ok
    return reading


def _bounded_int(value, default: int, low: int, high: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, n))


def _bounded_float(value, default: float, low: float, high: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, n))
