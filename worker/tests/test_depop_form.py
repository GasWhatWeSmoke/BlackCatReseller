import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.depop_form import category_path, choose_option, department, parcel_option, size_candidates
from black_cat_worker import depop_form


class DepopFormTests(unittest.TestCase):
    def test_olive_and_beige_use_available_color_families_without_changing_copy(self):
        for shade, family in [('Olive','Green'),('Beige','Tan')]:
            with self.subTest(shade=shade):
                page, control = MagicMock(), MagicMock()
                page.get_by_role.return_value = control
                control.count.return_value = 1
                control.get_attribute.return_value = None
                values = [shade, family]
                with patch.object(depop_form,'_selected_colors',side_effect=[[],[],[family]]), \
                     patch.object(depop_form,'_open_options',return_value=(control,[{'id':'color-choice','label':family}])):
                    self.assertEqual(depop_form._fill_colors(page,values),[family])
                self.assertEqual(values,[shade,family])
                page.locator.return_value.click.assert_called_once()

    def test_teal_uses_blue_without_duplicating_an_existing_blue_choice(self):
        page, control = MagicMock(), MagicMock()
        page.get_by_role.return_value = control
        control.count.return_value = 1
        control.get_attribute.return_value = None
        option = {'id':'blue-option','label':'Blue'}
        with patch.object(depop_form,'_selected_colors',side_effect=[[],[],['Blue']]), \
             patch.object(depop_form,'_open_options',return_value=(control,[option])):
            self.assertEqual(depop_form._fill_colors(page,['Teal','Blue']),['Blue'])
        page.locator.assert_called_once_with('[id="blue-option"]')
        page.locator.return_value.click.assert_called_once()

    def test_package_reopens_after_empty_snapshot_or_replaced_option(self):
        from playwright.sync_api import TimeoutError as BrowserTimeout
        page, control = MagicMock(), MagicMock()
        option = {"id": "small", "label": "Extra small", "text": "Extra smallUnder 8oz"}
        control.input_value.return_value = "Extra small"
        control.get_attribute.return_value = "false"
        with patch.object(depop_form, '_open_options', side_effect=[(control, []), (control, [option]), (control, [option])]), \
             patch.object(depop_form, '_select', side_effect=[BrowserTimeout('option detached'), 'Extra small']) as select:
            self.assertEqual(depop_form.select_package(page, 6), 'Extra small')
            self.assertEqual(select.call_count, 2)
            self.assertEqual(control.press.call_count, 2)
        for options, failure in [([], None), ([option], BrowserTimeout('option stays hidden'))]:
            with self.subTest(options=options), \
                 patch.object(depop_form, '_open_options', return_value=(control, options)) as opened, \
                 patch.object(depop_form, '_select', side_effect=failure):
                with self.assertRaisesRegex(ValueError, 'did not retain'):
                    depop_form.select_package(page, 6)
                self.assertEqual(opened.call_count, 3)

    def test_unbranded_fallback_accepts_sanitized_copy_only_with_explicit_approval(self):
        item = {"title": "Heroes & Villains graphic shirt"}
        fields = {"brand": "Unbranded", "description": "Black cotton graphic shirt."}
        with patch.object(depop_form, "_select_field", side_effect=ValueError("No matching Depop Brand option")):
            with self.assertRaisesRegex(ValueError, "approve its Other fallback"):
                depop_form.select_brand(None, item, fields, {})
        with patch.object(depop_form, "_select_field", side_effect=[ValueError("No matching Depop Brand option"), "Other"]):
            self.assertEqual(depop_form.select_brand(None, item, fields, {"unlistedBrands": ["Unbranded"]}), "Other")

    def test_shipping_can_retry_an_uncommitted_selection_but_keeps_missing_choices_as_errors(self):
        page, control = MagicMock(), MagicMock()
        option = {"id":"small", "label":"Extra small", "text":"Extra smallUnder 8oz"}
        control.input_value.return_value = 'Extra small'
        control.get_attribute.return_value = 'false'
        with patch.object(depop_form, '_open_options', return_value=(control,[option])), \
             patch.object(depop_form, '_select', side_effect=[ValueError('Depop Package size selection was not confirmed'),'Extra small']):
            self.assertEqual(depop_form.select_package(page,6),'Extra small')
            control.press.assert_called_once_with('Escape')
        with patch.object(depop_form, '_open_options', return_value=(control,[option])), \
             patch.object(depop_form, '_select', side_effect=ValueError('No matching Depop Package size option')) as select:
            with self.assertRaisesRegex(ValueError,'No matching'):
                depop_form.select_package(page,6)
            self.assertEqual(select.call_count,1)

    def test_shipping_reselects_a_reset_package_but_never_accepts_a_persistently_blank_one(self):
        page, control = MagicMock(), MagicMock()
        option = {"id": "small", "label": "Extra small", "text": "Extra smallUnder 8oz"}
        control.input_value.side_effect = ["", "Extra small"]
        control.get_attribute.return_value = "false"
        with patch.object(depop_form, "_open_options", return_value=(control, [option])), \
             patch.object(depop_form, "_select", return_value="Extra small") as select:
            self.assertEqual(depop_form.select_package(page, 6), "Extra small")
            self.assertEqual(select.call_count, 2)
        control.input_value.side_effect = None
        control.input_value.return_value = ""
        with patch.object(depop_form, "_open_options", return_value=(control, [option])), \
             patch.object(depop_form, "_select", return_value="Extra small") as select:
            with self.assertRaisesRegex(ValueError, "did not retain"):
                depop_form.select_package(page, 6)
            self.assertEqual(select.call_count, 3)

    def test_form_passes_brand_approval_separately_from_category_options(self):
        page = MagicMock()
        page.get_by_role.return_value.input_value.return_value = "La Vida shirt"
        item = {"title": "La Vida shirt", "department": "Men", "itemType": "T-shirt"}
        fields = {"brand": "La Vida", "description": "La Vida shirt"}
        approvals = {"unlistedBrands": ["La Vida"]}
        with patch.object(depop_form, "_open_options", return_value=(MagicMock(), [])), \
             patch.object(depop_form, "_select", return_value="T-shirts"), \
             patch.object(depop_form, "select_brand", side_effect=RuntimeError("brand checkpoint")) as brand:
            with self.assertRaisesRegex(RuntimeError, "brand checkpoint"):
                depop_form.fill_listing_fields(page, item, fields, approvals)
            brand.assert_called_once_with(page, item, fields, approvals)

    def test_approved_brand_prefers_exact_native_option(self):
        with patch.object(depop_form, "_select_field", return_value="La Vida") as selected:
            self.assertEqual(depop_form.select_brand(None, {}, {"brand": "La Vida"}, {"unlistedBrands": ["La Vida"]}), "La Vida")
            selected.assert_called_once_with(None, "Brand", ["La Vida"], search="La Vida")

    def test_explicit_brand_alias_is_searched_before_other_fallback(self):
        fields={"brand":"abercrombie and fitch"}
        with patch.object(depop_form,"_select_field",side_effect=[ValueError("No matching Depop Brand option"),"Abercrombie & Fitch"]) as selected:
            self.assertEqual(depop_form.select_brand(None,{},fields,{}),"Abercrombie & Fitch")
        self.assertEqual([call.kwargs['search'] for call in selected.call_args_list],["abercrombie and fitch","Abercrombie & Fitch"])
        self.assertEqual(selected.call_args.args[2],["abercrombie and fitch","Abercrombie & Fitch"])
        self.assertEqual(fields['brand'],"abercrombie and fitch")

    def test_brand_lookup_never_uses_a_fuzzy_spelling_suggestion(self):
        with patch('black_cat_worker.normalize._index_for',return_value={'patagonia':'Patagonia'}), \
             patch.object(depop_form,'_select_field',side_effect=ValueError('No matching Depop Brand option')) as selected:
            with self.assertRaisesRegex(ValueError,'approve'):
                depop_form.select_brand(None,{}, {'brand':'Patagoni'}, {})
        selected.assert_called_once_with(None,'Brand',['Patagoni'],search='Patagoni')

    def test_missing_brand_requires_approval_and_preserved_actual_copy(self):
        item = {"title": "La Vida shirt"}
        fields = {"brand": "La Vida", "description": "La Vida original shirt"}
        for options, title, description in [({}, item["title"], fields["description"]),
                ({"unlistedBrands": ["Other Brand"]}, item["title"], fields["description"]),
                ({"unlistedBrands": ["La Vida"]}, "shirt", fields["description"]),
                ({"unlistedBrands": ["La Vida"]}, item["title"], "shirt")]:
            with patch.object(depop_form, "_select_field", side_effect=ValueError("No matching Depop Brand option")) as selected:
                with self.assertRaises(ValueError):
                    depop_form.select_brand(None, {"title": title}, {**fields, "description": description}, options)
                self.assertEqual(selected.call_count, 1)
        with patch.object(depop_form, "_select_field", side_effect=[ValueError("No matching Depop Brand option"), "Other"]) as selected:
            self.assertEqual(depop_form.select_brand(None, item, fields, {"unlistedBrands": ["La Vida"]}), "Other")
            self.assertEqual(selected.call_args.args, (None, "Brand", ["Other"]))
        self.assertEqual(fields["brand"], "La Vida")

    def test_brand_fallback_does_not_hide_widget_failures_or_accept_missing_other(self):
        for reason in ["Depop Brand selection was not confirmed", "The marketplace offered ambiguous matching options"]:
            with patch.object(depop_form, "_select_field", side_effect=ValueError(reason)) as selected:
                with self.assertRaisesRegex(ValueError, reason):
                    depop_form.select_brand(None, {}, {"brand": "La Vida"}, {"unlistedBrands": ["La Vida"]})
                self.assertEqual(selected.call_count, 1)
        with patch.object(depop_form, "_select_field", side_effect=ValueError("No matching Depop Brand option")) as selected:
            with self.assertRaisesRegex(ValueError, "No matching"):
                depop_form.select_brand(None, {"title": "La Vida"}, {"brand": "La Vida", "description": "La Vida"}, {"unlistedBrands": ["La Vida"]})
            self.assertEqual(selected.call_count, 2)

    def test_department_prevents_a_womens_tee_from_using_the_first_mens_option(self):
        options = [
            {"id": "men", "label": "T-shirts", "group": "Men > Tops"},
            {"id": "women", "label": "T-shirts", "group": "Women > Tops"},
            {"id": "kids", "label": "T-shirts", "group": "Kids > Tops"},
        ]
        group, label = category_path({"department": "Women", "itemType": "T-shirt"})
        self.assertEqual(choose_option(options, [label], group)["id"], "women")
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            choose_option(options, [label])

    def test_unisex_uses_men_as_requested_without_guessing_a_blank_department(self):
        self.assertEqual(department("Unisex"), "Men")
        self.assertEqual(department("Unisex Adults"), "Men")
        self.assertEqual(department("Women"), "Women")
        with self.assertRaises(ValueError):
            department(None)

    def test_specific_types_do_not_match_short_substrings_in_another_garment(self):
        cases = {
            "Sweatshirt": ("Tops", "Sweatshirts"), "Bracelet": ("Accessories", "Jewelry"),
            "Bralette": ("Underwear", "Bras"), "Tank Top": ("Tops", "Tank tops and camis"),
            "Polo Shirt": ("Tops", "Polo shirts"), "Long Sleeve Shirt": ("Tops", "Shirts"),
            "long sleeve button down": ("Tops", "Shirts"), "Shoulder Bag": ("Accessories", "Bags"),
            "Skirt": ("Bottoms", "Skirts"), "Jeans": ("Bottoms", "Jeans"), "Tube Top": ("Tops", "Other"),
        }
        for item_type, (group, label) in cases.items():
            with self.subTest(item_type=item_type):
                self.assertEqual(category_path({"department": "Women", "itemType": item_type}), (f"Women > {group}", label))

    def test_medium_never_selects_maternity_or_a_typed_only_non_option(self):
        options = [{"id": "maternity", "label": "Maternity"}, {"id": "medium", "label": "M"}]
        self.assertEqual(choose_option(options, size_candidates("Medium", "T-shirt"))["id"], "medium")
        self.assertIsNone(choose_option(options[:1], ["M"]))
        self.assertIsNone(choose_option([{"id": "m", "label": "M", "disabled": True}], ["M"]))

    def test_waist_inseam_split_only_applies_to_bottoms(self):
        self.assertIn("32", size_candidates("32x34", "Jeans"))
        self.assertNotIn("32", size_candidates("32x34", "T-shirt"))

    def test_parcel_uses_live_capacities_even_when_option_order_and_labels_change(self):
        options = [
            {"label": "Small", "text": "SmallUnder 12oz"},
            {"label": "Extra small", "text": "Extra smallUnder 8oz"},
            {"label": "Medium", "text": "MediumUnder 1lb"},
            {"label": "Large", "text": "LargeUnder 2lb"},
            {"label": "Extra extra small", "text": "Extra extra smallUnder 4oz"},
        ]
        self.assertEqual(parcel_option(options, 3)["label"], "Extra extra small")
        self.assertEqual(parcel_option(options, 8)["label"], "Small")
        self.assertEqual(parcel_option(options, 15)["label"], "Medium")
        self.assertEqual(parcel_option(options, 16)["label"], "Large")
        with self.assertRaises(ValueError):
            parcel_option(options, 40)

    def test_unknown_types_and_unreadable_parcel_limits_stop_for_review(self):
        with self.assertRaises(ValueError):
            category_path({"department": "Men", "itemType": "Unidentified garment"})
        with self.assertRaises(ValueError):
            parcel_option([{"label": "Small", "text": "Small"}], 10)

    def test_brand_search_waits_for_the_exact_brand_without_selecting_the_kids_variant(self):
        page, control = MagicMock(), MagicMock()
        exact = {"id": "adult", "label": "Quiksilver"}
        kids = {"id": "kids", "label": "Quiksilver Kids"}
        with patch.object(depop_form, "_open_options", return_value=(control, [])) as opened, \
             patch.object(depop_form, "_option_snapshot", side_effect=[[kids], [kids, exact]]), \
             patch.object(depop_form, "_select", return_value="Quiksilver") as selected:
            self.assertEqual(depop_form._select_field(page, "Brand", ["Quiksilver"], "Quiksilver"), "Quiksilver")
        opened.assert_called_once()
        selected.assert_called_once_with(page, control, exact, "Brand")
        self.assertEqual(page.wait_for_timeout.call_count, 2)

    def test_matching_native_brand_selection_is_kept_but_typed_text_is_not_accepted(self):
        page, control = MagicMock(), MagicMock()
        page.get_by_role.return_value = control
        control.input_value.return_value = "Quiksilver"
        control.get_attribute.return_value = "false"
        clear = control.locator.return_value.get_by_role.return_value
        clear.count.return_value = 1
        with patch.object(depop_form, "_open_options") as opened:
            self.assertEqual(depop_form._select_field(page, "Brand", ["Quiksilver"], "Quiksilver"), "Quiksilver")
            opened.assert_not_called()
        clear.count.return_value = 0
        with patch.object(depop_form, "_open_options", return_value=(control, [])), \
             patch.object(depop_form, "_option_snapshot", return_value=[]):
            with self.assertRaisesRegex(ValueError, "No matching"):
                depop_form._select_field(page, "Brand", ["Quiksilver"], "Quiksilver")

    def test_selection_waits_for_the_widget_to_commit_its_value(self):
        page, control = MagicMock(), MagicMock()
        control.input_value.side_effect = ["", "Extra small"]
        control.get_attribute.return_value = "false"
        option = {"id": "shipping-item-1", "label": "Extra small"}
        self.assertEqual(depop_form._select(page, control, option, "Package size"), "Extra small")
        page.wait_for_timeout.assert_called_once_with(100)
        control.input_value.side_effect = None
        control.input_value.return_value = "wrong value"
        with self.assertRaisesRegex(ValueError, "not confirmed"):
            depop_form._select(page, control, option, "Package size")

    def test_native_brand_arriving_during_search_is_cleared_then_explicitly_selected(self):
        page, control = MagicMock(), MagicMock()
        page.get_by_role.return_value = control
        control.input_value.return_value = "Quiksilver"
        clear = control.locator.return_value.get_by_role.return_value
        clear.count.side_effect = [0, 1]
        exact = {"id": "adult", "label": "Quiksilver"}
        with patch.object(depop_form, "_open_options", side_effect=[(control, []), (control, [exact])]) as opened, \
             patch.object(depop_form, "_select", return_value="Quiksilver") as selected:
            self.assertEqual(depop_form._select_field(page, "Brand", ["Quiksilver"], "Quiksilver"), "Quiksilver")
        self.assertEqual(opened.call_count, 2)
        clear.click.assert_called_once()
        selected.assert_called_once_with(page, control, exact, "Brand")


if __name__ == "__main__":
    unittest.main()
