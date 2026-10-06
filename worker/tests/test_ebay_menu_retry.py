import sys
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
from playwright.sync_api import TimeoutError as BrowserTimeout

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import ebay_form


class EbayMenuRetryTests(unittest.TestCase):
    def test_transient_duplicate_or_unretained_picker_retries_the_same_value(self):
        for name,value,error in [('Color','Black','eBay choice is ambiguous: Black'),('Brand','LandLubber','eBay did not retain Brand')]:
            page,field=MagicMock(),MagicMock();field.evaluate.return_value='BUTTON'
            with patch.object(ebay_form,'control',return_value=field), \
                 patch.object(ebay_form,'_set_field_once',side_effect=[ValueError(error),value]) as select:
                self.assertEqual(ebay_form.set_field(page,[name],value),value)
                self.assertEqual(select.call_count,2)
                for call in select.call_args_list:self.assertEqual(call.args,(page,[name],value,(),None))
                field.press.assert_called_once_with('Escape')

    def test_persistent_duplicates_remain_blocked_and_other_field_errors_are_not_retried(self):
        for tag,message,attempts in [('BUTTON','eBay choice is ambiguous: Black',3),('BUTTON','eBay did not retain Color',3),('INPUT','eBay did not retain Color',1),('BUTTON','eBay did not retain Brand',1),('BUTTON','eBay does not offer the reviewed choice: Black',1)]:
            page,field=MagicMock(),MagicMock();field.evaluate.return_value=tag
            with patch.object(ebay_form,'control',return_value=field), \
                 patch.object(ebay_form,'_set_field_once',side_effect=ValueError(message)) as select:
                with self.assertRaisesRegex(ValueError,'eBay'):
                    ebay_form.set_field(page,['Color'],'Black')
                self.assertEqual(select.call_count,attempts)

    def test_rebuilt_dropdown_retries_same_reviewed_choice_without_reuploading(self):
        page, field = MagicMock(), MagicMock()
        field.evaluate.return_value = 'BUTTON'
        with patch.object(ebay_form,'control',return_value=field), \
             patch.object(ebay_form,'_set_field_once',side_effect=[BrowserTimeout('Menu disappeared'),'Unisex Adults']) as select:
            self.assertEqual(ebay_form.set_field(page,['Department'],'Unisex Adults',['Unisex']),'Unisex Adults')
            self.assertEqual(select.call_count,2)
            for call in select.call_args_list:
                self.assertEqual(call.args,(page,['Department'],'Unisex Adults',['Unisex'],None))
            field.press.assert_called_once_with('Escape')

    def test_missing_choices_and_input_mismatches_are_not_retried_and_menu_retries_are_bounded(self):
        page, field = MagicMock(), MagicMock()
        for tag, error, attempts in [('BUTTON',ValueError('No reviewed choice'),1),
                                     ('INPUT',AssertionError('Wrong input value'),1),
                                     ('BUTTON',BrowserTimeout('Menu disappeared'),3)]:
            field.evaluate.return_value=tag
            with patch.object(ebay_form,'control',return_value=field), \
                 patch.object(ebay_form,'_set_field_once',side_effect=error) as select:
                with self.assertRaises(type(error)):
                    ebay_form.set_field(page,['Department'],'Unisex Adults')
                self.assertEqual(select.call_count,attempts)
