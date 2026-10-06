import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.poshmark_form import category_path, colors_for, size_label, whole_price, quantity_for, CONDITIONS
from black_cat_worker.depop_form import fill_listing_fields as fill_depop


class PoshmarkFormTests(unittest.TestCase):
    def test_boys_jeans_use_kids_bottoms_but_other_unmapped_children_still_stop(self):
        self.assertEqual(category_path({'department':'Boys','itemType':'Jeans'}),('Kids','Bottoms'))
        for item in [{'department':'Kids','itemType':'Jeans'},{'department':'Boys','itemType':'Shirt'}]:
            with self.assertRaises(ValueError):category_path(item)

    def test_lowercase_standard_sizes_select_uppercase_marketplace_labels(self):
        from black_cat_worker.poshmark_form import size_label
        for raw,expected in [(' m ','M'),('s','S'),('l','L'),('xs','XS'),('xl','XL'),('Medium','M')]:
            self.assertEqual(size_label(raw),expected)
        self.assertEqual(size_label('6P'),'6P')
        self.assertEqual(size_label('One Size'),'One Size')

    def test_hoodies_and_sweatshirts_keep_the_correct_department_top_category(self):
        for kind in ['Hoodie','Sweatshirt']:
            self.assertEqual(category_path({'department':'Women','itemType':kind}),('Women','Tops'))
            self.assertEqual(category_path({'department':'Unisex','itemType':kind}),('Women','Tops'))
            self.assertEqual(category_path({'department':'Men','itemType':kind}),('Men','Shirts'))

    def test_gender_specific_category(self):
        self.assertEqual(category_path({"department": "Men", "itemType": "T-shirt"}), ("Men", "Shirts"))
        self.assertEqual(category_path({"department": "Women", "itemType": "Tank Top"}), ("Women", "Tops"))
        self.assertEqual(category_path({"department": "Women", "itemType": "Pants"}), ("Women", "Pants & Jumpsuits"))

    def test_unknown_category_and_department_need_review(self):
        for item in [{"department": "Kids", "itemType": "T-shirt"}, {"department": "Men", "itemType": "Unknown"}]:
            with self.assertRaises(ValueError): category_path(item)

    def test_user_approved_unisex_rule_uses_womens_categories(self):
        for department in ["Unisex", "Unisex Adult", "Unisex Adults"]:
            self.assertEqual(category_path({"department": department, "itemType": "T-shirt"}), ("Women", "Tops"))
            self.assertEqual(category_path({"department": department, "itemType": "Pants"}), ("Women", "Pants & Jumpsuits"))

    def test_no_color_guessing_or_duplicate_colors(self):
        self.assertEqual(colors_for({"color": "Grey", "secondaryColor": "Gray"}), ["Gray"])
        self.assertEqual(colors_for({"color": "White", "secondaryColor": "Blue"}), ["White", "Blue"])
        with self.assertRaises(ValueError): colors_for({"color": "Multicolor"})

    def test_condition_and_exact_size(self):
        self.assertEqual(CONDITIONS["New without tags"], "Like New")
        self.assertEqual(size_label("Medium"), "M")
        self.assertEqual(size_label("Maternity"), "Maternity")

    def test_maroon_uses_poshmarks_red_family_without_changing_reviewed_shade(self):
        item={"color":"Maroon","secondaryColor":"Burgundy"}
        self.assertEqual(colors_for(item),["Red"])
        self.assertEqual(item,{"color":"Maroon","secondaryColor":"Burgundy"})

    def test_reviewed_shades_use_available_color_families_without_changing_copy(self):
        for shade, family in [('Navy','Blue'),('Teal','Blue'),('Olive','Green'),('Beige','Tan')]:
            item={'color':shade}
            self.assertEqual(colors_for(item),[family])
            self.assertEqual(item['color'],shade)
        self.assertEqual(colors_for({'color':'Navy','secondaryColor':'Blue'}),['Blue'])

    def test_user_approved_nearest_dollar_rounding_matches_final_submission_check(self):
        for value, expected in [(24.99, "25"), (24.49, "24"), (24.5, "25"), (25.5, "26"), (25.0, "25")]:
            self.assertEqual(whole_price(value), expected)
        for value in [0.49, 0, -1, True, float("nan"), float("inf"), 1e30]:
            with self.assertRaises(ValueError): whole_price(value)

    def test_native_quantity_bounds_do_not_coerce_fractional_or_empty_stock(self):
        self.assertEqual(quantity_for(1), 1)
        self.assertEqual(quantity_for(2), 2)
        self.assertEqual(quantity_for(999), 999)
        for value in [0, -1, 1000, 1.5, True, "2", None]:
            with self.assertRaises(ValueError): quantity_for(value)

    def test_depop_stops_before_any_page_action_for_unsupported_multiple_units(self):
        with self.assertRaisesRegex(ValueError, "multi-unit"):
            fill_depop(None, {"quantity": 2}, {})


if __name__ == "__main__": unittest.main()
