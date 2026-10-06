import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.depop_form import size_candidates, choose_option


class DepopChildSizeTests(unittest.TestCase):
    def test_numeric_child_jeans_tag_selects_the_exact_native_year_label(self):
        options=[{'label':'7 years'}, {'label':'8 years'}, {'label':'9 years'}]
        self.assertEqual(choose_option(options, size_candidates('8','Jeans','Boys')), {'label':'8 years'})
        self.assertEqual(size_candidates('8','Jeans','Women'), ['8'])
        self.assertEqual(size_candidates('8','Shoes','Boys'), ['8'])
        self.assertEqual(size_candidates('18','Jeans','Boys'), ['18'])
        self.assertIsNone(choose_option([{'label':'7 years'}],size_candidates('8','Jeans','Boys')))


if __name__ == '__main__': unittest.main()
