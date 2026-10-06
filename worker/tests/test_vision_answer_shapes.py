"""Wrong-shaped model JSON must stay an item failure, never abort the batch."""
from __future__ import annotations

import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

WORKER = Path(__file__).resolve().parents[1]
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from black_cat_worker import evidence, managed_vision, vision


class Answers:
    def __init__(self, answers):
        self.answers = iter(answers)
        self.calls = 0

    def ask(self, *_args, **_kwargs):
        self.calls += 1
        return next(self.answers), {"finish_reason": "stop"}


class VisionAnswerShapeTests(unittest.TestCase):
    def test_parser_rejects_non_objects_without_extracting_nested_items(self):
        for value in [None, True, False, 1, 1.5, "shirt", [], [1],
                      [{"brand": "Nested brand"}], '{"brand":"Encoded brand"}']:
            with self.subTest(value=value):
                self.assertIsNone(vision._parse_json(json.dumps(value)))

    def test_parser_keeps_fences_and_surrounding_prose_for_real_objects(self):
        expected = {"category": "hat", "itemType": "bucket hat"}
        for text in [json.dumps(expected), '```json\n' + json.dumps(expected) + '\n```',
                     'Item details: ' + json.dumps(expected) + ' End.']:
            with self.subTest(text=text):
                self.assertEqual(expected, vision._parse_json(text))

    def test_non_object_answer_gets_one_retry_then_a_valid_answer_is_used(self):
        for bad in ['[1]', 'true', '42', '"shirt"', '[{"itemType":"Wrong item"}]']:
            with self.subTest(answer=bad):
                client = Answers([bad, '{"itemType":"bucket hat"}'])
                enricher = managed_vision.ManagedVisionEnricher({"visionEnabled": True}, client)
                with mock.patch.object(managed_vision.ManagedVisionEnricher, "_encode", return_value="aW1n"):
                    result = enricher.enrich("000001", [{"storedPath": "synthetic.jpg"}])
                self.assertEqual("Bucket Hat", result["fields"]["itemType"])
                self.assertEqual(2, client.calls)

    def test_repeated_bad_answers_do_not_poison_later_items_in_a_hundred_item_loop(self):
        answers = []
        for index in range(100):
            if index == 34:
                answers.append('[{"brand":"Do not select this nested item"}]')
            if index == 67:
                answers.extend(['[1]', 'true'])
            else:
                answers.append('{"itemType":"bucket hat"}')
        client = Answers(answers)
        enricher = managed_vision.ManagedVisionEnricher({"visionEnabled": True}, client)
        with mock.patch.object(managed_vision.ManagedVisionEnricher, "_encode", return_value="aW1n"):
            results = [enricher.enrich(f"{index:06}", [{"storedPath": "synthetic.jpg"}])
                       for index in range(100)]
        self.assertEqual(102, client.calls)
        self.assertEqual(99, sum("fields" in result for result in results))
        self.assertIn("error", results[67])
        self.assertNotIn("fields", results[67])
        self.assertEqual("Bucket Hat", results[68]["fields"]["itemType"])
        self.assertEqual("Bucket Hat", results[-1]["fields"]["itemType"])
        for result in results:
            managed_vision.validate_worker_enrichment(result)

    def test_compatibility_enricher_uses_the_same_object_boundary(self):
        enricher = vision.VisionEnricher({"visionEnabled": True})
        with mock.patch.object(enricher, "_encode", return_value="aW1n"), \
                mock.patch.object(enricher, "_call", side_effect=['[1]', '{"itemType":"bucket hat"}']) as call:
            result = enricher.enrich("000001", [{"storedPath": "synthetic.jpg"}])
        self.assertEqual("Bucket Hat", result["fields"]["itemType"])
        self.assertEqual(2, call.call_count)

    def test_conflicting_style_number_keeps_both_readings_as_uncertain(self):
        parsed = {"styleNumber": "BAD999"}
        reading = SimpleNamespace(lines=[object()], style_numbers=["CK123"])
        records, derived = evidence.build_evidence(parsed, {}, reading)
        self.assertEqual(evidence.UNCERTAIN, records["styleNumber"]["status"])
        self.assertEqual("BAD999", records["styleNumber"]["value"])
        self.assertEqual("CK123", records["styleNumber"]["rawOcr"])
        self.assertNotIn("styleNumber", derived)
        self.assertEqual({"styleNumber": "BAD999"}, parsed)

    def test_style_number_match_checks_all_tag_candidates_and_ignores_case(self):
        reading = SimpleNamespace(lines=[object()], style_numbers=["OTHER", "CK123"])
        records, derived = evidence.build_evidence({"styleNumber": "ck123"}, {}, reading)
        self.assertEqual(evidence.VERIFIED, records["styleNumber"]["status"])
        self.assertEqual("CK123", records["styleNumber"]["rawOcr"])
        self.assertEqual(["vision", "ocr"], records["styleNumber"]["sources"])
        self.assertNotIn("styleNumber", derived)

    def test_model_name_does_not_replace_a_tag_style_number(self):
        reading = SimpleNamespace(lines=[object()], style_numbers=["CK123"])
        records, derived = evidence.build_evidence({"model": "Detroit Jacket"}, {}, reading)
        self.assertEqual("CK123", derived["styleNumber"])
        self.assertEqual("CK123", records["styleNumber"]["value"])
        self.assertEqual(evidence.VERIFIED, records["styleNumber"]["status"])

    def test_conflicting_country_keeps_stored_value_and_label_reading(self):
        parsed = {"countryOfOrigin": "USA"}
        reading = SimpleNamespace(lines=[object()], country="MEXICO")
        records, derived = evidence.build_evidence(parsed, {}, reading)
        self.assertEqual(evidence.UNCERTAIN, records["countryOfOrigin"]["status"])
        self.assertEqual("USA", records["countryOfOrigin"]["value"])
        self.assertEqual("MEXICO", records["countryOfOrigin"]["rawOcr"])
        self.assertNotIn("countryOfOrigin", derived)
        self.assertEqual({"countryOfOrigin": "USA"}, parsed)

    def test_country_evidence_distinguishes_matching_missing_and_unread_tags(self):
        reading = SimpleNamespace(lines=[object()], country="MEXICO")
        matched, derived = evidence.build_evidence({"countryOfOrigin": "Mexico"}, {}, reading)
        self.assertEqual(evidence.VERIFIED, matched["countryOfOrigin"]["status"])
        self.assertNotIn("countryOfOrigin", derived)
        missing, derived = evidence.build_evidence({}, {}, reading)
        self.assertEqual("Mexico", derived["countryOfOrigin"])
        self.assertEqual(evidence.VERIFIED, missing["countryOfOrigin"]["status"])
        unread, derived = evidence.build_evidence({"countryOfOrigin": "Mexico"}, {})
        self.assertEqual(evidence.INFERRED, unread["countryOfOrigin"]["status"])
        self.assertEqual({}, derived)


if __name__ == "__main__":
    unittest.main()
