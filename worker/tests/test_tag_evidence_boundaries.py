"""Captured tag-text regressions; no OCR engine, model or database is started."""
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import evidence, tag_ocr
from black_cat_worker.ocr_engine import OcrLine


def lines(texts, source="tag.jpg"):
    return [OcrLine(text, confidence=0.99, source=source) for text in texts]


class TagEvidenceBoundariesTests(unittest.TestCase):
    def test_ocr_prompt_does_not_claim_graphic_text_came_from_a_label(self):
        # Captured text from 000001's back graphic; there is no photo-role proof.
        reading = tag_ocr.interpret(lines(["NEONTOUR"], "back-graphic.jpg"))
        snippet = tag_ocr.prompt_snippet(reading)
        self.assertIn('"NEONTOUR"', snippet)
        self.assertIn("photos", snippet)
        self.assertIn("graphics", snippet)
        self.assertIn("does not verify brand or size", snippet)
        self.assertNotIn("directly off", snippet)
        self.assertLess(len(tag_ocr.prompt_snippet(reading, limit=200)), 400)

    def test_captured_fanta_tag_does_not_turn_made_into_fabric(self):
        # Exact text sequence from the native 000022 pilot, with a synthetic path.
        reading = tag_ocr.interpret(lines([
            "Fanta", "M", "COMEXICOO", "100%", "MADE", "COLD WITH LI", "ONCHLOR",
        ]))
        self.assertEqual(reading.fabric, [])
        result, derived = evidence.build_evidence({}, {}, reading)
        self.assertNotIn("material", result)
        self.assertNotIn("material", derived)
        result, derived = evidence.build_evidence({"material": "Cotton"}, {}, reading)
        self.assertEqual(result["material"]["status"], evidence.INFERRED)
        self.assertNotIn("rawOcr", result["material"])
        self.assertEqual(reading.size_candidates, ["M"])
        self.assertIn("FANTA", reading.brand_candidates)

    def test_care_sentence_cannot_be_the_start_of_a_material(self):
        for text in ["100% MADE", "100% MADE IN USA", "95% LINING", "100% IMPORTED"]:
            with self.subTest(text=text):
                self.assertEqual(tag_ocr.extract_fabric([text]), [])
        self.assertEqual(tag_ocr.extract_fabric(["100% MADEIRA LACE"]), [(100, "MADEIRA LACE")])
        self.assertEqual(tag_ocr.extract_fabric(["100% COTTON MADE"]), [(100, "COTTON")])

    def test_different_photos_cannot_supply_halves_of_one_fact(self):
        for first, second in [("100%", "COTTON"), ("MADE", "IN USA")]:
            with self.subTest(first=first):
                reading = tag_ocr.interpret(lines([first], "front.jpg") + lines([second], "back.jpg"))
                self.assertEqual(reading.fabric, [])
                self.assertIsNone(reading.country)
                result, derived = evidence.build_evidence({}, {}, reading)
                self.assertNotIn("material", derived)
                self.assertNotIn("countryOfOrigin", derived)
                self.assertFalse(tag_ocr.has_strong_tag_signal(reading))

    def test_same_photo_wrapping_still_supplies_grounded_material_and_country(self):
        reading = tag_ocr.interpret(lines(["100%", "COTTON", "MADE", "IN MEXICO"]))
        self.assertEqual(reading.fabric, [(100, "COTTON")])
        self.assertEqual(reading.country, "MEXICO")
        result, derived = evidence.build_evidence({}, {}, reading)
        self.assertEqual(derived["material"], "Cotton")
        self.assertEqual(derived["countryOfOrigin"], "Mexico")
        self.assertEqual(result["material"]["status"], evidence.VERIFIED)
        self.assertEqual(result["countryOfOrigin"]["status"], evidence.VERIFIED)

    def test_complete_reads_keep_precedence_over_wrapping_across_photos(self):
        reading = tag_ocr.interpret(lines(["MADE IN VIETNA", "100% COTTON"], "a.jpg")
                                    + lines(["MADE IN VIETNAM", "60% COTTON 40% POLYESTER"], "b.jpg"))
        self.assertEqual(reading.country, "VIETNAM")
        self.assertEqual(reading.fabric, [(100, "COTTON"), (60, "COTTON"), (40, "POLYESTER")])

    def test_reader_keeps_looking_instead_of_stopping_on_a_cross_photo_country(self):
        observations = {
            "first.jpg": [OcrLine("MADE", confidence=0.8)],
            "second.jpg": [OcrLine("IN USA", confidence=0.8)],
            "actual-tag.jpg": [OcrLine("100% COTTON", confidence=0.99)],
        }
        with mock.patch.object(tag_ocr.ocr_engine, "shared_engine", return_value=object()), \
             mock.patch.object(tag_ocr, "_load_for_ocr", side_effect=lambda path: path), \
             mock.patch.object(tag_ocr.ocr_engine, "read_lines", side_effect=lambda path, _engine: observations[path]) as reader:
            reading = tag_ocr.read_tags(["actual-tag.jpg", "second.jpg", "first.jpg"], {"tagOcrMaxPhotos": 3})
        self.assertEqual(reader.call_count, 3)
        self.assertEqual(reading.photos_read, ["first.jpg", "second.jpg", "actual-tag.jpg"])
        self.assertIsNone(reading.country)
        self.assertEqual(reading.fabric, [(100, "COTTON")])


if __name__ == "__main__":
    unittest.main()
