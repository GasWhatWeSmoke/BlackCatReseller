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






def test_levenshtein():
    print("levenshtein:")
    check("identical", S.levenshtein("000001", "000001") == 0)
    check("one sub", S.levenshtein("000001", "000002") == 1)
    check("empty", S.levenshtein("", "abc") == 3)


def _p(name, sku=None):
    return DecodedPhoto(path=f"/x/{name}", filename=name, sku=sku,
                        decoded_raw=("BC-" + sku) if sku else None)














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








def test_levenshtein_edge():
    print("levenshtein / edge cases (HARDENING):")
    check("both empty -> 0", S.levenshtein("", "") == 0)
    check("pure insertion", S.levenshtein("abc", "abcd") == 1)
    check("pure deletion", S.levenshtein("abcd", "abc") == 1)
    check("transposition costs 2", S.levenshtein("ab", "ba") == 2)
    check("a empty -> len(b)", S.levenshtein("", "x") == 1)
    check("b empty -> len(a)", S.levenshtein("x", "") == 1)






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
    check("bare numbers without size-label evidence are not sizes", both.size_candidates == [])
    check("the ruler's own number is its model, however spelled",
          all(P.is_prop_code(v) for v in ("Model 403", "403", "MODEL403", "Empire Model 403", "Mordel 403")))
    check("a real style number is not", not any(P.is_prop_code(v) for v in ("501", "403-0000", "1403", "WPL 10167")))




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
        self.lines = [OcrLine(text) for text in lines]
        self.lines += [OcrLine(text, classification="garment_brand_label") for text in self.brand_candidates]
        self.lines += [OcrLine(text, classification="garment_tagged_size") for text in self.size_candidates]


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












def test_intake_reliability_suite():
    # The old tests accepted guessed digits, synthesized missing SKUs and empty
    # inventory shells. The strict END-marker suite replaces those assertions.
    import unittest
    import importlib.util
    spec = importlib.util.spec_from_file_location("test_intake_reliability", os.path.join(os.path.dirname(__file__), "test_intake_reliability.py"))
    test_intake_reliability = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(test_intake_reliability)
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(test_intake_reliability))
    check("strict intake reliability acceptance suite", result.wasSuccessful())


def main():
    test_intake_reliability_suite()
    test_levenshtein()
    test_decode_engine_status_reports_missing_deps()
    test_parse_capacity_oz()
    # --- HARDENING PASS additions ---
    test_levenshtein_edge()
    test_parse_capacity_oz_edge()
    # --- v1.2/v1.3 grouping-reliability regressions ---
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
    test_props_ocr_misreadings_of_the_ruler_are_recognised()
    test_props_every_sentence_shape_the_model_used()
    test_props_scrub_tool_plans_only_what_the_ruler_touched()
    test_props_title_lines_lose_the_ruler_tokens()
    test_props_a_registration_number_is_never_a_style_number()
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
