from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.petite_size import petite_size_base


class PetiteSizeTests(unittest.TestCase):
    def item(self):
        return {'size':'6P','itemType':'Shorts','title':'Blue shorts size 6P Petite',
                'description':'Denim shorts. Size 6P petite.'}

    def test_approved_mapping_retains_the_original_item_and_stays_scoped(self):
        item=self.item();before=dict(item)
        self.assertEqual(petite_size_base(item,'Women'),'6')
        self.assertEqual(item,before)
        self.assertIsNone(petite_size_base(item,'Men'))
        self.assertIsNone(petite_size_base({**item,'size':'8P'},'Women'))
        self.assertIsNone(petite_size_base({**item,'itemType':'Jeans'},'Women'))

    def test_each_copy_field_must_disclose_both_the_size_and_petite_fit(self):
        for field in ['title','description']:
            for text in ['Size 6P shorts','Petite shorts','Size 16P petite shorts']:
                with self.subTest(field=field,text=text):
                    with self.assertRaisesRegex(ValueError,'both title and description'):
                        petite_size_base({**self.item(),field:text},'Women')
