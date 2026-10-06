import os
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch, call
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.etsy_form import (reviewed_core, choose_vintage_era, fill_reviewed_core,
    category_label, choose_size_scale, shipping_values, attach_photos, verify_photos)


def item():
    return {"sku": "000108", "title": "Reviewed tank top", "description": "Reviewed condition and measurements.",
            "price": 24.99, "quantity": 1, "trueVintage": True, "whenMade": "Before 2007 (Vintage)"}


def choices():
    return [{"group": "Recently", "text": "2007 - 2009", "value": "2007_2009", "disabled": False},
            {"group": "Vintage", "text": "Before 2007", "value": "before_2007", "disabled": False},
            {"group": "Vintage", "text": "1990s", "value": "1990s", "disabled": False}]


class EtsyFormTests(unittest.TestCase):
    def test_verified_tshirt_category_can_use_its_unqualified_us_letter_scale(self):
        value={'department':'Men','itemType':'T-shirt','size':'XL'}
        generic=[{'text':'US letter','value':'42'}]
        self.assertEqual(choose_size_scale(value,generic),'42')
        self.assertEqual(value['size'],'XL')
        self.assertEqual(choose_size_scale(value,generic+[{'text':"US men's letter",'value':'41'}]),'41')
        with self.assertRaises(ValueError):choose_size_scale(value,generic+[{'text':"US women's letter",'value':'25'}])

    def test_shorts_use_their_offered_us_letter_scale_without_converting_title_size(self):
        item={'department':'Men','itemType':'Shorts','size':'M'}
        scales=[{'text':'in','value':'43'},{'text':'US letter','value':'44'},{'text':'cm','value':'73'}]
        self.assertEqual(choose_size_scale(item,scales),'44')
        self.assertEqual(item['size'],'M')
        with self.assertRaises(ValueError):choose_size_scale(item,[{'text':"US women's letter",'value':'25'}])
        self.assertEqual(category_label({'department':'Women','itemType':'Long Sleeve T-shirt'}),"Women's T-Shirts")

    def test_category_search_preserves_reviewed_department_including_unisex(self):
        self.assertEqual(category_label({"department": "Women", "itemType": "Tank Top"}), "Women's Tank Tops")
        self.assertEqual(category_label({"department": "Unisex Adults", "itemType": "T-shirt"}), "Gender-Neutral Adult T-Shirts")
        self.assertEqual(category_label({"department": "Men", "itemType": "long sleeve button down"}), "Men's Oxfords & Button Downs")
        for value in [{"department": "Kids", "itemType": "T-shirt"}, {"department": "Women", "itemType": "Unknown"}]:
            with self.assertRaises(ValueError): category_label(value)

    def test_mens_button_front_leaf_preserves_letter_size_in_its_offered_scale(self):
        scales=[{'text':'in','value':'41'},{'text':'US letter','value':'42'},{'text':'cm','value':'70'}]
        for kind in ['long sleeve button down','Button-down Shirt','Button-up Shirt']:
            item={'department':'Men','itemType':kind,'size':'XL'}
            self.assertEqual(category_label(item),"Men's Oxfords & Button Downs")
            self.assertEqual(choose_size_scale(item,scales),'42')
            self.assertEqual(item['size'],'XL')
            with self.assertRaises(ValueError):choose_size_scale(item,[{'text':'EU numeric','value':'71'}])
        self.assertEqual(category_label({'department':'Women','itemType':'buttondown'}),"Women's Tops & Tees")
        with self.assertRaises(ValueError):
            choose_size_scale({'department':'Women','itemType':'buttondown','size':'XL'},scales)

    def test_size_scale_cannot_leak_from_previous_gender_or_convert_letter_to_numeric(self):
        scales = [{"text": "US women's letter", "value": "25"}, {"text": "US women's numeric", "value": "24"},
                  {"text": "US letter", "value": "51"}]
        self.assertEqual(choose_size_scale({"department": "Women", "size": "Large"}, scales), "25")
        self.assertEqual(choose_size_scale({"department": "Women", "size": "12"}, scales), "24")
        self.assertEqual(choose_size_scale({"department": "Unisex", "size": "L"}, scales), "51")
        for value in [{"department": "Men", "size": "L"}, {"department": "Kids", "size": "L"}]:
            with self.assertRaises(ValueError): choose_size_scale(value, scales)
        with self.assertRaises(ValueError): choose_size_scale({"department": "Unisex", "size": "L"}, scales[:2])

    def test_shipping_splits_ounces_without_rounding_away_reviewed_measurements(self):
        result = shipping_values({"weightOz": 26.4, "packageDims": {"length": 12.5, "width": 10, "height": 0.75}})
        self.assertEqual(result["#listing-weight-primary-input"], "1")
        self.assertEqual(result["#listing-weight-secondary-input"], "10.4")
        self.assertEqual(result["#shipping_item_dimension-itemHeight"], "0.75")
        for weight in [0, True, float("nan")]:
            with self.assertRaises(ValueError): shipping_values({"weightOz": weight, "packageDims": {"length": 1, "width": 1, "height": 1}})

    def test_photo_timeout_checks_the_result_instead_of_uploading_a_second_time(self):
        from playwright.sync_api import TimeoutError as BrowserTimeout
        with tempfile.TemporaryDirectory() as directory:
            photo = Path(directory, "000108_01.jpg")
            photo.write_bytes(b"fixture")
            page = MagicMock()
            page.locator.return_value.count.return_value = 1
            page.locator.return_value.set_input_files.side_effect = BrowserTimeout("input replaced")
            with patch("black_cat_worker.etsy_form.photo_snapshot", return_value=[]), \
                    patch("black_cat_worker.etsy_form.verify_photos", return_value=1) as verify:
                self.assertEqual(attach_photos(page, [str(photo)]), 1)
            page.locator.return_value.set_input_files.assert_called_once()
            verify.assert_called_once_with(page, 1)

    def test_photos_require_full_remote_completion_and_correct_positions(self):
        page = MagicMock()
        with patch("black_cat_worker.etsy_form.photo_snapshot", return_value=[{"ready": True, "alt": "Primary listing image"}]):
            self.assertEqual(verify_photos(page, 1, timeout=0), 1)
        for snapshot in [[], [{"ready": False, "alt": "Primary listing image"}],
                         [{"ready": True, "alt": "Edit Listing image 2"}], [{"ready": True}] * 2]:
            with patch("black_cat_worker.etsy_form.photo_snapshot", return_value=snapshot), self.assertRaises(ValueError):
                verify_photos(page, 1, timeout=0)

    def test_rejected_large_photo_batch_sends_originals_in_verified_order(self):
        from playwright.sync_api import Error as BrowserError, TimeoutError as BrowserTimeout
        with tempfile.TemporaryDirectory() as directory:
            photos=[str(Path(directory,name)) for name in ['first.jpg','second.jpg']]
            for photo in photos:Path(photo).write_bytes(b'original')
            page=MagicMock();initial=MagicMock();added=MagicMock()
            page.locator.side_effect=lambda selector: added if 'empty-photo-thumbnail' in selector else initial
            initial.count.return_value=1;initial.is_enabled.return_value=True
            added.count.return_value=1;added.is_enabled.return_value=True
            events=[]
            def select(value,**kwargs):
                if isinstance(value,list):raise BrowserError('Cannot transfer files larger than 50Mb to a browser not co-located with the server')
                events.append(('selected',value))
            initial.set_input_files.side_effect=select
            def add(value,**kwargs):
                events.append(('selected',value));raise BrowserTimeout('selection still processing')
            added.set_input_files.side_effect=add
            with patch('black_cat_worker.etsy_form.photo_snapshot',return_value=[]), \
                 patch('black_cat_worker.etsy_form.verify_photos',side_effect=lambda page,count:events.append(('verified',count))):
                self.assertEqual(attach_photos(page,photos),2)
            self.assertEqual(events,[('selected',photos[0]),('verified',1),('selected',photos[1]),('verified',2)])
            self.assertEqual(initial.set_input_files.call_args_list,[call(photos,timeout=120000),call(photos[0],timeout=120000)])
            added.set_input_files.assert_called_once_with(photos[1],timeout=120000)
            for photo in photos:self.assertEqual(Path(photo).read_bytes(),b'original')

    def test_large_transfer_fallback_requires_an_unchanged_empty_gallery(self):
        from playwright.sync_api import Error as BrowserError
        with tempfile.TemporaryDirectory() as directory:
            photo=Path(directory,'first.jpg');photo.write_bytes(b'original');page=MagicMock()
            page.locator.return_value.count.return_value=1
            page.locator.return_value.set_input_files.side_effect=BrowserError('Cannot transfer files larger than 50Mb to a browser not co-located with the server')
            with patch('black_cat_worker.etsy_form.photo_snapshot',side_effect=[[],[{'ready':True}]]):
                with self.assertRaisesRegex(ValueError,'gallery changed'):attach_photos(page,[str(photo)])
            page.locator.return_value.set_input_files.assert_called_once()

    def test_unrelated_photo_errors_do_not_retry_the_selection(self):
        from playwright.sync_api import Error as BrowserError
        with tempfile.TemporaryDirectory() as directory:
            photo=Path(directory,'first.jpg');photo.write_bytes(b'original');page=MagicMock()
            page.locator.return_value.count.return_value=1
            page.locator.return_value.set_input_files.side_effect=BrowserError('File unreadable')
            with patch('black_cat_worker.etsy_form.photo_snapshot',return_value=[]):
                with self.assertRaisesRegex(BrowserError,'File unreadable'):attach_photos(page,[str(photo)])
            page.locator.return_value.set_input_files.assert_called_once()

    def test_age_is_never_inferred_from_title_material_or_form_defaults(self):
        value = {**item(), "trueVintage": False, "title": "Vintage wool sweater", "material": "100% Wool"}
        with self.assertRaisesRegex(ValueError, "True Vintage"): reviewed_core(value)
        with self.assertRaises(ValueError): reviewed_core({**item(), "whenMade": None})

    def test_price_and_quantity_are_not_silently_changed(self):
        self.assertEqual(reviewed_core(item())["price"], "24.99")
        for override in [{"price": 24.999}, {"price": True}, {"quantity": 2}, {"quantity": True}]:
            with self.subTest(override=override), self.assertRaises(ValueError): reviewed_core({**item(), **override})

    def test_era_uses_the_exact_vintage_group_not_a_shared_year(self):
        self.assertEqual(choose_vintage_era("Before 2007 (Vintage)", choices()), "before_2007")
        self.assertEqual(choose_vintage_era("1990s (Vintage)", choices()), "1990s")
        for value in ["2007 - 2009 (Recently)", "1980s (Vintage)", "2007"]:
            with self.subTest(value=value), self.assertRaises(ValueError): choose_vintage_era(value, choices())

    def test_disabled_or_duplicate_vintage_options_are_rejected(self):
        for options in [[{**choices()[1], "disabled": True}], [choices()[1], choices()[1]]]:
            with self.assertRaises(ValueError): choose_vintage_era("Before 2007 (Vintage)", options)

    def test_ineligible_item_stops_before_touching_the_form(self):
        page = MagicMock()
        with self.assertRaises(ValueError): fill_reviewed_core(page, {**item(), "trueVintage": False})
        page.locator.assert_not_called()
        page.get_by_role.assert_not_called()

    def test_core_fill_overwrites_the_prior_era_and_never_saves_or_publishes(self):
        page = MagicMock()
        page.locator.return_value.locator.return_value.evaluate_all.return_value = choices()
        with patch("playwright.sync_api.expect"):
            result = fill_reviewed_core(page, item())
        page.locator.return_value.select_option.assert_called_once_with("before_2007")
        self.assertTrue(result["whenMade"])
        self.assertFalse(any(call.kwargs.get("name") in {"Publish", "Save as draft"} for call in page.get_by_role.call_args_list))


if __name__ == "__main__": unittest.main()
