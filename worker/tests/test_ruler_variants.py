import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import props


class RulerVariantTests(unittest.TestCase):
    def test_units_and_model_prefixes_cannot_hide_known_ruler_numbers(self):
        reading = SimpleNamespace(props_ignored=["16", "116"], lines=[])
        raw = {"size": "16 inches", "model": "Model 116", "styleNumber": "116"}
        fields = {"size": "16 Inches"}
        self.assertEqual(props.cross_check(raw, reading, fields), ["model", "styleNumber", "size"])
        self.assertEqual(fields, {})
        self.assertTrue(all(value is None for value in raw.values()))

    def test_explicit_garment_tag_wins_over_matching_ruler_number(self):
        reading = SimpleNamespace(props_ignored=["16", "116"], lines=[SimpleNamespace(text="SIZE 16"), SimpleNamespace(text="STYLE NO. 116")])
        raw = {"size": "16", "model": "Model 116"}
        self.assertEqual(props.cross_check(raw, reading), [])
        self.assertEqual(raw["size"], "16")

    def test_real_product_codes_and_numbers_without_prop_evidence_are_preserved(self):
        reading = SimpleNamespace(props_ignored=["116"], lines=[])
        raw = {"model": "J116", "styleNumber": "116-501", "size": "16"}
        self.assertEqual(props.cross_check(raw, reading), [])
        self.assertEqual(props.cross_check({"size": "16 inches"}, SimpleNamespace(props_ignored=[], lines=[])), [])


if __name__ == "__main__":
    unittest.main()
