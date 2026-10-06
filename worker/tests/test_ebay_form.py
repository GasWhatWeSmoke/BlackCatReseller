import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.ebay_form import category_for, department_for, title_for, image_key, type_specifics, size_and_type, reviewed_inseam


class EbayFormTests(unittest.TestCase):
    def test_womens_hoodies_use_activewear_without_changing_the_mens_route(self):
        for kind in ['Hoodie','Sweatshirt','Long Sleeve Hoodie']:
            self.assertEqual(category_for({'department':'Women','itemType':kind})[-3:],
                             ["Women's Clothing",'Activewear','Hoodies & Sweatshirts'])
            self.assertEqual(category_for({'department':'Men','itemType':kind})[-2:],
                             ["Men's Clothing",'Hoodies & Sweatshirts'])
        self.assertNotIn('Activewear',category_for({'department':'Women','itemType':'Sweater'}))

    def test_jeans_inseam_is_a_reviewed_measurement_not_the_tag_size(self):
        item={'department':'Men','itemType':'Jeans','size':'29'}
        category=category_for(item)
        for value in [None,'','29/9','0','unknown']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError,'reviewed inseam'):
                reviewed_inseam({**item,'inseam':value},category)
        for value,expected in [('31','31 in'),('31 in','31 in'),('33.50 inches','33.5 in')]:
            self.assertEqual(reviewed_inseam({**item,'inseam':value},category),expected)
        self.assertIsNone(reviewed_inseam({},['T-Shirts']))

    def test_explicit_mini_skirt_and_long_sleeve_tee_details_are_kept(self):
        self.assertEqual(type_specifics({'department':'Women','itemType':'Skirt','description':'A geometric mini skirt.'}),{'Type':'Skirt','Skirt Length':'Short'})
        self.assertEqual(type_specifics({'department':'Women','itemType':'Skirt','description':'A ruffled skirt.'}),{'Type':'Skirt'})
        self.assertEqual(type_specifics({'department':'Women','itemType':'Long Sleeve T-shirt'}),{'Type':'T-Shirt','Sleeve Length':'Long Sleeve'})
        with self.assertRaisesRegex(ValueError,'Conflicting'):
            type_specifics({'department':'Women','itemType':'Skirt','title':'Mini skirt','description':'A maxi skirt.'})

    def test_button_front_types_keep_explicit_sleeve_length(self):
        item={'department':'Men','itemType':'long sleeve button down'}
        self.assertEqual(type_specifics(item),{'Type':'Button-Up','Sleeve Length':'Long Sleeve'})
        self.assertEqual(item['itemType'],'long sleeve button down')
        self.assertEqual(type_specifics({'department':'Women','itemType':'Button-up Shirt'}),{'Type':'Button-Up'})
        self.assertEqual(type_specifics({'department':'Men','itemType':'Short Sleeve Button-down Shirt'}),{'Type':'Button-Up','Sleeve Length':'Short Sleeve'})

    def test_dress_length_uses_reviewed_length_words_without_confusing_sleeve_length(self):
        for phrase,length in [('mini dress','Short'),('short dress','Short'),('knee-length dress','Knee Length'),('midi dress','Midi'),('maxi dress','Long'),('long dress','Long')]:
            self.assertEqual(type_specifics({'department':'Women','itemType':'Dress','description':phrase}),{'Type':'Dress','Dress Length':length})
        self.assertEqual(type_specifics({'department':'Women','itemType':'Dress','title':'Long sleeve dress'}),{'Type':'Dress'})
        with self.assertRaisesRegex(ValueError,'Conflicting reviewed dress lengths'):
            type_specifics({'department':'Women','itemType':'Dress','title':'Mini dress','description':'Maxi dress'})

    def test_petite_title_size_overrides_regular_fit_only_for_womens_clothing(self):
        item={'department':'Women','itemType':'Shorts','size':'6P','fit':'Regular'}
        self.assertEqual(size_and_type(item,category_for(item)),('6','Petites'))
        self.assertEqual(item['size'],'6P')
        self.assertEqual(item['fit'],'Regular')
        self.assertEqual(size_and_type({**item,'size':'6'},category_for(item)),('6','Regular'))
        shoe={**item,'itemType':'Boots'}
        self.assertEqual(size_and_type(shoe,category_for(shoe)),('6P','Regular'))

    def test_board_short_styles_use_swimwear_without_changing_reviewed_size(self):
        for style in ['Board Shorts','Boardshorts','Shortboard']:
            item={'department':'Men','itemType':'Shorts','style':style,'size':'M'}
            self.assertEqual(category_for(item)[-2:],["Men's Clothing",'Swimwear'])
            self.assertEqual(type_specifics(item),{'Type':'Bottom','Swim Bottom Style':'Board Shorts'})
            self.assertEqual(item['size'],'M')
        self.assertEqual(category_for({'department':'Men','itemType':'Shorts','style':'Cargo'})[-1],'Shorts')
        self.assertEqual(category_for({'department':'Women','itemType':'Shorts','style':'Board Shorts'})[-1],'Shorts')

    def test_specific_bag_names_keep_accessory_categories_and_camisoles_keep_tank_specifics(self):
        for kind in ['Shoulder Bag','Duffel Bag']:
            self.assertEqual(category_for({'department':'Women','itemType':kind})[-1],"Women's Bags & Handbags")
            self.assertEqual(category_for({'department':'Unisex','itemType':kind})[-2:],["Men's Accessories",'Bags'])
        self.assertEqual(category_for({'department':'Women','itemType':'Camisole'})[-1],'Tops')
        self.assertEqual(type_specifics({'department':'Women','itemType':'Camisole'}),{'Type':'Tank'})
        self.assertEqual(category_for({'department':'Women','itemType':'Bralette'})[-2:],['Intimates & Sleep','Bras & Bra Sets'])
        with self.assertRaises(ValueError):category_for({'department':'Men','itemType':'Bralette'})

    def test_mens_tank_keeps_sleeveless_specific_when_category_type_is_tshirt(self):
        item={'department':'Men','itemType':'Tank Top'}
        self.assertEqual(type_specifics(item),{'Type':'T-Shirt','Sleeve Length':'Sleeveless'})
        self.assertEqual(type_specifics({'department':'Women','itemType':'Tank Top'}),{'Type':'Tank'})
        self.assertEqual(item['itemType'],'Tank Top')

    def test_category_and_department_are_distinct_for_unisex(self):
        self.assertEqual(department_for('Unisex Adults'), 'Unisex Adults')
        self.assertEqual(category_for({'department':'Unisex','itemType':'T-shirt'})[-2:], ['Shirts','T-Shirts'])
        self.assertEqual(category_for({'department':'Women','itemType':'Tank Top'})[-1], 'Tops')
        self.assertEqual(category_for({'department':'Men','itemType':'Sweatshirt'})[-1], 'Hoodies & Sweatshirts')
        self.assertEqual(category_for({'department':'Men','itemType':'Dress Shirt'})[-1], 'Dress Shirts')

    def test_title_bound_and_unsupported_categories(self):
        title = title_for('Brand ' + 'reviewed detail ' * 12)
        self.assertLessEqual(len(title),80)
        self.assertFalse(title.endswith(' '))
        with self.assertRaises(ValueError): category_for({'department':'Kids','itemType':'T-shirt'})
        with self.assertRaises(ValueError): category_for({'department':'Men','itemType':'Unknown'})

    def test_image_identity_ignores_rendered_size_but_rejects_other_hosts(self):
        self.assertEqual(image_key('https://i.ebayimg.com/images/g/ABC123/s-l1600.jpg'), 'ABC123')
        self.assertEqual(image_key('https://i.ebayimg.com/images/g/ABC123/s-l225.jpg'), 'ABC123')
        self.assertEqual(image_key('https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/ABC123/$_12.JPG?set_id=880000500F'), 'ABC123')
        self.assertIsNone(image_key('https://example.com/images/g/ABC123/s-l1600.jpg'))
