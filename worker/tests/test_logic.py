"""Pure-logic tests for the worker — no heavy deps (cv2/paddle/PIL) required.

Run:  python -m worker.tests.test_logic      (from project root)
  or: python worker/tests/test_logic.py
Validates SKU normalization, OCR format-correction, and the strict end-marker
grouping algorithm (incl. the problem cases), using injected decode results so
it works without any image libraries installed.
"""
from __future__ import annotations

import os
import sys

# Allow running directly: add the worker dir to sys.path so `black_cat_worker` imports.
_WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from black_cat_worker import sku as S  # noqa: E402
from black_cat_worker.grouping import DecodedPhoto, group_photos  # noqa: E402
from black_cat_worker import browser_form as A  # noqa: E402
from black_cat_worker import tag_ocr as T  # noqa: E402
from black_cat_worker import normalize as N  # noqa: E402
from black_cat_worker import evidence as E  # noqa: E402
from black_cat_worker import props as P  # noqa: E402
from black_cat_worker.ocr_engine import OcrLine, extract_lines  # noqa: E402

_failures = []


def check(name, cond):
    status = "ok" if cond else "FAIL"
    if not cond:
        _failures.append(name)
    print(f"  [{status}] {name}")


def test_normalize():
    print("normalize / QR clean path:")
    check("plain 6-digit", S.normalize("000001") == "000001")
    check("BC- prefix", S.normalize("BC-000005") == "000005")
    check("SKU: prefix", S.normalize("SKU: 000001") == "000001")
    check("SKU: BC- prefix", S.normalize("SKU: BC-000042") == "000042")
    check("leading zeros preserved", S.normalize("000010") == "000010")
    check("spaces tolerated", S.normalize("00 00 01") == "000001")
    check("wrong length rejected", S.normalize("12345") is None)
    check("non-sku rejected", S.normalize("Fanta") is None)
    check("empty rejected", S.normalize("") is None)


def test_coerce():
    print("coerce_to_sku / OCR fallback path:")
    check("O->0 confusion", S.coerce_to_sku("BC-OOOOO5") == "000005")
    check("I/l->1 confusion", S.coerce_to_sku("BC-OOOO1l") == "000011")
    check("S->5, B->8", S.coerce_to_sku("BC-OOOSB8"[:9]) is not None)
    check("garment text rejected", S.coerce_to_sku("FANTA") is None)
    check("exact digits", S.coerce_to_sku("000007") == "000007")


def test_levenshtein():
    print("levenshtein:")
    check("identical", S.levenshtein("000001", "000001") == 0)
    check("one sub", S.levenshtein("000001", "000002") == 1)
    check("empty", S.levenshtein("", "abc") == 3)


def _p(name, sku=None):
    return DecodedPhoto(path=f"/x/{name}", filename=name, sku=sku,
                        decoded_raw=("BC-" + sku) if sku else None)


def test_grouping_happy():
    print("grouping / happy path (two items):")
    photos = [
        _p("a1.jpg"), _p("a2.jpg"), _p("a_marker.jpg", "000001"),
        _p("b1.jpg"), _p("b2.jpg"), _p("b3.jpg"), _p("b_marker.jpg", "000002"),
    ]
    r = group_photos(photos)
    check("2 items", len(r.items) == 2)
    check("item1 sku", r.items[0].sku == "000001")
    check("item1 has 2 members", len(r.items[0].members) == 2)
    check("item2 has 3 members", len(r.items[1].members) == 3)
    check("no problems", len(r.problems) == 0)
    check("nothing needs review", len(r.needs_review) == 0)


def test_grouping_unterminated():
    print("grouping / unterminated trailing photos become a SHELL item:")
    photos = [_p("a1.jpg"), _p("m.jpg", "000001"), _p("orphan.jpg")]
    r = group_photos(photos)
    check("2 items (real + shell)", len(r.items) == 2)
    shell = r.items[1]
    check("shell is a placeholder with no sku yet", shell.placeholder and shell.sku == "")
    check("shell holds the orphan photo", [m.filename for m in shell.members] == ["orphan.jpg"])
    check("shell has no marker", shell.marker is None)
    check("shell confidence is low", shell.confidence == "low")
    check("UNTERMINATED_GROUP flagged",
          any(p.type == "UNTERMINATED_GROUP" for p in r.problems))
    check("nothing dumped to needs-review", len(r.needs_review) == 0)


def test_grouping_marker_no_photos():
    print("grouping / marker with no preceding photos keeps its number (empty item):")
    photos = [_p("m1.jpg", "000001"), _p("a1.jpg"), _p("m2.jpg", "000002")]
    r = group_photos(photos)
    check("2 items (000001 kept, empty)", [it.sku for it in r.items] == ["000001", "000002"]
          and len(r.items[0].members) == 0)
    check("MARKER_NO_PHOTOS flagged",
          any(p.type == "MARKER_NO_PHOTOS" for p in r.problems))
    # A SECOND shot of the same sticker (empty group, sku seen again later) is skipped.
    photos = [_p("s1.jpg", "000001"), _p("b1.jpg"), _p("s2.jpg", "000001")]
    r = group_photos(photos)
    check("repeat sticker shot doesn't duplicate the item",
          [it.sku for it in r.items] == ["000001"] and len(r.items[0].members) == 1)


def test_grouping_ambiguous():
    print("grouping / duplicate sku in one batch:")
    photos = [_p("a.jpg"), _p("m1.jpg", "000001"), _p("b.jpg"), _p("m2.jpg", "000001")]
    r = group_photos(photos)
    check("AMBIGUOUS_MARKER flagged",
          any(p.type == "AMBIGUOUS_MARKER" for p in r.problems))


def test_missing_sku_gap():
    print("robustness / missing-sku gap (deleted sticker):")
    photos = [
        _p("a1.jpg"), _p("m1.jpg", "000001"),
        _p("b1.jpg"), _p("m2.jpg", "000002"),
        _p("c1.jpg"), _p("c2.jpg"), _p("m4.jpg", "000004"),  # 000003 marker gone
    ]
    r = group_photos(photos)
    miss = [p for p in r.problems if p.type == "MISSING_SKU"]
    check("3 items still grouped", len(r.items) == 3)
    check("MISSING_SKU 000003 flagged", any(p.sku == "000003" for p in miss))


def test_merged_group_bloat():
    print("robustness / bloated group (no time data) lowers CONFIDENCE, no problem row:")
    photos = ([_p(f"x{i}.jpg") for i in range(12)] + [_p("m7.jpg", "000007")]
              + [_p("y1.jpg"), _p("m8.jpg", "000008")])
    r = group_photos(photos)
    it7 = next(it for it in r.items if it.sku == "000007")
    check("12-photo item drops to medium confidence", it7.confidence == "medium")
    check("bloat reason recorded", any("12 photos" in x for x in it7.reasons))
    check("bloat alone emits NO problem row (was a false-positive source)",
          not any(p.type in ("MERGED_GROUP_SUSPECTED", "GROUPING_UNCERTAIN") for p in r.problems))


def _timed_photo(name, sku=None, ts=None):
    """A photo with an EXIF timestamp, for the boundary-calibrated gap checks."""
    p = _p(name, sku)
    p.ts = ts
    return p


def _timed_batch(skus, dead_idx=None, intra=19.0, inter=182.0, per_item=5, t0=1_700_000_000.0):
    """A realistic shoot: per_item photos then a sticker, repeated. `dead_idx`
    makes that item's sticker unreadable AND undetectable (heavy glare), which
    is what merges its photos into the following item."""
    photos, t, n = [], t0, 0
    for i, sku in enumerate(skus):
        for _ in range(per_item):
            n += 1
            photos.append(_timed_photo(f"IMG_{n:04d}.jpg", None, t)); t += intra
        n += 1
        photos.append(_timed_photo(f"IMG_{n:04d}.jpg", None if i == dead_idx else sku, t))
        t += inter
    return photos


def test_bloat_threshold_tracks_the_batch():
    print("robustness / bloat threshold scales with the batch median:")
    # Untimed, so ONLY the bloat signal can fire. Four 6-photo items (this
    # operator's real median) plus one 12-photo merge. Old threshold was
    # max(10, 6 * 2.5) = 15, so 12 was invisible; now it is max(10, 12) = 12.
    def item(n, sku):
        return [_p(f"{sku}_{i}.jpg") for i in range(n)] + [_p(f"m{sku}.jpg", sku)]
    photos = item(12, "000001") + item(6, "000002") + item(6, "000003") + item(6, "000004")
    r = group_photos(photos)
    merged = next(it for it in r.items if it.sku == "000001")
    check("12-photo merge against a median of 6 is flagged", merged.confidence == "medium")
    check("bloat reason recorded", any("12 photos" in x for x in merged.reasons))

    # The largest item seen in the real 103-item inventory is 11 photos. With a
    # median of 6 the threshold is 12, so an honest 11 must stay clean.
    photos = item(11, "000001") + item(6, "000002") + item(6, "000003") + item(6, "000004")
    r = group_photos(photos)
    big = next(it for it in r.items if it.sku == "000001")
    check("an honest 11-photo item is NOT flagged", big.confidence == "high")


def test_gap_threshold_calibrates_to_batch_boundaries():
    print("robustness / a fast shoot's own boundaries set the merge threshold:")
    # 19s between shots, 60s between items. med_gap * 6 = 114s sails over the
    # 60s pause left behind by the merge; half the observed boundary catches it.
    photos = _timed_batch(["000001", "000002", "000003", "000004"],
                          dead_idx=0, intra=19.0, inter=60.0)
    r = group_photos(photos)
    merged = max(r.items, key=lambda it: len(it.members))
    check("first item's photos merged into the second", len(merged.members) == 11)
    check("merge on a fast shoot is flagged", merged.confidence != "high")
    check("reason names the internal pause",
          any("pause inside this group" in x for x in merged.reasons))


def test_normal_shoot_stays_high_confidence():
    print("robustness / an ordinary shoot is NOT flagged by the new thresholds:")
    # The operator's measured rhythm: 19s within an item, 182s between items.
    photos = _timed_batch(["000001", "000002", "000003", "000004"])
    r = group_photos(photos)
    check("all 4 items grouped", len(r.items) == 4)
    check("no item loses confidence", all(it.confidence == "high" for it in r.items))
    check("no problem rows", not r.problems)


def test_long_pause_inside_one_item_is_not_a_problem_row():
    print("robustness / a long in-item pause still only lowers confidence:")
    photos = _timed_batch(["000001", "000002", "000003"], intra=19.0, inter=182.0)
    photos[2].ts += 400.0   # a 400s pause inside item 1, no sticker missing
    for ph in photos[3:]:
        ph.ts += 400.0
    r = group_photos(photos)
    check("still 3 items", len(r.items) == 3)
    check("no MISSING_SKU invented",
          not any(p.type == "MISSING_SKU" for p in r.problems))


def test_merged_item_confidence_drops_even_uncorroborated():
    print("robustness / the item named by MISSING_SKU never stays high confidence:")
    photos = [
        _p("a1.jpg"), _p("m1.jpg", "000001"),
        _p("b1.jpg"), _p("m2.jpg", "000002"),
        _p("c1.jpg"), _p("c2.jpg"), _p("m4.jpg", "000004"),  # 000003 sticker gone
    ]
    r = group_photos(photos)
    after = next(it for it in r.items if it.sku == "000004")
    check("MISSING_SKU 000003 raised", any(p.sku == "000003" for p in r.problems))
    check("the item it may have merged into is no longer high confidence",
          after.confidence != "high")
    check("reason explains why", any("000003" in x for x in after.reasons))


def test_decode_engine_status_reports_missing_deps():
    print("robustness / a missing decode dependency is reported, not swallowed:")
    from black_cat_worker.decode import Decoder

    # Every engine imports lazily and swallows ImportError, so a broken install
    # silently yields zero markers. engine_status() is what makes that loud.
    d = Decoder({"skuPrefixes": ["BC-"], "skuLength": 6, "ocrEnabled": True})
    d._cv2, d._pyzbar, d._paddle = False, False, False   # simulate a bare interpreter
    st = d.engine_status()
    check("missing OpenCV is reported", st["qr_opencv"] is False)
    check("missing pyzbar is reported", st["qr_pyzbar"] is False)
    check("missing PaddleOCR is reported", st["ocr_paddle"] is False)

    # OCR turned off is not the same as OCR broken; it must not raise an alarm.
    d2 = Decoder({"skuPrefixes": ["BC-"], "skuLength": 6, "ocrEnabled": False})
    d2._cv2, d2._pyzbar = False, False
    check("OCR disabled reports None, not False", d2.engine_status()["ocr_paddle"] is None)

    # A decoder with no engines still must not throw — degrade, but be reported.
    check("decode still degrades safely", d.decode("nonexistent.jpg").sku is None)


def test_delete_garment_photo_is_safe():
    print("robustness / deleting a bad GARMENT photo does not break grouping:")
    full = [_p("p1.jpg"), _p("p2.jpg"), _p("p3.jpg"), _p("p4.jpg"), _p("m.jpg", "000001")]
    deleted = [_p("p1.jpg"), _p("p2.jpg"), _p("p4.jpg"), _p("m.jpg", "000001")]  # p3 deleted
    r1, r2 = group_photos(full), group_photos(deleted)
    check("still exactly 1 item", len(r2.items) == 1 and r2.items[0].sku == "000001")
    check("member count drops 4 -> 3", len(r1.items[0].members) == 4 and len(r2.items[0].members) == 3)
    check("no spurious problems from a deleted garment photo", len(r2.problems) == 0)


# ---------------------------------------------------------------------------
# assist_upload pure helpers (parcel/shipping parsing, size/color/sleeve maps)
# ---------------------------------------------------------------------------


def test_parse_capacity_oz():
    print("assist / _parse_capacity_oz (option weight -> oz):")
    # oz stays as-is; whole + decimal both parse.
    check("plain oz", A._parse_capacity_oz("holds 35 oz") == 35.0)
    check("decimal oz", A._parse_capacity_oz("1.5 oz") == 1.5)
    check("ounces word", A._parse_capacity_oz("10 ounces") == 10.0)
    # lb / pounds -> *16.
    check("lb -> *16", A._parse_capacity_oz("Small (up to 1 lb)") == 16.0)
    check("pounds word -> *16", A._parse_capacity_oz("2 pounds") == 32.0)
    # kg -> *35.274 ; grams / g -> /28.3495.
    check("kg -> *35.274", A._parse_capacity_oz("1 kg") == 35.274)
    check("grams word -> /28.3495", abs(A._parse_capacity_oz("500 grams") - 500 / 28.3495) < 1e-9)
    check("bare g -> /28.3495", abs(A._parse_capacity_oz("500 g") - 500 / 28.3495) < 1e-9)
    # First numeric+unit match wins (lb here, before the trailing oz).
    check("first unit wins (3 lb 4 oz -> 48)", A._parse_capacity_oz("3 lb 4 oz") == 48.0)
    # No usable number/unit -> None (incl. empty / None / unit glued without boundary).
    check("no unit -> None", A._parse_capacity_oz("no weight") is None)
    check("glued 16ozs has no \\b -> None", A._parse_capacity_oz("16ozs") is None)
    check("empty -> None", A._parse_capacity_oz("") is None)
    check("None -> None", A._parse_capacity_oz(None) is None)
    # ODDITY (B-cap1): a LEADING-dot decimal loses its dot — '.5 oz' matches the bare
    # '5' (regex requires \d+ before the optional decimal) and returns 5.0, not 0.5.
    check("leading-dot decimal mis-parses to 5.0", A._parse_capacity_oz(".5 oz") == 5.0)




























# ---------------------------------------------------------------------------
# HARDENING PASS — adversarial gap-fill (added 2026-06-30).
# Every assertion below was confirmed against the live functions before committing.
# ---------------------------------------------------------------------------


def test_normalize_edge():
    print("normalize / edge cases (HARDENING):")
    # Case-insensitivity on prefixes.
    check("lowercase bc- prefix", S.normalize("bc-000007") == "000007")
    check("SKU without colon", S.normalize("SKU 000001") == "000001")
    check("lowercase 'sku:' prefix", S.normalize("sku:000001") == "000001")
    # Whitespace-only is rejected (str truthy but strips to nothing usable).
    check("whitespace-only rejected", S.normalize("   ") is None)
    # Any non-digit separators are stripped before the length check.
    check("dash-separated digits tolerated", S.normalize("0-0-0-0-0-1") == "000001")
    check("tab/newline separators tolerated", S.normalize("00\t00\n01") == "000001")
    check("fully padded with outer spaces", S.normalize("  000001  ") == "000001")
    # 7 digits is the wrong length -> rejected (no truncation).
    check("7 digits rejected", S.normalize("0000012") is None)
    # Custom length parameter works.
    check("custom length=4", S.normalize("0012", length=4) == "0012")
    # BC- prefix + too-few digits is rejected.
    check("BC- with 5 digits rejected", S.normalize("BC-00001") is None)
    # ODDITY (B-norm1): only ONE prefix is stripped, but the digit-strip fallback
    # still rescues a doubled prefix because the residual is exactly 6 digits.
    check("doubled BC- prefix still parses via digit-strip",
          S.normalize("BC-BC-000001") == "000001")
    # SKU: + spaced digits goes through the same digit-strip fallback.
    check("'SKU:' + spaced digits", S.normalize("SKU: 00 00 01") == "000001")
    # BC- + 7 digits: prefix stripped leaves 7 digits -> wrong length -> None.
    check("BC- + 7 digits rejected", S.normalize("BC-0000012") is None)


def test_coerce_edge():
    print("coerce_to_sku / edge cases (HARDENING):")
    # Input is uppercased FIRST, so lowercase 'o' is also mapped to 0.
    check("lowercase o's coerce to zeros", S.coerce_to_sku("oooooo") == "000000")
    check("all-O coerces to 000000", S.coerce_to_sku("OOOOOO") == "000000")
    # Over-capture: keep the LAST `length` digits.
    check("7 pure digits -> last 6", S.coerce_to_sku("1234567") == "234567")
    check("letter + 6 digits -> trailing 6", S.coerce_to_sku("BC-X000001") == "000001")
    # Confusion map coverage not exercised elsewhere.
    check("Z->2, G->6", S.coerce_to_sku("ZGOOOO") == "260000")
    check("A->4", S.coerce_to_sku("AOOOOO") == "400000")
    check("pipe->1", S.coerce_to_sku("|OOOOO") == "100000")
    check("Q->0, D->0", S.coerce_to_sku("QDOOOO") == "000000")
    # Whitespace-only and too-short both reject.
    check("whitespace-only rejected", S.coerce_to_sku("   ") is None)
    check("5 digits too short", S.coerce_to_sku("00001") is None)
    # 'FANTAS' maps to '445' (A->4, A->4, S->5) -> len 3 -> None (different reject
    # mechanism than the 'FANTA' case already tested).
    check("garment text 'FANTAS' rejected via short map", S.coerce_to_sku("FANTAS") is None)


def test_is_valid_sku():
    print("is_valid_sku (HARDENING — was entirely untested):")
    check("valid 6-digit", S.is_valid_sku("000001") is True)
    check("None -> False", S.is_valid_sku(None) is False)
    check("empty -> False", S.is_valid_sku("") is False)
    check("5 digits -> False", S.is_valid_sku("00001") is False)
    check("7 digits -> False", S.is_valid_sku("0000012") is False)
    check("contains letter -> False", S.is_valid_sku("00000a") is False)
    check("custom length=4 accepts 4 digits", S.is_valid_sku("0012", length=4) is True)


def test_levenshtein_edge():
    print("levenshtein / edge cases (HARDENING):")
    check("both empty -> 0", S.levenshtein("", "") == 0)
    check("pure insertion", S.levenshtein("abc", "abcd") == 1)
    check("pure deletion", S.levenshtein("abcd", "abc") == 1)
    check("transposition costs 2", S.levenshtein("ab", "ba") == 2)
    check("a empty -> len(b)", S.levenshtein("", "x") == 1)
    check("b empty -> len(a)", S.levenshtein("x", "") == 1)


def test_grouping_edge():
    print("grouping / edge cases (HARDENING):")
    # Empty batch: no items, no problems, no review.
    r = group_photos([])
    check("empty batch is clean", len(r.items) == 0 and len(r.problems) == 0
          and len(r.needs_review) == 0)
    # Single terminated item: anomaly detection needs >=2 items, so none runs.
    r = group_photos([_p("a.jpg"), _p("m.jpg", "000001")])
    check("single item -> no problems", len(r.items) == 1 and len(r.problems) == 0)
    # A non-numeric SKU marker does not crash gap detection (int() ValueError caught);
    # with only one *numeric* sku, the gap branch (needs >=2 nums) is skipped.
    r = group_photos([_p("a.jpg"), _p("m1.jpg", "ABCDEF"),
                      _p("b.jpg"), _p("m2.jpg", "000002")])
    check("non-numeric sku does not crash", len(r.items) == 2)
    check("no MISSING_SKU with <2 numeric skus",
          not any(p.type == "MISSING_SKU" for p in r.problems))
    # Two consecutive missing markers (001 -> 004) -> ONE problem for the RANGE
    # 002-003 (per-number rows are what flooded the 50-item run with 99,990 entries).
    r = group_photos([_p("a.jpg"), _p("m1.jpg", "000001"),
                      _p("b.jpg"), _p("m4.jpg", "000004")])
    miss = [p for p in r.problems if p.type == "MISSING_SKU"]
    check("gap 001->004 is ONE range problem", len(miss) == 1)
    check("range message names 000002-000003", "000002-000003" in miss[0].message)
    # AMBIGUOUS_MARKER still APPENDS a second item with the duplicate sku (it doesn't drop it).
    r = group_photos([_p("a.jpg"), _p("m1.jpg", "000001"),
                      _p("b.jpg"), _p("m2.jpg", "000001")])
    check("ambiguous still yields 2 items", len(r.items) == 2)
    check("both items carry same dup sku", [it.sku for it in r.items] == ["000001", "000001"])
    # original_qr_value + marker passthrough onto the GroupedItem.
    r = group_photos([_p("a.jpg"), _p("m1.jpg", "000001")])
    check("original_qr_value carried", r.items[0].original_qr_value == "BC-000001")
    check("marker photo carried", r.items[0].marker.filename == "m1.jpg")
    check("is_marker property reflects sku", r.items[0].marker.is_marker is True)


def test_grouping_bloat_boundary():
    print("grouping / bloat threshold boundary (HARDENING):")
    # Floor is now 10 (an honest 8-photo item was a routine false positive).
    # item1=10 photos, item2=1 -> lower median 1, threshold max(10, 2)=10; inclusive.
    photos = ([_p(f"x{i}.jpg") for i in range(10)] + [_p("m1.jpg", "000001")]
              + [_p("y0.jpg"), _p("m2.jpg", "000002")])
    r = group_photos(photos)
    it1 = next(it for it in r.items if it.sku == "000001")
    check("10-photo item at inclusive threshold drops to medium", it1.confidence == "medium")
    # item1=9 photos (just under the floor), median small -> full confidence.
    photos = ([_p(f"x{i}.jpg") for i in range(9)] + [_p("m1.jpg", "000001")]
              + [_p("y0.jpg"), _p("m2.jpg", "000002")])
    r = group_photos(photos)
    it1 = next(it for it in r.items if it.sku == "000001")
    check("9-photo item below floor keeps high confidence", it1.confidence == "high")


def test_parse_capacity_oz_edge():
    print("assist / _parse_capacity_oz edge cases (HARDENING):")
    # Case-insensitive unit (input is lowercased).
    check("uppercase OZ", A._parse_capacity_oz("35 OZ") == 35.0)
    # The (\d+) capture drops a leading minus -> negative magnitude is lost.
    check("ODDITY: leading minus dropped (-35 oz -> 35)",
          A._parse_capacity_oz("-35 oz") == 35.0)
    # Glued number+unit DOES match when the unit token is a full alternation member
    # ending on a \b ('grams'); contrast '16ozs' (already tested) which fails.
    check("glued '500grams' parses", abs(A._parse_capacity_oz("500grams") - 500 / 28.3495) < 1e-9)
    check("'16 ozs' fails on \\b (ozs != oz\\b)", A._parse_capacity_oz("16 ozs") is None)
    # 'kilogram' is NOT recognized (only 'kg' with a trailing \b).
    check("'2 kilogram' not recognized", A._parse_capacity_oz("2 kilogram") is None)
    # 'mg' is not a unit; 'm' breaks the 'g' boundary.
    check("'500 mg' not recognized", A._parse_capacity_oz("500 mg") is None)
    # kg with a decimal.
    check("'2.5 kg' -> *35.274", abs(A._parse_capacity_oz("2.5 kg") - 2.5 * 35.274) < 1e-9)
    # singular pound / ounce.
    check("'1 pound' -> 16", A._parse_capacity_oz("1 pound") == 16.0)
    check("'1 ounce' -> 1", A._parse_capacity_oz("1 ounce") == 1.0)
    # zero is a real value, not falsy-rejected.
    check("'0 oz' -> 0.0", A._parse_capacity_oz("0 oz") == 0.0)
    # unit before the number doesn't match (regex wants number THEN unit).
    check("'oz 16' (unit-first) -> None", A._parse_capacity_oz("oz 16") is None)
    check("whitespace-only -> None", A._parse_capacity_oz("   ") is None)


























# ---------------------------------------------------------------------------
# v1.2 grouping-reliability tests (post 50-item shakedown regressions)
# ---------------------------------------------------------------------------

def _pt(name, t, sku=None, method=None, pattern=False):
    """Photo with an EXIF-style timestamp t (epoch seconds)."""
    p = DecodedPhoto(path=f"/x/{name}", filename=name, sku=sku,
                     decoded_raw=("BC-" + sku) if sku else None,
                     decode_method=method or ("qr-opencv" if sku else None))
    p.ts = float(t)
    p.qr_pattern_detected = pattern or (sku is not None)
    return p


def test_unreadable_sticker_recovers_number():
    print("v1.3 / unreadable sticker + missing number -> item AUTO-NUMBERED (48->49 case):")
    # Item 48's sticker was photographed but never decoded. The number 48 is
    # missing between 47 and 49, and 49's group holds one run of sticker-looking
    # photos -> split there and name it 000048 automatically.
    photos = [
        _pt("a1.jpg", 0), _pt("a2.jpg", 5), _pt("a_m.jpg", 10, "000047"),
        _pt("b1.jpg", 100), _pt("b2.jpg", 105), _pt("b3.jpg", 110),
        _pt("b_dead_sticker.jpg", 115, pattern=True),          # 48's dead sticker
        _pt("c1.jpg", 220), _pt("c2.jpg", 226), _pt("c_m.jpg", 232, "000049"),
    ]
    r = group_photos(photos)
    check("3 items (47, 48, 49)", [it.sku for it in r.items] == ["000047", "000048", "000049"])
    it48 = r.items[1]
    check("48 holds exactly its own photos", [m.filename for m in it48.members] == ["b1.jpg", "b2.jpg", "b3.jpg"])
    check("48's marker is the dead sticker", it48.marker is not None
          and it48.marker.filename == "b_dead_sticker.jpg")
    check("48 is a real numbered item, not a FIX shell", not it48.placeholder and it48.closed_by == "recovered-sticker")
    check("48 flagged low for verification", it48.confidence == "low")
    check("49 did NOT absorb 48's photos",
          [m.filename for m in r.items[2].members] == ["c1.jpg", "c2.jpg"])
    check("RECOVERED_SKU problem raised",
          any(p.type == "RECOVERED_SKU" and p.sku == "000048" for p in r.problems))
    check("no MISSING_SKU (the number recovered itself)",
          not any(p.type == "MISSING_SKU" for p in r.problems))


def test_qr_false_positive_never_splits():
    print("v1.3 / QR-ish garment photo alone NEVER splits an item (the 12-shells bug):")
    # Graphic tees false-positive OpenCV's QR detector constantly. With no
    # missing sequence number there is no corroboration -> no split, no shell.
    photos = [
        _pt("a1.jpg", 0), _pt("a_graphic.jpg", 6, pattern=True), _pt("a2.jpg", 12),
        _pt("a_m.jpg", 18, "000001"),
        _pt("b1.jpg", 300), _pt("b_graphic.jpg", 306, pattern=True),
        _pt("b_m.jpg", 900, "000002"),  # even with a long pause after the QR-ish photo
    ]
    r = group_photos(photos)
    check("exactly 2 items, no shells", [it.sku for it in r.items] == ["000001", "000002"]
          and not any(it.placeholder for it in r.items))
    check("QR-ish photos stayed with their items",
          any(m.filename == "a_graphic.jpg" for m in r.items[0].members)
          and any(m.filename == "b_graphic.jpg" for m in r.items[1].members))
    check("QR-ish photos still count as listing photos",
          not any(m.exclude_from_listing for it in r.items for m in it.members))
    check("no problems at all", len(r.problems) == 0)


def test_ocr_outlier_demoted():
    print("v1.3 / OCR-misread SKU outlier is demoted to an ordinary photo:")
    photos = []
    t = 0.0
    for n in (1, 2, 3, 4, 5):
        photos += [_pt(f"g{n}.jpg", t), _pt(f"m{n}.jpg", t + 6, f"{n:06d}")]
        t += 100
    # Garment text misOCR'd as 100040 (out of the 1-5 QR range), then batch ends.
    photos += [_pt("g6.jpg", t), _pt("m6.jpg", t + 6, "100040", method="ocr", pattern=True)]
    r = group_photos(photos)
    check("no item named 100040", not any(it.sku == "100040" for it in r.items))
    check("trailing photos become ONE end-of-batch shell",
          sum(1 for it in r.items if it.placeholder) == 1
          and [m.filename for m in r.items[-1].members] == ["g6.jpg", "m6.jpg"])
    check("OCR_SKU_OUTLIER problem raised", any(p.type == "OCR_SKU_OUTLIER" for p in r.problems))
    n_missing = sum(1 for p in r.problems if p.type == "MISSING_SKU")
    check("NO missing-sku flood (was 99,990 rows)", n_missing == 0)


def test_time_gap_is_note_only():
    print("v1.3 / big time gap = confidence note, NOT a problem row; missing number still warns:")
    photos = [
        _pt("a1.jpg", 0), _pt("a2.jpg", 5), _pt("a_m.jpg", 10, "000001"),
        # 000002's sticker missing entirely (never photographed, no QR-ish photo):
        # b* and c* merge; the pause lowers confidence, the missing number warns.
        _pt("b1.jpg", 100), _pt("b2.jpg", 106),
        _pt("c1.jpg", 506), _pt("c2.jpg", 511), _pt("c_m.jpg", 517, "000003"),
        _pt("d1.jpg", 600), _pt("d_m.jpg", 606, "000004"),
    ]
    r = group_photos(photos)
    it3 = next(it for it in r.items if it.sku == "000003")
    check("merged item confidence lowered", it3.confidence in ("medium", "low"))
    check("gap recorded as a reason", any("pause" in x for x in it3.reasons))
    check("no GROUPING_UNCERTAIN problem rows",
          not any(p.type == "GROUPING_UNCERTAIN" for p in r.problems))
    check("MISSING_SKU 000002 still raised (corroborated by the gap)",
          any(p.type == "MISSING_SKU" and p.sku == "000002" for p in r.problems))
    check("corroboration drops the merged item to low", it3.confidence == "low")


def test_empty_marker_keeps_number():
    print("v1.3 / marker with no photos keeps its number as an EMPTY item:")
    photos = [_pt("m1.jpg", 0, "000001"), _pt("a1.jpg", 60), _pt("m2.jpg", 66, "000002")]
    r = group_photos(photos)
    check("both numbers exist", [it.sku for it in r.items] == ["000001", "000002"])
    check("000001 is empty (photos went to 000002)", len(r.items[0].members) == 0)
    check("MARKER_NO_PHOTOS flagged", any(p.type == "MARKER_NO_PHOTOS" for p in r.problems))


def test_gap_flood_suppressed():
    print("v1.2 / non-contiguous batch suppresses per-number gap spam:")
    # SKUs 10, 20, 30, 40 — clearly not one contiguous sticker range.
    photos = []
    t = 0.0
    for n in (10, 20, 30, 40):
        photos += [_pt(f"g{n}.jpg", t), _pt(f"m{n}.jpg", t + 5, f"{n:06d}")]
        t += 90
    r = group_photos(photos)
    check("zero MISSING_SKU rows", not any(p.type == "MISSING_SKU" for p in r.problems))
    check("one summary info line", sum(1 for p in r.problems if p.type == "SKU_SEQUENCE_INFO") == 1)


def test_coerce_noise_gate():
    print("v1.3 / coerce noise gate — garment text can never become a SKU:")
    # The two REAL misreads from the live runs: shirt prints that previously
    # coerced into phantom SKUs 541016 and 100040.
    check("'SAW CLOTHING' rejected", S.coerce_to_sku("SAW CLOTHING") is None)
    check("'IF FO FOTOADUE' rejected", S.coerce_to_sku("IF FO FOTOADUE") is None)
    # Genuine sticker misreads (confusable letters only) still correct.
    check("sticker misread 'OOOO4B' still coerces", S.coerce_to_sku("OOOO4B") == "000048")
    check("one stray letter tolerated", S.coerce_to_sku("BC-X000001") == "000001")
    check("prefixed digits with spaces fine", S.coerce_to_sku("SKU: 00 00 48") == "000048")


def test_grouping_log_written():
    print("v1.2 / per-item grouping audit log:")
    photos = [_pt("a1.jpg", 0), _pt("a2.jpg", 5), _pt("a_m.jpg", 10, "000001")]
    r = group_photos(photos)
    it = r.items[0]
    check("log has one entry per photo", len(it.log) == 3)
    check("roles recorded", [e["role"] for e in it.log] == ["photo", "photo", "sku-sticker"])
    check("gaps recorded", it.log[1]["gapBeforeSec"] == 5.0)
    check("closedBy recorded", it.closed_by == "qr-marker")


def test_fifty_item_batch_no_merges():
    print("v1.2 / 50-item batch regression — no incorrect merges:")
    import random
    rnd = random.Random(42)
    photos = []
    t = 0.0
    expected = {}
    for n in range(1, 51):
        sku = f"{n:06d}"
        k = rnd.randint(2, 6)
        names = []
        for j in range(k):
            names.append(f"IMG_{n:03d}_{j}.jpg")
            photos.append(_pt(names[-1], t))
            t += rnd.uniform(3, 9)
        photos.append(_pt(f"IMG_{n:03d}_m.jpg", t, sku))
        t += rnd.uniform(30, 120)  # walk to the next garment
        expected[sku] = names
    r = group_photos(photos)
    check("50 items", len(r.items) == 50)
    ok_members = all([m.filename for m in it.members] == expected[it.sku] for it in r.items)
    check("every item has exactly its own photos", ok_members)
    check("no problems on a clean batch", len(r.problems) == 0)
    check("all items high confidence", all(it.confidence == "high" for it in r.items))

    # Same batch with three failure injections: #17 sticker dead (pattern only),
    # #33 sticker misOCR'd as 200123, #50 sticker photo missing entirely.
    photos2 = []
    t = 0.0
    for n in range(1, 51):
        sku = f"{n:06d}"
        k = rnd.randint(2, 6)
        for j in range(k):
            photos2.append(_pt(f"IMG_{n:03d}_{j}.jpg", t))
            t += rnd.uniform(3, 9)
        if n == 17:
            photos2.append(_pt(f"IMG_{n:03d}_m.jpg", t, pattern=True))  # dead sticker
        elif n == 33:
            photos2.append(_pt(f"IMG_{n:03d}_m.jpg", t, "200123", method="ocr", pattern=True))
        elif n != 50:
            photos2.append(_pt(f"IMG_{n:03d}_m.jpg", t, sku))
        t += rnd.uniform(30, 120)
    r2 = group_photos(photos2)
    check("still 50 items (47 decoded + recovered 17 & 33 + 1 end shell)",
          len(r2.items) == 50)
    shells = [it for it in r2.items if it.placeholder]
    check("only ONE shell (item 50's trailing photos)", len(shells) == 1)
    check("17 and 33 recovered with their real numbers",
          any(it.sku == "000017" and it.closed_by == "recovered-sticker" for it in r2.items)
          and any(it.sku == "000033" and it.closed_by == "recovered-sticker" for it in r2.items))
    check("no bogus 200123 item", not any(it.sku == "200123" for it in r2.items))
    # THE core guarantee: no item contains another item's photos (incl. recovered ones).
    ok = True
    for it in r2.items:
        if it.placeholder or not it.sku:
            continue
        pref = f"IMG_{int(it.sku):03d}_"
        if any(not m.filename.startswith(pref) for m in it.members):
            ok = False
    check("no item absorbed another item's photos", ok)
    check("2 RECOVERED_SKU problems (17, 33)",
          sum(1 for p in r2.problems if p.type == "RECOVERED_SKU") == 2)
    check("zero MISSING_SKU rows (numbers updated themselves)",
          sum(1 for p in r2.problems if p.type == "MISSING_SKU") == 0)


# ---------------------------------------------------------------------------
# Vision enrichment (2026-08-05 blank-batch fix + accessories expansion)
# ---------------------------------------------------------------------------

def test_vision_error_classification():
    print("vision: endpoint errors are precise and never mislabeled 'unreachable':")
    import io as _io
    import urllib.error
    from black_cat_worker import vision as V

    def http_err(code, body):
        return urllib.error.HTTPError(
            "http://127.0.0.1:1235/v1/chat/completions", code, "err", {},
            _io.BytesIO(body.encode()))

    msg = V._describe_http_error(http_err(500,
        '{"error":{"code":500,"message":"image input is not supported - hint: provide the mmproj","type":"server_error"}}'))
    check("500 no-mmproj -> NO VISION SUPPORT", "NO VISION SUPPORT" in msg)
    check("500 no-mmproj includes server detail", "image input is not supported" in msg)
    msg404 = V._describe_http_error(http_err(404, '{"error":"model not found"}'))
    check("404 mentions model loading", "model" in msg404.lower() and "404" in msg404)
    plain = V._describe_http_error(http_err(503, "busy"))
    check("plain-text body survives", "503" in plain and "busy" in plain)


def test_vision_short_circuit_and_isolation():
    print("vision: dead endpoint short-circuits but NEVER kills the batch:")
    import urllib.error
    from black_cat_worker import vision as V

    calls = {"n": 0}

    class Enricher(V.VisionEnricher):
        def _pick_images(self, metas):
            return ["fake.jpg"]
        def _encode(self, path, max_side=1024):
            return "aW1n"
        def _call(self, images):
            calls["n"] += 1
            raise urllib.error.URLError("connection refused")

    e = Enricher({"visionEnabled": True})
    r1 = e.enrich("000001", [{}])
    r2 = e.enrich("000002", [{}])
    r3 = e.enrich("000003", [{}])
    check("each failed item carries an error", all("error" in r for r in (r1, r2, r3)))
    check("errors are per-item, batch continues", all(isinstance(r, dict) for r in (r1, r2, r3)))
    check("short-circuit after 2 endpoint failures", calls["n"] == 2)
    check("skipped items reuse the SAME reason", r3["error"] == r2["error"])
    check("unreachable message names the URL", "127.0.0.1" in r1["error"])


def test_vision_success_resets_failures_and_maps_category():
    print("vision: category + accessory itemType mapping:")
    from black_cat_worker import vision as V

    class Enricher(V.VisionEnricher):
        def _pick_images(self, metas):
            return ["fake.jpg"]
        def _encode(self, path, max_side=1024):
            return "aW1n"
        def _call(self, images):
            return ('{"category":"bag","itemType":"crossbody bag","primaryColor":"brown",'
                    '"colorPattern":"solid","size":null,"brand":"Coach","confidence":0.9}')

    e = Enricher({"visionEnabled": True})
    r = e.enrich("000001", [{}])
    f = r.get("fields", {})
    check("itemType is the SPECIFIC subtype", f.get("itemType") == "Crossbody Bag")
    check("category canonicalized to 'Bag'", f.get("category") == "Bag")
    check("category rides aiFields", "category" in r.get("aiFields", []))
    check("brand kept", f.get("brand") == "Coach")
    check("no error on success", "error" not in r)


def test_vision_parse_and_null_size():
    print("vision: accessories with null size stay null (no junk):")
    from black_cat_worker import vision as V
    fenced = "```json\n" + '{"category":"Jewelry","itemType":"Necklace","size":"null"}' + "\n```"
    parsed = V._parse_json(fenced)
    check("fenced JSON parses", parsed is not None and parsed["itemType"] == "Necklace")
    fields, _ = V.VisionEnricher({})._map_fields(parsed)
    check("stringified null size dropped", "size" not in fields)
    check("jewelry category mapped", fields.get("category") == "Jewelry")






# The real top-level lists these pickers show. Poshmark's came verbatim from
# var/logs/assist-000100.log; the others are the trees those marketplaces publish.
_POSHMARK_MEN = ["accessories", "bags", "global & traditional wear", "grooming",
                 "jackets & coats", "jeans", "other", "pants", "shirts", "shoes",
                 "shorts", "suits & blazers", "sweaters", "sweats & hoodies", "swim"]
_EBAY_MEN = ["activewear", "blazers & sport coats", "casual shirts",
             "coats, jackets & vests", "dress shirts", "jeans", "pants", "shorts",
             "sleepwear & robes", "socks", "suits", "sweaters", "swimwear",
             "t-shirts", "vests"]
_DEPOP = ["accessories", "bottoms", "coats and jackets", "costume", "footwear",
          "jumpsuits and rompers", "outerwear", "tops"]






def _clothing(item_type, category):
    return {"itemType": item_type, "category": category, "categoryGroup": "Clothing"}










# ---------------------------------------------------------------------------
# 2026-09-05 auto-run failures: closed enums, required sub-types, stray pages
# ---------------------------------------------------------------------------






















# --- clothing-tag OCR (2026-08-19) ---------------------------------------
# The interpretation layer is pure string work on purpose: it is what decides
# whether "Roar" stays "Roar", and it must be testable with no PaddleOCR here.

def _ocr_line(text, conf=0.95, box=None):
    return OcrLine(text, conf, box)


def test_ocr_engine_keeps_recognition_scores():
    print("tag OCR / recognition scores survive extraction:")
    # paddleocr 3.x predict() shape
    result = [{
        "rec_texts": ["LEVI'S", "W32 L30"],
        "rec_scores": [0.97, 0.61],
        "rec_polys": [[[0, 0], [100, 0], [100, 20], [0, 20]],
                      [[0, 30], [80, 30], [80, 44], [0, 44]]],
    }]
    lines = extract_lines(result)
    check("both lines extracted", [l.text for l in lines] == ["LEVI'S", "W32 L30"])
    # decode.py threw these away; a 0.61 brand guess and a 0.97 one are not
    # the same claim, and tag reading depends on telling them apart.
    check("scores preserved", lines[0].confidence == 0.97 and lines[1].confidence == 0.61)
    check("polygon reduced to bounds", lines[0].box == (0, 0, 100, 20))

    # paddleocr 2.x ocr() shape
    old = [[[[0, 0], [10, 0], [10, 5], [0, 5]], ("BURBERRY", 0.88)]]
    old_lines = extract_lines(old)
    check("2.x line shape still parses",
          old_lines[0].text == "BURBERRY" and old_lines[0].confidence == 0.88)
    check("unknown shapes yield nothing rather than raising", extract_lines({"nope": 1}) == [])
    check("None yields nothing", extract_lines(None) == [])


def test_tag_ocr_reads_structured_facts():
    print("tag OCR / machine-printed facts are read, not inferred:")
    reading = T.interpret([
        _ocr_line("LEVI STRAUSS & CO."),
        _ocr_line("STYLE 501-0000"),
        _ocr_line("W32 L30"),
        _ocr_line("100% COTTON"),
        _ocr_line("MADE IN MEXICO"),
        _ocr_line("RN 12345"),
        _ocr_line("CA 34567"),
    ])
    check("style number read", "501-0000" in reading.style_numbers)
    check("RN read", reading.rn_numbers == ["12345"])
    check("CA read", reading.ca_numbers == ["34567"])
    check("fabric read", (100, "COTTON") in reading.fabric)
    check("country read", reading.country == "MEXICO")
    check("waist/length size read", "W32 L30" in reading.size_candidates)


def test_tag_ocr_reads_a_blend():
    print("tag OCR / a fabric blend keeps every component:")
    reading = T.interpret([_ocr_line("60% COTTON 40% POLYESTER")])
    check("first component", (60, "COTTON") in reading.fabric)
    check("second component", (40, "POLYESTER") in reading.fabric)


def test_tag_ocr_style_number_needs_a_digit():
    print("tag OCR / a style label followed by prose is not a style number:")
    reading = T.interpret([_ocr_line("STYLE NUMBER")])
    check("no bogus style number", reading.style_numbers == [])


def test_tag_ocr_brand_candidates_ignore_care_text():
    print("tag OCR / care and legal text never becomes a brand:")
    reading = T.interpret([
        # Taller box = larger print = more likely the name on a neck tag.
        _ocr_line("BURBERRY BRIT", 0.90, (0, 10, 200, 60)),
        _ocr_line("TUMBLE DRY LOW", 0.99, (0, 100, 200, 112)),
        _ocr_line("MACHINE WASH COLD", 0.99, (0, 120, 200, 132)),
        _ocr_line("100% COTTON", 0.99, (0, 140, 200, 152)),
        _ocr_line("MADE IN CHINA", 0.99, (0, 160, 200, 172)),
        _ocr_line("RN 12345", 0.99, (0, 180, 200, 192)),
    ])
    check("brand candidate found", reading.brand_candidates[:1] == ["BURBERRY BRIT"])
    check("care text rejected", not any("TUMBLE" in b for b in reading.brand_candidates))
    check("wash text rejected", not any("WASH" in b for b in reading.brand_candidates))
    check("fabric line rejected", not any("COTTON" in b for b in reading.brand_candidates))
    check("origin line rejected", not any("CHINA" in b for b in reading.brand_candidates))
    check("RN line rejected", not any("12345" in b for b in reading.brand_candidates))


def test_tag_ocr_ranks_bigger_print_first():
    print("tag OCR / the largest print outranks a more confident small line:")
    reading = T.interpret([
        _ocr_line("PENDLETON", 0.70, (0, 0, 300, 80)),
        _ocr_line("PORTLAND", 0.99, (0, 200, 100, 210)),
    ])
    check("taller line ranked first", reading.brand_candidates[0] == "PENDLETON")


def test_tag_ocr_size_needs_an_unambiguous_shape():
    print("tag OCR / a stray letter in care text is not a size:")
    care = T.interpret([_ocr_line("TUMBLE DRY LOW"), _ocr_line("MACHINE WASH")])
    check("bare letter inside care text ignored", care.size_candidates == [])
    check("only-the-token line is a size", T.interpret([_ocr_line("L")]).size_candidates == ["L"])
    check("labelled size is read", "XL" in T.interpret([_ocr_line("SIZE: XL")]).size_candidates)
    check("waist x length is read", "32x30" in T.interpret([_ocr_line("32X30")]).size_candidates)
    check("W/L form is read", "W34 L32" in T.interpret([_ocr_line("W34 L32")]).size_candidates)


def test_tag_ocr_country_prefers_the_complete_reading():
    print("tag OCR / a frame-clipped origin line loses to the complete one:")
    # Both of these came off one real item: the same tag caught twice, once
    # clipped by the edge of the frame.
    reading = T.interpret([_ocr_line("MADE IN VIETNA"), _ocr_line("MADE IN VIETNAM")])
    check("longest match wins", reading.country == "VIETNAM")
    check("order does not matter",
          T.interpret([_ocr_line("MADE IN VIETNAM"), _ocr_line("MADE IN VIETNA")]).country == "VIETNAM")


def test_tag_ocr_fit_words_are_not_brands():
    print("tag OCR / the fit printed under the brand is not the brand:")
    reading = T.interpret([_ocr_line("SLIM FIT", 0.98, (0, 0, 200, 40))])
    check("SLIM FIT rejected", reading.brand_candidates == [])


def test_tag_ocr_stops_once_a_real_tag_is_found():
    print("tag OCR / a structured fact means the tag was found:")
    # Each of these is machine-printed and self-identifying; a garment photo
    # does not produce one by accident, so reading further photos is wasted CPU.
    check("fabric is a stop signal",
          T.has_strong_tag_signal(T.interpret([_ocr_line("95% COTTON")])))
    check("country is a stop signal",
          T.has_strong_tag_signal(T.interpret([_ocr_line("MADE IN VIETNAM")])))
    check("RN is a stop signal",
          T.has_strong_tag_signal(T.interpret([_ocr_line("RN 12345")])))
    check("style number is a stop signal",
          T.has_strong_tag_signal(T.interpret([_ocr_line("STYLE 501-0000")])))
    # A woven brand-only label carries no pattern, but it does read cleanly.
    check("three confident lines is a stop signal",
          T.has_strong_tag_signal(T.interpret([
              _ocr_line("PENDLETON", 0.97), _ocr_line("PORTLAND", 0.95), _ocr_line("OREGON", 0.93),
          ])))
    check("a single blurry line keeps looking",
          not T.has_strong_tag_signal(T.interpret([_ocr_line("SOMETHING", 0.42)])))
    check("nothing found keeps looking", not T.has_strong_tag_signal(T.interpret([])))


def test_tag_ocr_keeps_looking_when_a_reading_found_nothing():
    print("tag OCR / crisp lines that yield NO fact must not end the scan:")
    # The regression this pins, measured on 000131: the scan stopped at the LAST
    # photo on a five-line reading that produced no brand and no structured fact,
    # so the real tag two photos earlier ("NABEE") was never read and the item
    # shipped with brand "Unknown". Care wording is confident and machine-printed
    # and still worth nothing, so it must not be mistaken for a woven brand label.
    care = T.interpret([
        _ocr_line("MACHINE WASH COLD", 0.97),
        _ocr_line("TUMBLE DRY LOW", 0.96),
        _ocr_line("DO NOT BLEACH", 0.95),
    ])
    check("care wording yields no brand candidate", care.brand_candidates == [])
    check("so three crisp lines are NOT a stop signal",
          not T.has_strong_tag_signal(care))
    # The woven brand-only label the fallback exists for still stops the scan.
    woven = T.interpret([
        _ocr_line("NABEE", 0.97), _ocr_line("APPAREL", 0.96), _ocr_line("PREMIUM", 0.95),
    ])
    check("a real brand line still stops the scan", T.has_strong_tag_signal(woven))


def test_tag_ocr_reads_the_last_photos():
    print("tag OCR / tags are shot last, so the last photos are read:")
    paths = ["p%d.jpg" % i for i in range(9)]
    check("takes the last N", T.select_tag_photos(paths, 3) == ["p6.jpg", "p7.jpg", "p8.jpg"])
    check("fewer than the cap returns all", T.select_tag_photos(["a.jpg"], 4) == ["a.jpg"])
    check("zero cap reads nothing", T.select_tag_photos(paths, 0) == [])
    check("no photos is safe", T.select_tag_photos([], 4) == [])


def test_tag_ocr_prompt_snippet_is_bounded():
    print("tag OCR / the vision prompt injection stays inside its budget:")
    snippet = T.prompt_snippet(T.interpret([
        _ocr_line("LEVI STRAUSS & CO."), _ocr_line("W32 L30"),
    ]))
    # The model has to see the actual characters to correct its own misreading.
    check("raw characters carried", "LEVI STRAUSS & CO." in snippet)
    check("empty reading yields no snippet", T.prompt_snippet(T.interpret([])) == "")
    long_lines = [_ocr_line("TAG LINE %02d %s" % (i, "X" * 40)) for i in range(20)]
    bounded = T.prompt_snippet(T.interpret(long_lines), limit=200)
    check("snippet truncates instead of flooding the context", len(bounded) < 400)


def test_tag_ocr_degrades_without_the_engine():
    print("tag OCR / a missing engine degrades, it does not raise:")
    off = T.read_tags(["a.jpg"], {"tagOcrEnabled": False})
    check("disabled reports why", "disabled" in (off.unavailable_reason or ""))
    check("disabled reads nothing", off.is_empty())

    import black_cat_worker.ocr_engine as OE
    saved = OE.shared_engine
    OE.shared_engine = lambda: False
    try:
        missing = T.read_tags(["a.jpg"], {"tagOcrEnabled": True})
    finally:
        OE.shared_engine = saved
    check("missing engine reported", missing.unavailable_reason == "PaddleOCR unavailable")
    check("missing engine reads nothing", missing.is_empty())


def test_tag_reading_json_is_bounded():
    print("tag OCR / the debug dump is bounded for the enrichment IPC:")
    payload = T.interpret([_ocr_line("LINE %d" % i) for i in range(120)]).to_json()
    check("line dump capped", len(payload["lines"]) == 60)
    check("raw text kept for debugging", payload["lines"][0]["text"] == "LINE 0")
    check("extraction summary present", "brandCandidates" in payload["extracted"])


# --- 2026-09-02 studio props: the ruler is not the item ----------------------

def test_props_ruler_print_never_reaches_the_tag_reading():
    print("props / the ruler's own print is not a tag:")
    # Exactly what PaddleOCR returned off the measurement photo of 000119: the
    # maker's mark, the model number, and the inch marks along the edge.
    ruler, tag = "IMG_3231.JPG", "IMG_3233.JPG"
    lines = [
        _ocr_line("Empiré", 0.96).with_source(ruler),
        _ocr_line("Model 403", 1.0).with_source(ruler),
    ] + [_ocr_line(n, 1.0).with_source(ruler) for n in ("6", "8", "9", "10", "13")] + [
        _ocr_line("W32 L30", 0.97).with_source(tag),
        _ocr_line("MADE IN CHINA", 0.97).with_source(tag),
    ]
    reading = T.interpret(lines)
    check("the maker is not a brand candidate",
          not any("EMPIR" in b for b in reading.brand_candidates))
    check("the model line is not a brand candidate",
          not any("403" in b for b in reading.brand_candidates))
    check("the model number is not a style number", reading.style_numbers == [])
    check("the inch marks are not sizes",
          not any(s in reading.size_candidates for s in ("6", "8", "9", "10", "13")))
    check("the tag on the other photo still reads",
          "W32 L30" in reading.size_candidates and reading.country == "CHINA")
    snippet = T.prompt_snippet(reading)
    check("the vision prompt never sees the ruler",
          "403" not in snippet and "EMPIR" not in snippet.upper())
    check("what was dropped is on record",
          {"EMPIRÉ", "MODEL 403", "6"} <= set(reading.props_ignored))
    check("the debug dump carries it too", "MODEL 403" in reading.to_json()["propsIgnored"])
    # "MODEL 403" used to count as a style number, and a style number ends the
    # scan, so the ruler shot alone stopped the real tag from ever being read.
    check("the ruler no longer ends the tag scan",
          not T.has_strong_tag_signal(T.interpret(lines[:7])))


def test_props_ocr_misreadings_of_the_ruler_are_recognised():
    print("props / every way OCR has spelled the ruler print:")
    for text in ("Empiré", "Empire?", "Empiré?", "EMPIRE", "Model 403", "Mordel 403",
                 "MODEL403", "Empire Model 403"):
        check("%r is prop print" % text, P.is_prop_line(T.normalize_text(text)))
    for text in ("EMPIRE WAIST", "MODEL NO 1234", "STYLE 403-0000", "LEVI STRAUSS & CO.", "403"):
        check("%r is not" % text, not P.is_prop_line(T.normalize_text(text)))
    both = T.interpret([
        _ocr_line("Model 403").with_source("ruler.jpg"),
        _ocr_line("6").with_source("ruler.jpg"),
        _ocr_line("6").with_source("tag.jpg"),
    ])
    check("a bare number is dropped on the ruler photo only", both.size_candidates == ["6"])
    check("the ruler's own number is its model, however spelled",
          all(P.is_prop_code(v) for v in ("Model 403", "403", "MODEL403", "Empire Model 403", "Mordel 403")))
    check("a real style number is not", not any(P.is_prop_code(v) for v in ("501", "403-0000", "1403", "WPL 10167")))


def test_props_vision_answer_is_scrubbed():
    print("props / the model's answer never carries the ruler:")
    from black_cat_worker import vision as V
    parsed = {
        "brand": "Empiré", "model": "Model 403", "styleNumber": "403",
        "itemType": "Shorts", "primaryColor": "Olive", "colorPattern": "solid",
        "graphics": ["Empiré logo on back pocket", "Model 403 text on ruler", "circular logo on pocket"],
        "keyDetails": ["Cargo Pockets", "Button Fly", "Empiré", "Empire Brand", "Model 403"],
        "description": ("Empiré Model 403 olive green cargo shorts featuring a button fly. "
                        "The waistband has a black tag reading 'Empiré' and 'Model 403'. "
                        "The shorts are made of cotton."),
    }
    fields, _ = V.VisionEnricher({"visionEnabled": True})._map_fields(parsed)
    check("the maker is not the brand", "brand" not in fields and parsed["brand"] is None)
    check("the model is cleared", parsed["model"] is None)
    check("the style number is cleared", parsed["styleNumber"] is None)
    check("real graphics survive", parsed["graphics"] == ["circular logo on pocket"])
    check("real key details survive", parsed["keyDetails"] == ["Cargo Pockets", "Button Fly"])
    check("the description reads clean",
          parsed["description"] == "Olive green cargo shorts featuring a button fly. The shorts are made of cotton.")
    check("what was scrubbed is on record",
          set(parsed["propsScrubbed"]) == {"brand", "model", "styleNumber", "graphics", "keyDetails", "description"})
    check("the item type still maps", fields.get("itemType") == "Shorts")

    real = {"brand": "Carhartt", "model": "Detroit Jacket", "styleNumber": "J97", "itemType": "Jacket",
            "keyDetails": ["Blanket Lined"],
            "description": "A cream dress with an empire waist and a sash."}
    fields2, _ = V.VisionEnricher({"visionEnabled": True})._map_fields(real)
    check("a real brand is untouched", fields2.get("brand") == "Carhartt")
    check("a real model and style number are untouched",
          real["model"] == "Detroit Jacket" and real["styleNumber"] == "J97")
    check("an empire waist is a silhouette, not the ruler", "empire waist" in real["description"])
    check("nothing recorded when nothing was scrubbed", "propsScrubbed" not in real)


def test_props_every_sentence_shape_the_model_used():
    print("props / each way the model wove the ruler into a description:")
    # Every one of these is a real description from batch 39.
    cases = [
        ("Black denim pants by True Religion, model 403, featuring a relaxed fit.",
         "Black denim pants by True Religion featuring a relaxed fit."),
        ("Empire brand Model 403 jeans featuring a high-rise fit.",
         "Jeans featuring a high-rise fit."),
        ("Women's Empire brand denim jeans, Model 403, featuring a wide leg. "
         "The waistband displays the Empire logo and 'Ashley' text. "
         "A ruler indicates the length of the leg.",
         "Women's denim jeans featuring a wide leg."),
        ("Brown corduroy jeans by Empire, Model 403. Features a button fly closure.",
         "Brown corduroy jeans. Features a button fly closure."),
        ("Black crewneck sweater by Joseph & Lyman, Model 403. Made from wool.",
         "Black crewneck sweater by Joseph & Lyman. Made from wool."),
    ]
    for source, expected in cases:
        check(expected, P.scrub_text(source) == expected)
    check("a description without the ruler is returned untouched",
          P.scrub_text("Levi's 501 jeans, dark wash.") == "Levi's 501 jeans, dark wash.")
    check("none stays none", P.scrub_text(None) is None)


def test_props_scrub_tool_plans_only_what_the_ruler_touched():
    print("props / the clean-up tool rewrites exactly the ruler's traces, and nothing on a clean row:")
    import json
    from black_cat_worker import scrub_props as SP
    # Item 000126 as batch 39 stored it, trimmed to the columns that matter.
    row = {
        "id": 209, "sku": "000126", "brand": "Empire", "model": "Model 403", "styleNumber": None,
        "description": ("Women's Empire brand denim jeans, Model 403, featuring a wide leg. "
                        "The waistband displays the Empire logo and 'Ashley' text."),
        "graphics": "Empire logo on waistband\nAshley ultra lowrise text on waistband\nModel 403 text on ruler",
        "keyDetails": "Ultra Lowrise\nWide Leg\nEmpire Brand",
        "aiFields": '["itemType","color","brand","size"]',
        "aiRaw": json.dumps({
            "brand": "Empiré", "model": "Model 403", "itemType": "Jeans", "primaryColor": "Blue",
            "size": "10", "description": "Women's Empire brand denim jeans, Model 403, featuring a wide leg.",
            "ocr": {
                "lines": [{"text": "Empiré?", "confidence": 0.88, "photo": "r.jpg"},
                          {"text": "Model 403", "confidence": 0.99, "photo": "r.jpg"},
                          {"text": "10", "confidence": 0.9, "photo": "r.jpg"}],
                "extracted": {"brandCandidates": ["EMPIRÉ?", "MODEL 403"], "styleNumbers": ["403"],
                              "sizeCandidates": ["10"]},
                "photosRead": ["r.jpg"], "unavailable": None,
            },
        }),
    }
    changes = SP.plan_row(row)
    check("the maker leaves the brand column", changes.get("brand") == SP.UNKNOWN_BRAND)
    check("the model column is cleared", "model" in changes and changes["model"] is None)
    check("the description is scrubbed", changes.get("description") == "Women's denim jeans featuring a wide leg.")
    check("graphics keep the real one", changes.get("graphics") == "Ashley ultra lowrise text on waistband")
    check("key details keep the real ones", changes.get("keyDetails") == "Ultra Lowrise\nWide Leg")
    check("the brand badge goes with the brand", json.loads(changes["aiFields"]) == ["itemType", "color", "size"])
    raw = json.loads(changes["aiRaw"])
    check("aiRaw no longer carries the ruler",
          raw["brand"] is None and raw["model"] is None and "Model 403" not in raw["description"])
    check("the tag reading is rebuilt without it",
          raw["ocr"]["extracted"]["styleNumbers"] == [] and raw["ocr"]["extracted"]["brandCandidates"] == []
          and "MODEL 403" in raw["ocr"]["propsIgnored"])
    check("the ruler's inch mark is no longer a size candidate", raw["ocr"]["extracted"]["sizeCandidates"] == [])
    check("the evidence record is rebuilt", "styleNumber" not in json.loads(changes["evidenceJson"]))
    check("a title falling back to aiRaw finds nothing", "styleNumber" not in raw or raw["styleNumber"] is None)

    clean = {
        "id": 1, "sku": "000001", "brand": "Carhartt", "model": "Detroit Jacket", "styleNumber": "J97",
        "description": "Brown duck jacket with a blanket lining.", "graphics": None, "keyDetails": "Blanket Lined",
        "aiFields": '["brand"]',
        "aiRaw": json.dumps({"brand": "Carhartt", "model": "Detroit Jacket",
                             "ocr": {"lines": [{"text": "CARHARTT", "confidence": 0.99, "photo": "t.jpg"}],
                                     "extracted": {"brandCandidates": ["CARHARTT"]}}}),
    }
    check("a clean row is not touched at all", SP.plan_row(clean) == {})


def test_props_title_lines_lose_the_ruler_tokens():
    print("props / a public-notes line or custom title loses the ruler's tokens:")
    from black_cat_worker import scrub_props as SP
    # Both are real public-notes lines batch 39 exported.
    check("model token cut from the middle",
          P.scrub_title("Abercrombie & Fitch Model 403 Womens Mini Shorts Olive Size 2")
          == "Abercrombie & Fitch Womens Mini Shorts Olive Size 2")
    check("bare number cut from the middle",
          P.scrub_title("Rocky Mountain 403 Unisex Vintage Cargo Denim Jeans Black Size 29")
          == "Rocky Mountain Unisex Vintage Cargo Denim Jeans Black Size 29")
    check("maker and model cut from the front",
          P.scrub_title("Empire Model 403 Unisex Corduroy Jeans Brown") == "Unisex Corduroy Jeans Brown")
    check("a real title is not touched", not P.has_prop_token("Levi's 501 Mens Jeans Size 32x30"))
    plan = SP.plan_row({"id": 205, "sku": "000122", "brand": "Rocky Mountain", "model": None,
                        "styleNumber": None, "description": None, "graphics": None, "keyDetails": None,
                        "publicNotes": "Rocky Mountain 403 Unisex Vintage Cargo Denim Jeans Black Size 29",
                        "customTitle": "Rocky Mountain Unisex Vintage Denim Jeans Black Size 29",
                        "aiFields": None, "aiRaw": None})
    check("the tool rewrites the public-notes line",
          plan.get("publicNotes") == "Rocky Mountain Unisex Vintage Cargo Denim Jeans Black Size 29")
    check("and leaves a clean custom title alone", "customTitle" not in plan)


def test_props_a_number_only_the_ruler_carried_is_never_a_style_number():
    print("props / the ruler's numbers, however OCR joins them, are never a model or style number:")
    import json
    from black_cat_worker import scrub_props as SP
    ruler, tag = "IMG_3319.JPG", "tag.jpg"
    reading = T.interpret([
        _ocr_line("Empiré").with_source(ruler), _ocr_line("Model 403").with_source(ruler),
        # The circled 16 at the ruler's end and the 1 beside it, read as one token.
        _ocr_line("116", 0.76).with_source(ruler),
        _ocr_line("AGOLDE").with_source(tag),
    ])
    check("a three-digit join on the ruler photo is dropped too", "116" in reading.props_ignored)
    check("the tag line survives", any(line.text == "AGOLDE" for line in reading.lines))
    parsed = {"styleNumber": "116", "model": "116", "size": "27"}
    check("the cross-check clears model and style number",
          set(P.cross_check(parsed, reading)) == {"model", "styleNumber"} and parsed["styleNumber"] is None)
    real = {"styleNumber": "116"}
    tagged = T.interpret([_ocr_line("Model 403").with_source(ruler), _ocr_line("116").with_source(ruler),
                          _ocr_line("116").with_source(tag)])
    check("a number a tag also carries is kept", P.cross_check(real, tagged) == [] and real["styleNumber"] == "116")
    check("no reading, no change", P.cross_check({"styleNumber": "116"}, None) == [])
    ruler_only = T.interpret([_ocr_line("Model 403").with_source(ruler), _ocr_line("10").with_source(ruler)])
    ev, _ = E.build_evidence({}, {"size": "10"}, ruler_only)
    check("a size that is one of the ruler's numbers is flagged",
          ev["size"]["status"] == E.UNCERTAIN and "ruler" in ev["size"]["note"])
    ev2, _ = E.build_evidence({}, {"size": "27"}, ruler_only)
    check("a size the ruler does not show stays as it was", ev2["size"]["status"] == E.INFERRED)
    plan = SP.plan_row({"id": 208, "sku": "000125", "brand": "Unknown", "model": None, "styleNumber": "116",
                        "description": None, "graphics": None, "keyDetails": None, "publicNotes": None,
                        "customTitle": None, "aiFields": None,
                        "aiRaw": json.dumps({"styleNumber": "116", "size": "27", "ocr": {"lines": [
                            {"text": "Model 403", "confidence": 1, "photo": ruler},
                            {"text": "116", "confidence": 0.76, "photo": ruler}], "photosRead": [ruler]}})})
    check("the tool clears the column", "styleNumber" in plan and plan["styleNumber"] is None)
    check("and the raw value behind it", json.loads(plan["aiRaw"])["styleNumber"] is None)


def test_props_the_ocr_record_keeps_the_ruler_marked():
    print("props / the stored OCR record keeps the ruler's lines, marked, for a later pass:")
    import json
    from black_cat_worker import scrub_props as SP
    ruler, tag = "r.jpg", "t.jpg"
    reading = T.interpret([
        _ocr_line("Model 403").with_source(ruler), _ocr_line("116").with_source(ruler),
        _ocr_line("AGOLDE").with_source(tag),
    ])
    payload = reading.to_json()
    check("the kept line comes first, unmarked",
          payload["lines"][0]["text"] == "AGOLDE" and "prop" not in payload["lines"][0])
    check("the dropped lines follow, marked",
          [line["text"] for line in payload["lines"] if line.get("prop")] == ["Model 403", "116"])
    check("the prompt still never sees them", "116" not in T.prompt_snippet(reading))
    # A row the first version of the tool rewrote kept only the surviving lines. With
    # one photo read, the ruler was on it, and the pass can still tie "116" to it.
    degraded = {"styleNumber": "116", "size": "27", "ocr": {
        "lines": [{"text": "116", "confidence": 0.76, "photo": ruler}], "extracted": {},
        "photosRead": [ruler], "propsIgnored": ["2", "EMPIRÉ", "MODEL 403"]}}
    row = {"id": 208, "sku": "000125", "brand": "Unknown", "model": None, "styleNumber": "116",
           "description": None, "graphics": None, "keyDetails": None, "publicNotes": None,
           "customTitle": None, "aiFields": None, "aiRaw": json.dumps(degraded)}
    first = SP.plan_row(row)
    check("the column is cleared", "styleNumber" in first and first["styleNumber"] is None)
    raw = json.loads(first["aiRaw"])
    check("and the raw value behind it", raw["styleNumber"] is None)
    check("the record is complete again", any(line.get("prop") for line in raw["ocr"]["lines"]))
    row.update(first)
    check("a second pass finds nothing left to do", SP.plan_row(row) == {})
    clean = {"brand": "Carhartt", "ocr": {"lines": [{"text": "CARHARTT", "confidence": 0.99, "photo": tag}],
                                          "photosRead": [tag]}}
    check("a clean row is still untouched", SP.scrub_raw(clean) == (None, set()))
    bare = {"styleNumber": "116", "size": "2", "ocr": {"lines": [], "extracted": {}, "photosRead": [ruler],
                                                        "propsIgnored": ["2", "MODEL 403"]}}
    record, numbers = SP.scrub_raw(bare)
    check("a row with no surviving lines is restored the same way",
          "2" in numbers and record["size"]["status"] == E.UNCERTAIN)


def test_props_a_registration_number_is_never_a_style_number():
    print("identifiers / an RN, CA, or WPL registration off the label is not a style number:")
    import json
    from black_cat_worker import vision as V
    from black_cat_worker import scrub_props as SP
    for value in ("WPL 10167", "RN 12345", "CA 34567", "rn#12345", "WPL10167", "RN4 11965"):
        check("%r is a registration" % value, T.is_registration_number(value))
    for value in ("501-0000", "CK1234", "116", "WPL", "RN 12", None):
        check("%r is not" % value, not T.is_registration_number(value))
    parsed = {"brand": "Joseph & Lyman", "itemType": "Sweater", "model": "RN 12345", "styleNumber": "WPL 10167"}
    V.VisionEnricher({"visionEnabled": True})._map_fields(parsed)
    check("the vision answer drops both", parsed["model"] is None and parsed["styleNumber"] is None)
    plan = SP.plan_row({"id": 212, "sku": "000129", "brand": "Joseph & Lyman", "model": None,
                        "styleNumber": "WPL 10167", "description": None, "graphics": None, "keyDetails": None,
                        "publicNotes": None, "customTitle": None, "aiFields": None,
                        "aiRaw": json.dumps({"styleNumber": "WPL 10167", "brand": "Joseph & Lyman"})})
    check("the tool clears the column", "styleNumber" in plan and plan["styleNumber"] is None)
    check("and the raw value behind it", json.loads(plan["aiRaw"])["styleNumber"] is None)


def test_props_a_photo_of_nothing_but_numbers_is_a_measuring_tool():
    print("props / a photo that reads as nothing but numbers is a measuring tool, whatever its print:")
    import json
    from black_cat_worker import scrub_props as SP
    tape, tag = "IMG_3540.JPG", "tag.jpg"
    # Exactly what OCR read on 000150: no maker's mark in the frame, just the graduations.
    reading = T.interpret([_ocr_line(n).with_source(tape) for n in ("14", "15", "20", "22", "25", "29")]
                          + [_ocr_line("CARHARTT").with_source(tag), _ocr_line("XL").with_source(tag)])
    check("the graduations are dropped", {"14", "20", "29"} <= set(reading.props_ignored))
    check("none of them is a size candidate", reading.size_candidates == ["XL"])
    check("the tag photo is untouched", any(line.text == "CARHARTT" for line in reading.lines))
    few = T.interpret([_ocr_line("32").with_source(tag), _ocr_line("30").with_source(tag)])
    check("two bare numbers on a photo are not a tool", "32" in few.size_candidates)
    mixed = T.interpret([_ocr_line(n).with_source(tag) for n in ("14", "15", "20")] + [_ocr_line("MADE IN USA").with_source(tag)])
    check("numbers beside real words are not a tool", "14" in mixed.size_candidates)

    # The vision model called the tape's 20 the size; no tag line carries a 20.
    parsed, fields = {"size": "20", "itemType": "Hoodie"}, {"size": "20", "itemType": "Hoodie"}
    check("the size is cleared from the answer and the mapped fields",
          P.cross_check(parsed, reading, fields) == ["size"] and parsed["size"] is None and "size" not in fields)
    with_tag = T.interpret([_ocr_line("20").with_source(tape), _ocr_line("22").with_source(tape),
                            _ocr_line("25").with_source(tape), _ocr_line("20").with_source(tag)])
    kept = {"size": "20"}
    check("a size the tag also carries is kept", P.cross_check(kept, with_tag, {"size": "20"}) == [] and kept["size"] == "20")

    ocr = {"lines": [{"text": n, "confidence": 0.99, "photo": tape} for n in ("14", "15", "20", "22", "25", "29")],
           "extracted": {"sizeCandidates": ["14", "15", "20"]}, "photosRead": [tape]}
    row = {"id": 1, "sku": "000150", "brand": "Carhartt", "model": None, "styleNumber": None, "size": "20",
           "description": None, "graphics": None, "keyDetails": None, "publicNotes": None, "customTitle": None,
           "status": "Photographed", "aiFields": json.dumps(["itemType", "size", "color"]),
           "aiRaw": json.dumps({"brand": "Carhartt", "itemType": "Hoodie", "size": "20", "ocr": ocr})}
    plan = SP.plan_row(row)
    check("the tool clears an unconfirmed size", "size" in plan and plan["size"] is None)
    check("and its AI badge", json.loads(plan["aiFields"]) == ["itemType", "color"])
    check("and the raw size behind it", json.loads(plan["aiRaw"])["size"] is None)
    check("the evidence no longer claims a size", "size" not in json.loads(plan["evidenceJson"]))
    confirmed = dict(row, aiFields=None)
    shipped = dict(row, status="Uploaded to Nifty")
    check("a size on a live listing is never cleared", "size" not in SP.plan_row(shipped))
    plan2 = SP.plan_row(confirmed)
    check("a confirmed size is left alone", "size" not in plan2)
    check("but flagged", json.loads(plan2["evidenceJson"])["size"]["status"] == E.UNCERTAIN)


# --- brand / attribute normalization (2026-08-19) -------------------------
# Both consumers read config/normalization.json; these mirror the assertions in
# src/lib/normalize.test.ts so the two implementations cannot quietly disagree.

def test_normalize_canonicalizes_known_brands():
    print("normalization / known aliases resolve to one canonical spelling:")
    check("polo by ralph lauren", N.canonical_brand("Polo by Ralph Lauren") == "Polo Ralph Lauren")
    check("levi strauss & co", N.canonical_brand("Levi Strauss & Co.") == "Levi's")
    check("levis", N.canonical_brand("levis") == "Levi's")
    # The inventory really did carry all three of these as separate brands.
    check("quicksilver", N.canonical_brand("Quicksilver") == "Quiksilver")
    check("quicksliver quikjean", N.canonical_brand("Quicksliver Quikjean") == "Quiksilver")
    check("mortal combat", N.canonical_brand("mortal combat  ") == "Mortal Kombat")


def test_normalize_only_suggests_a_near_miss():
    print("normalization / an almost-match is flagged, never applied:")
    for misread in ("QLIKSILVER", "QUIKSILVAR"):
        result = N.normalize_value("brand", misread)
        check(f"{misread} left alone", result.value == misread and not result.canonical)
        check(f"{misread} suggests Quiksilver", result.suggestion == "Quiksilver")
    # Vision reported "Roast" for an item whose brand is "Roar".
    roast = N.normalize_value("brand", "Roast")
    check("Roast is not rewritten", roast.value == "Roast")
    check("Roast suggests Roar", roast.suggestion == "Roar")


def test_normalize_leaves_unknown_values_alone():
    print("normalization / a brand nobody has heard of is not damaged:")
    for kept in ("Saint Pablo Tour Merch", "Get Lost Perv", "YES band shirt"):
        result = N.normalize_value("brand", kept)
        check(f"{kept!r} preserved", result.value == kept and result.suggestion is None)
    check("whitespace still tidied", N.canonical_brand("Grim Reaper  ") == "Grim Reaper")
    check("empty input is safe", N.canonical_brand("") == "")
    check("non-string input is safe", N.canonical_brand(None) == "")


def test_normalize_short_names_are_never_fuzzy_matched():
    print("normalization / four characters is too short to guess at:")
    check("Vera gets no suggestion", N.normalize_value("brand", "Vera").suggestion is None)
    check("known short brand still exact", N.canonical_brand("Vans") == "Vans")
    check("known short brand alias", N.canonical_brand("the gap") == "Gap")


def test_normalize_other_attribute_families():
    print("normalization / materials, colors and fits:")
    check("100% cotton", N.canonical_material("100% cotton") == "Cotton")
    check("pleather", N.canonical_material("pleather") == "Faux Leather")
    check("navy blue", N.canonical_color("navy blue") == "Navy")
    check("heather gray", N.canonical_color("heather gray") == "Grey")
    check("slim fit", N.canonical_fit("slim fit") == "Slim")
    check("sub-brand detected", N.detect_sub_brand("Levi's", "Levi's Silver Tab 501") == "Silver Tab")
    check("sub-brand absent", N.detect_sub_brand("Levi's", "plain 501 jeans") is None)


def test_normalize_survives_a_missing_table():
    print("normalization / a broken table degrades, it does not raise:")
    saved = N._TABLE_PATH
    try:
        N.reset_cache()
        N._TABLE_PATH = os.path.join(os.path.dirname(saved), "does-not-exist.json")
        check("unknown table returns input", N.canonical_brand("Quicksilver") == "Quicksilver")
        check("no suggestion without a table",
              N.normalize_value("brand", "Quicksilver").suggestion is None)
    finally:
        N._TABLE_PATH = saved
        N.reset_cache()
    check("table reloads afterwards", N.canonical_brand("Quicksilver") == "Quiksilver")


# --- evidence: verified / inferred / uncertain (2026-08-19) ---------------

class _FakeReading:
    """Enough of a TagReading for the evidence rules; no PaddleOCR involved."""

    def __init__(self, brands=None, sizes=None, fabric=None, country=None,
                 styles=None, lines=("x",)):
        self.brand_candidates = list(brands or [])
        self.size_candidates = list(sizes or [])
        self.fabric = list(fabric or [])
        self.country = country
        self.style_numbers = list(styles or [])
        self.rn_numbers = []
        self.ca_numbers = []
        self.lines = list(lines)


def test_evidence_agreement_is_verified():
    print("evidence / the tag and the model agreeing is the strongest claim:")
    ev, _ = E.build_evidence({}, {"brand": "Quiksilver", "size": "L"},
                             _FakeReading(brands=["QUIKSILVER"], sizes=["L"]))
    check("brand verified", ev["brand"]["status"] == E.VERIFIED)
    check("brand cites both sources", set(ev["brand"]["sources"]) == {"vision", "ocr"})
    check("size verified", ev["size"]["status"] == E.VERIFIED)


def test_evidence_tolerates_ocr_word_joining():
    print("evidence / a tag reader that loses spaces has still agreed:")
    # PaddleOCR really returned these for "Brooks Brothers" and "Yacht Club".
    ev, _ = E.build_evidence({}, {"brand": "Brooks Brothers"},
                             _FakeReading(brands=["BrooksiBrathers"]))
    check("joined + misread still verified", ev["brand"]["status"] == E.VERIFIED)
    ev2, _ = E.build_evidence({}, {"brand": "Yacht Club"}, _FakeReading(brands=["YACHTCLUB"]))
    check("joined words still verified", ev2["brand"]["status"] == E.VERIFIED)


def test_evidence_conflict_is_uncertain_and_keeps_both():
    print("evidence / a disagreement keeps both readings and picks no winner:")
    ev, _ = E.build_evidence({}, {"brand": "Nike"}, _FakeReading(brands=["ADIDAS"]))
    check("status uncertain", ev["brand"]["status"] == E.UNCERTAIN)
    check("the model's value is still stored", ev["brand"]["value"] == "Nike")
    check("the tag reading is preserved", ev["brand"]["rawOcr"] == "ADIDAS")


def test_evidence_vision_only_is_inferred():
    print("evidence / no tag reading means inferred, not verified:")
    ev, _ = E.build_evidence({}, {"brand": "Nike", "color": "Black"}, None)
    check("brand inferred", ev["brand"]["status"] == E.INFERRED)
    check("colour inferred", ev["color"]["status"] == E.INFERRED)
    check("only vision cited", ev["brand"]["sources"] == ["vision"])


def test_evidence_ocr_fills_gaps_but_never_overwrites():
    print("evidence / OCR fills what the model missed and nothing else:")
    # eBay makes Exterior Material required on bags and blocks the listing without
    # it; one real item burned a 211s publish attempt on exactly that.
    ev, derived = E.build_evidence({}, {}, _FakeReading(fabric=[(95, "COTTON"), (5, "SPANDEX")]))
    check("dominant fibre derived", derived["material"] == "Cotton")
    check("derived material is verified", ev["material"]["status"] == E.VERIFIED)
    check("credited to OCR alone", ev["material"]["sources"] == ["ocr"])

    # The model already answered: OCR must not overwrite it, only disagree loudly.
    ev2, derived2 = E.build_evidence({"material": "Leather"}, {},
                                     _FakeReading(fabric=[(100, "COTTON")]))
    check("existing value untouched", "material" not in derived2)
    check("conflict flagged", ev2["material"]["status"] == E.UNCERTAIN)

    ev3, derived3 = E.build_evidence({}, {}, _FakeReading(sizes=["XL"]))
    check("missing size filled from the tag", derived3["size"] == "XL")
    check("filled size verified", ev3["size"]["status"] == E.VERIFIED)


def test_evidence_country_and_style_number_come_only_from_a_label():
    print("evidence / origin and style number are read, never guessed:")
    ev, derived = E.build_evidence({}, {}, _FakeReading(country="USA", styles=["501-0000"]))
    check("multi-word country title-cased",
          E.build_evidence({}, {}, _FakeReading(country="VIETNAM"))[1]["countryOfOrigin"] == "Vietnam")
    # "Made in USA" is a real value signal, which is why a title may only claim it
    # when it was read off a label.
    check("country derived, acronym preserved", derived["countryOfOrigin"] == "USA")
    check("country verified", ev["countryOfOrigin"]["status"] == E.VERIFIED)
    check("style number derived", derived["styleNumber"] == "501-0000")
    check("style number verified", ev["styleNumber"]["status"] == E.VERIFIED)
    # No label, no claim.
    ev2, derived2 = E.build_evidence({}, {}, None)
    check("nothing invented without a tag", "countryOfOrigin" not in derived2)
    check("no country evidence either", "countryOfOrigin" not in ev2)


def test_evidence_a_near_miss_spelling_downgrades_the_field():
    print("evidence / a 'did you mean' is a reason to look, so it downgrades:")
    ev, _ = E.build_evidence({"normalizationSuggestions": {"brand": "Quiksilver"}},
                             {"brand": "QLIKSILVER"}, None)
    check("downgraded to uncertain", ev["brand"]["status"] == E.UNCERTAIN)
    check("suggestion is in the note", "Quiksilver" in ev["brand"]["note"])


def test_evidence_summary_counts():
    print("evidence / the per-item summary counts each status:")
    ev, _ = E.build_evidence({}, {"brand": "Nike", "color": "Black", "size": "L"},
                             _FakeReading(sizes=["L"]))
    totals = E.summarize(ev)
    check("one verified", totals[E.VERIFIED] == 1)
    check("the rest inferred", totals[E.INFERRED] >= 2)
    check("empty evidence is safe", E.summarize({})[E.VERIFIED] == 0)


# ---------------------------------------------------------------------------
# 2026-08-19 listing editor — pushing a change to a listing that is ALREADY live.
# Every one of these guards an action that cannot be undone from inside the tool:
# editing the WRONG listing, or filling the NEW-listing page and creating a duplicate.
# ---------------------------------------------------------------------------



















def test_tag_ocr_reads_a_country_split_across_lines():
    print("tag ocr / a care label that WRAPS still yields its country:")
    # Verbatim from item 000003's tag: PaddleOCR returned "100% Cotton Made" and
    # "in Honduras" as two lines, and the country was simply lost - on a field the
    # vision model cannot supply and the title needs to justify "Made in USA".
    reading = T.interpret([_ocr_line("MORTALKOMBATX"), _ocr_line("100% Cotton Made"),
                           _ocr_line("in Honduras")])
    check("wrapped country found", reading.country == "HONDURAS")
    check("unwrapped country still found",
          T.interpret([_ocr_line("MADE IN MEXICO")]).country == "MEXICO")


def test_tag_ocr_material_does_not_swallow_the_next_sentence():
    print("tag ocr / the material stops where the next fact starts:")
    reading = T.interpret([_ocr_line("100% Cotton Made"), _ocr_line("in Honduras")])
    check("COTTON, not 'COTTON MADE'", reading.fabric == [(100, "COTTON")])
    # A real fibre whose name merely starts with one of the stop words is untouched.
    check("MADEIRA LACE survives", T.extract_fabric(["100% MADEIRA LACE"]) == [(100, "MADEIRA LACE")])


def test_tag_ocr_stitching_is_additive_and_bounded():
    print("tag ocr / stitching adds joins without losing the originals:")
    out = T.stitch_wrapped(["A", "B", "C"])
    check("originals kept", out[:3] == ["A", "B", "C"])
    check("pairs joined", "A B" in out and "B C" in out)
    check("triples joined", "A B C" in out)
    check("no four-line joins", not any(x.count(" ") >= 3 for x in out))
    check("empty in, empty out", T.stitch_wrapped([]) == [])


def test_tag_ocr_never_claims_a_country_from_printed_in():
    print("tag ocr / 'printed in USA' is NOT a country of manufacture:")
    # Item 000006's tag says "DYED & PRINTED IN USA" and "Assembled in Mexico".
    # Reading that as Made in USA would put a false origin claim in a title.
    reading = T.interpret([_ocr_line("THE"), _ocr_line("MOUNTAIN:"),
                           _ocr_line("DYED & PRINTED IN USA"), _ocr_line("100% Cotton")])
    check("no country claimed", reading.country is None)












def main():
    test_normalize()
    test_coerce()
    test_levenshtein()
    test_grouping_happy()
    test_grouping_unterminated()
    test_grouping_marker_no_photos()
    test_grouping_ambiguous()
    test_missing_sku_gap()
    test_merged_group_bloat()
    test_bloat_threshold_tracks_the_batch()
    test_gap_threshold_calibrates_to_batch_boundaries()
    test_normal_shoot_stays_high_confidence()
    test_long_pause_inside_one_item_is_not_a_problem_row()
    test_merged_item_confidence_drops_even_uncorroborated()
    test_decode_engine_status_reports_missing_deps()
    test_delete_garment_photo_is_safe()
    test_parse_capacity_oz()
    # --- HARDENING PASS additions ---
    test_normalize_edge()
    test_coerce_edge()
    test_is_valid_sku()
    test_levenshtein_edge()
    test_grouping_edge()
    test_grouping_bloat_boundary()
    test_parse_capacity_oz_edge()
    # --- v1.2/v1.3 grouping-reliability regressions ---
    test_unreadable_sticker_recovers_number()
    test_qr_false_positive_never_splits()
    test_ocr_outlier_demoted()
    test_time_gap_is_note_only()
    test_empty_marker_keeps_number()
    test_gap_flood_suppressed()
    test_grouping_log_written()
    test_fifty_item_batch_no_merges()
    test_coerce_noise_gate()
    # --- 2026-08-05 vision-failure surfacing + accessories ---
    test_vision_error_classification()
    test_vision_short_circuit_and_isolation()
    test_vision_success_resets_failures_and_maps_category()
    test_vision_parse_and_null_size()
    # --- 2026-08-19 clothing-tag OCR ---
    test_ocr_engine_keeps_recognition_scores()
    test_tag_ocr_reads_structured_facts()
    test_tag_ocr_reads_a_blend()
    test_tag_ocr_style_number_needs_a_digit()
    test_tag_ocr_brand_candidates_ignore_care_text()
    test_tag_ocr_ranks_bigger_print_first()
    test_tag_ocr_country_prefers_the_complete_reading()
    test_tag_ocr_fit_words_are_not_brands()
    test_tag_ocr_stops_once_a_real_tag_is_found()
    test_tag_ocr_keeps_looking_when_a_reading_found_nothing()
    test_tag_ocr_size_needs_an_unambiguous_shape()
    test_tag_ocr_reads_the_last_photos()
    test_tag_ocr_prompt_snippet_is_bounded()
    test_tag_ocr_degrades_without_the_engine()
    test_tag_reading_json_is_bounded()
    # --- 2026-08-21 wrapped care labels ---
    test_tag_ocr_reads_a_country_split_across_lines()
    test_tag_ocr_material_does_not_swallow_the_next_sentence()
    test_tag_ocr_stitching_is_additive_and_bounded()
    test_tag_ocr_never_claims_a_country_from_printed_in()
    # --- 2026-09-02 studio props: the ruler is not the item ---
    test_props_ruler_print_never_reaches_the_tag_reading()
    test_props_ocr_misreadings_of_the_ruler_are_recognised()
    test_props_vision_answer_is_scrubbed()
    test_props_every_sentence_shape_the_model_used()
    test_props_scrub_tool_plans_only_what_the_ruler_touched()
    test_props_title_lines_lose_the_ruler_tokens()
    test_props_a_number_only_the_ruler_carried_is_never_a_style_number()
    test_props_the_ocr_record_keeps_the_ruler_marked()
    test_props_a_registration_number_is_never_a_style_number()
    test_props_a_photo_of_nothing_but_numbers_is_a_measuring_tool()
    # --- 2026-08-19 brand / attribute normalization ---
    test_normalize_canonicalizes_known_brands()
    test_normalize_only_suggests_a_near_miss()
    test_normalize_leaves_unknown_values_alone()
    test_normalize_short_names_are_never_fuzzy_matched()
    test_normalize_other_attribute_families()
    test_normalize_survives_a_missing_table()
    # --- 2026-08-19 per-attribute evidence ---
    test_evidence_agreement_is_verified()
    test_evidence_tolerates_ocr_word_joining()
    test_evidence_conflict_is_uncertain_and_keeps_both()
    test_evidence_vision_only_is_inferred()
    test_evidence_ocr_fills_gaps_but_never_overwrites()
    test_evidence_country_and_style_number_come_only_from_a_label()
    test_evidence_a_near_miss_spelling_downgrades_the_field()
    test_evidence_summary_counts()
    # --- 2026-08-19 listing editor / push to Nifty ---
    # --- 2026-09-05 auto-run failures: closed enums, required sub-types, stray pages ---
    # --- 2026-09-06 second run: sizes the picker refuses, colors, intimates ---
    # --- 2026-09-06 third run: failed photo uploads, kids' branches, the repair pass ---
    print()
    if _failures:
        print(f"FAILED ({len(_failures)}): {', '.join(_failures)}")
        return 1
    print("ALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
