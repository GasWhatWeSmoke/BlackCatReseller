"""Studio props: the measuring tools that show up in photos and are not the item.

Every measurement photo has a metal ruler laid along the garment for scale, and
the ruler carries its own maker's mark and model number - "Empire" and "Model
403" - in the crispest machine print in the frame. Batch 39 shipped eight items
with "Model 403" as their model or style number, three of them branded
"Empire", across five real brands and four garment types. Both readers did what
they were built to do: PaddleOCR read the sharpest text it could see, and the
vision model, handed those lines as "text read off this item's tags", agreed
with it. The ruler even ended the tag scan early - "MODEL 403" counts as a
style number, and a style number is a stop signal - so the real tag a few
frames back was never read at all.

Neither reader can tell a ruler from a care label by looking. What CAN be known
is which props this studio uses, so the rule is a short list of their print,
and that list lives here and nowhere else. Two things are done with it:

  * OCR lines that are a prop's print are dropped before anything is read off
    them, along with the bare inch marks on the same photo (the ruler's
    graduations were arriving as size candidates: "6", "8", "9", "10", "13").
  * The vision answer is scrubbed after parsing: a prop maker as the brand, a
    prop model as the model or style number, and any graphic, key detail, or
    description sentence that describes the prop.

When a new ruler or tape measure joins the setup, add its print to PROPS.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

from . import normalize
from .ocr_engine import OcrLine


@dataclass(frozen=True)
class Prop:
    name: str
    # Whole OCR lines, upper-cased and whitespace-collapsed (tag_ocr.normalize_text),
    # written to tolerate what PaddleOCR actually returned for this print.
    lines: Tuple[str, ...]
    # The maker as a brand value, spelled the way normalize.normalize_key() spells it.
    brand_keys: Tuple[str, ...]
    # The prop's own model number as a whole model / style-number value (case-insensitive).
    codes: Tuple[str, ...]
    # How the prop gets written into prose and lists: graphics, key details, the description.
    phrases: Tuple[str, ...]


_MAKER = r"Empir[eé]\s*®?"

PROPS: Tuple[Prop, ...] = (
    Prop(
        name="Empire Model 403 ruler",
        lines=(
            # "Empiré", "Empire?", "Empiré?": the ® mark reads as an accent or a question mark.
            r"EMPIR[EÉ]?[?.®]*",
            # "Model 403", "Mordel 403", "MODEL403", "Empire Model 403".
            r"(?:EMPIR[EÉ]?[?.®]*\s+)?M[A-Z]{3,5}\s*[#.:]?\s*4[0O]3",
        ),
        brand_keys=("empire", "empir", "empire brand", "empire level"),
        codes=(r"(?:empir[eé]?\s*)?(?:m[a-z]{3,5}\s*)?[#.:]?\s*4[0o]3",),
        phrases=(
            _MAKER + r"(?:\s+brand)?\s+Model\s*403",
            r"Model\s*403",
            r"Empiré",
            _MAKER + r"\s+brand",
            _MAKER + r"\s+logo",
        ),
    ),
)

_LINE_RES = [re.compile(pattern) for prop in PROPS for pattern in prop.lines]
_CODE_RES = [re.compile(pattern, re.I) for prop in PROPS for pattern in prop.codes]
_BRAND_KEYS = {key for prop in PROPS for key in prop.brand_keys}
_PHRASES = [phrase for prop in PROPS for phrase in prop.phrases]
_MENTION_RE = re.compile(r"\b(?:" + "|".join(_PHRASES) + r")\b", re.I)
# The prop named outright. A garment description never needs any of these words.
_PROP_WORDS_RE = re.compile(r"\b(?:ruler|tape\s+measure|measuring\s+tape|yardstick)\b", re.I)
# What is left of "reading 'Empiré' and 'Model 403'" once the quoted print is gone.
_EMPTY_QUOTES_RE = re.compile(r"""['"]\s*['"]""")
# Any bare number on a prop photo: the inch marks, and OCR's joins of them. "116"
# came off 000125's ruler shot - the circled 16 at the ruler's end and the 1 beside
# it, read as one token - and became the style number.
_INCH_MARK_RE = re.compile(r"\d+")
_FRACTION_RE = re.compile(r"\d{1,2}/\d{1,2}")
# A photo whose OCR is nothing but numbers is a measuring tool, whatever it is
# printed with. The second half of batch 39 read "14 15 20 22 25 29", "18 61 20 21
# 2 24" - the graduations of a tape or yardstick whose print never made the frame -
# and the vision model then reported one of them as the size ("Size 20" on a
# hoodie), which OCR duly "verified". Three distinct numbers and nothing else is
# what a measuring tool looks like; no tag ever reads that way.
_MEASURE_MIN_NUMBERS = 3
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_DEPARTMENT = r"(?:(?:Women|Men|Kid|Girl|Boy)['’]s|Unisex|Ladies|Youth)"


def _sentence_rules() -> List[Tuple["re.Pattern[str]", str]]:
    """The three places the model puts a prop in a sentence, and how to lift it out.

    Anything else - "the Empire logo and 'Ashley' text", "a tag reading 'Empiré'" -
    is a sentence ABOUT the prop, and scrub_text drops it whole rather than leave
    a hole in the grammar.
    """
    rules: List[Tuple["re.Pattern[str]", str]] = []
    for phrase in _PHRASES:
        # Leading: "Empiré Model 403 olive green cargo shorts", "Women's Empire brand denim jeans".
        rules.append((re.compile(r"^((?:" + _DEPARTMENT + r"\s+)?)" + phrase + r"\s+", re.I), r"\1"))
        # Appositive: "pants by True Religion, model 403, featuring".
        rules.append((re.compile(r",\s*" + phrase + r"\s*,", re.I), " "))
        # Trailing appositive: "sweater by Joseph & Lyman, Model 403."
        rules.append((re.compile(r",\s*" + phrase + r"(?=\s*(?:[.!?;:]|$))", re.I), ""))
    # Credited as the maker: "corduroy jeans by Empire".
    rules.append((re.compile(
        r"\s+by\s+(?:" + "|".join(_PHRASES + [_MAKER]) + r")(?=[\s,.;:!?]|$)", re.I), ""))
    return rules


_RULES = _sentence_rules()


def is_prop_line(normalized: str) -> bool:
    """True when a whole OCR line (upper-cased, see tag_ocr.normalize_text) is a prop's print."""
    return bool(normalized) and any(pattern.fullmatch(normalized) for pattern in _LINE_RES)


def measure_photos(lines: Sequence[OcrLine], normalized: Sequence[str]) -> Set[object]:
    """The photos whose OCR is nothing but a measuring tool's graduations."""
    by_source: Dict[object, List[str]] = {}
    for line, text in zip(lines, normalized):
        if text:
            by_source.setdefault(line.source, []).append(text)
    found: Set[object] = set()
    for source, texts in by_source.items():
        numbers = {t for t in texts if _INCH_MARK_RE.fullmatch(t)}
        if len(numbers) < _MEASURE_MIN_NUMBERS:
            continue
        if all(_INCH_MARK_RE.fullmatch(t) or _FRACTION_RE.fullmatch(t) or is_prop_line(t) for t in texts):
            found.add(source)
    return found


def split_prop_lines(
    lines: Sequence[OcrLine], normalized: Sequence[str],
) -> Tuple[List[OcrLine], List[str], List[OcrLine], List[str]]:
    """(kept lines, their normalized texts, dropped lines, their texts deduplicated).

    A prop's print goes, and so does every bare number read off the SAME photo:
    those are the ruler's inch marks. A bare number on any other photo is left
    alone - it may well be the size tag. The dropped lines are returned whole,
    photo and all, because the stored OCR record has to stay complete: a later
    pass over a stored row can only tell "116" was on the ruler photo if the
    ruler's own lines are still on record with that photo.
    """
    prop_sources = {
        line.source for line, text in zip(lines, normalized) if is_prop_line(text)
    } | measure_photos(lines, normalized)
    kept_lines: List[OcrLine] = []
    kept_texts: List[str] = []
    dropped_lines: List[OcrLine] = []
    dropped: List[str] = []
    for line, text in zip(lines, normalized):
        if is_prop_line(text) or (line.source in prop_sources and _INCH_MARK_RE.fullmatch(text)):
            dropped_lines.append(line)
            if text and text not in dropped:
                dropped.append(text)
            continue
        kept_lines.append(line)
        kept_texts.append(text)
    return kept_lines, kept_texts, dropped_lines, dropped


def _number_value(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    # Only whole numeric values with a known label/unit wrapper. Never reduce
    # a real alphanumeric product code such as J116 or 116-501 to ruler digits.
    match = re.fullmatch(
        r"\s*(?:(?:size|model|style(?:\s*(?:no\.?|number))?)\s*[:#.]?\s*)?"
        r"(\d+(?:\.\d+)?)\s*(?:inches|inch|in\.?|cm|centimeters|[\"″])?\s*", value, re.I)
    return match.group(1) if match else None


def prop_numbers(reading: object) -> Set[str]:
    """The numbers dropped off a prop photo that no kept line also carries."""
    dropped = {
        number for text in (getattr(reading, "props_ignored", None) or [])
        if (number := _number_value(text)) is not None
    }
    kept = {
        number for line in (getattr(reading, "lines", None) or [])
        if (number := _number_value(line.text or "")) is not None
    }
    return dropped - kept


_CROSS_CHECK_KEYS = ("model", "styleNumber", "size")


def cross_check(
    parsed: Dict, reading: object, fields: Optional[Dict] = None,
    keys: Sequence[str] = _CROSS_CHECK_KEYS,
) -> List[str]:
    """Clear a model, style number, or size that is one of the measuring tool's numbers.

    The vision model sees the same ruler the OCR does. On 000125 it reported
    style number "116": the circled 16 at the ruler's end and the 1 beside it,
    exactly what OCR read off that photo and nothing any tag said. A bare number
    the tags never carried and the tool's photo did is the tool's. A size goes
    the same way - "Size 20" on a Carhartt hoodie was the tape - but only when no
    tag line carries the number: a tag that also says 30 keeps its 30. `fields`
    is the mapped answer, cleared in step. Returns the keys cleared.
    """
    numbers = prop_numbers(reading)
    if not numbers or not isinstance(parsed, dict):
        return []
    touched: List[str] = []
    for key in keys:
        value = parsed.get(key)
        mapped = fields.get(key) if isinstance(fields, dict) else None
        hit = _number_value(value) in numbers or _number_value(mapped) in numbers
        if hit:
            parsed[key] = None
            if isinstance(fields, dict):
                fields.pop(key, None)
            touched.append(key)
    return touched


def is_prop_brand(value: object) -> bool:
    key = normalize.normalize_key(str(value or ""))
    return bool(key) and key in _BRAND_KEYS


def is_prop_code(value: object) -> bool:
    """A model or style number that is really the prop's own ("Model 403", "403")."""
    text = " ".join(str(value or "").split())
    if not text:
        return False
    return is_prop_brand(text) or any(pattern.fullmatch(text) for pattern in _CODE_RES)


def mentions_prop(text: object) -> bool:
    if not isinstance(text, str) or not text:
        return False
    return bool(_MENTION_RE.search(text) or _PROP_WORDS_RE.search(text))


def scrub_list(values: Sequence[object]) -> List[object]:
    """Graphics / key details / aesthetic tags with every prop mention dropped whole."""
    return [value for value in values if not mentions_prop(value)]


def _tidy(sentence: str) -> str:
    text = re.sub(r"\s+", " ", sentence).strip()
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r",\s*([.!?;:])", r"\1", text)
    text = re.sub(r"^[,;:\s]+", "", text)
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text


def scrub_text(text: Optional[str]) -> Optional[str]:
    """The description with the prop lifted out of every sentence it can be lifted
    from, and the sentences that were about the prop dropped. Untouched when it
    never mentioned one."""
    if not isinstance(text, str) or not mentions_prop(text):
        return text
    kept: List[str] = []
    for sentence in _SENTENCE_SPLIT_RE.split(text.strip()):
        if not mentions_prop(sentence):
            kept.append(sentence)
            continue
        cleaned = sentence
        for pattern, replacement in _RULES:
            cleaned = pattern.sub(replacement, cleaned)
        cleaned = _tidy(cleaned)
        if not cleaned or mentions_prop(cleaned) or _EMPTY_QUOTES_RE.search(cleaned):
            continue
        kept.append(cleaned)
    return " ".join(kept)


# The ruler as it lands in a title-shaped line: the generated public-notes line was
# "Rocky Mountain 403 Unisex ..." and "Abercrombie & Fitch Model 403 Womens ...".
_TITLE_TOKEN_RES = (
    re.compile(_MAKER + r"(?:\s+brand)?\s+Model\s*4[0o]3\b", re.I),
    re.compile(r"\bModel\s*4[0o]3\b", re.I),
    re.compile(r"\b4[0o]3\b"),
    re.compile(r"^\s*Empir[eé]\b\s*", re.I),
)


def has_prop_token(text: object) -> bool:
    """A title-shaped line (custom title, public notes) carrying the ruler's tokens."""
    return isinstance(text, str) and any(pattern.search(text) for pattern in _TITLE_TOKEN_RES)


def scrub_title(text: Optional[str]) -> Optional[str]:
    """That line with the tokens cut out and the spacing closed up."""
    if not isinstance(text, str) or not text:
        return text
    out = text
    for pattern in _TITLE_TOKEN_RES:
        out = pattern.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip()


def scrub_vision(parsed: Dict) -> List[str]:
    """Scrub a parsed vision answer in place. Returns the keys that were touched."""
    if not isinstance(parsed, dict):
        return []
    touched: List[str] = []
    for key in ("brand", "subBrand"):
        if is_prop_brand(parsed.get(key)):
            parsed[key] = None
            touched.append(key)
    for key in ("model", "styleNumber"):
        if is_prop_code(parsed.get(key)):
            parsed[key] = None
            touched.append(key)
    for key in ("graphics", "keyDetails", "aesthetic"):
        values = parsed.get(key)
        if isinstance(values, list):
            cleaned = scrub_list(values)
            if len(cleaned) != len(values):
                parsed[key] = cleaned
                touched.append(key)
    description = parsed.get("description")
    if isinstance(description, str) and mentions_prop(description):
        parsed["description"] = scrub_text(description)
        touched.append("description")
    return touched
