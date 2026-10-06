from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.mercari_form import category_path,label_quote,listing_id,size_pattern
from black_cat_worker.mercari_sales import normalize_order,order_id


class MercariLogicTests(unittest.TestCase):
    def test_dresses_use_a_reviewed_length_or_the_general_leaf(self):
        self.assertEqual(category_path({'department':'Women','itemType':'Dress','style':'Zebra Print'},'Women'),['Women','Dresses','Other'])
        self.assertEqual(category_path({'department':'Women','itemType':'Dress','style':'Maxi'},'Women'),['Women','Dresses','Maxi'])
        self.assertEqual(category_path({'department':'Unisex','itemType':'Dress','style':'Mini'},'Women'),['Women','Dresses','Above knee, mini'])

    def test_womens_hoodies_and_sweatshirts_use_their_native_athletic_leaves(self):
        for kind,leaf in [('Hoodie','Athletic Hoodies'),('Long Sleeve Hoodie','Athletic Hoodies'),('Sweatshirt','Athletic Sweatshirts')]:
            self.assertEqual(category_path({'department':'Women','itemType':kind},'Women'),['Women','Athletic apparel',leaf])
        self.assertEqual(category_path({'department':'Women','itemType':'Sweater'},'Women'),['Women','Sweaters','Crewneck'])
        self.assertEqual(category_path({'department':'Men','itemType':'Hoodie'},'Women'),['Men','Sweaters','Hoodies'])

    def test_coats_and_jackets_end_at_a_leaf_without_guessing_their_construction(self):
        for kind in ['Coat','Jacket','Quilted Jacket']:
            item={'department':'Unisex','itemType':kind,'style':'Quilted'}
            self.assertEqual(category_path(item,'Women'),['Women','Coats & jackets','Other'])
            self.assertEqual(category_path(item,'Men'),['Men','Coats & jackets','Other'])
            self.assertEqual(item['style'],'Quilted')

    def test_accessories_use_native_department_branches_and_complete_bag_leaves(self):
        self.assertEqual(category_path({'department':'Men','itemType':'Belt'},'Women'),['Men',"Men's accessories",'Belts'])
        self.assertEqual(category_path({'department':'Unisex','itemType':'Belt'},'Women'),['Women',"Women's accessories",'Belts'])
        self.assertEqual(category_path({'department':'Women','itemType':'Shoulder Bag'},'Women'),['Women',"Women's handbags",'Shoulder Bags'])
        self.assertEqual(category_path({'department':'Women','itemType':'Duffel Bag'},'Women'),['Women',"Women's handbags",'Other'])

    def test_bottoms_use_reviewed_style_or_fit_and_do_not_invent_a_skirt_length(self):
        self.assertEqual(category_path({'department':'Women','itemType':'Skirt','style':'Ruffle','fit':'Regular'},'Women'),['Women','Skirts','Other'])
        self.assertEqual(category_path({'department':'Women','itemType':'Jeans','style':'Distressed','fit':'Straight'},'Women'),['Women','Jeans','Straight leg'])
        self.assertEqual(category_path({'department':'Women','itemType':'Jeans','style':'low rise','fit':'Wide Leg'},'Women'),['Women','Jeans','Wide leg'])
        self.assertEqual(category_path({'department':'Women','itemType':'Pants','style':'Corduroy'},'Women'),['Women','Pants','Corduroys'])

    def test_polo_shirts_do_not_fall_through_to_button_front_shirts(self):
        for kind in ['Polo','Polo Shirt','Long Sleeve Polo Shirt']:
            self.assertEqual(category_path({'department':'Men','itemType':kind},'Women'),['Men','Tops','Polo'])
        self.assertEqual(category_path({'department':'Men','itemType':'Button-down Shirt'},'Women'),['Men','Tops','Button-front'])
        self.assertEqual(category_path({'department':'Women','itemType':'Polo Shirt'},'Women'),['Women','Tops & blouses','Polo'])

    def test_shorts_choose_a_complete_leaf_and_numeric_title_sizes_accept_inches(self):
        self.assertEqual(category_path({'department':'Men','itemType':'Shorts','style':'Board Shorts'},'Women'),['Men','Shorts','Board, surf'])
        self.assertEqual(category_path({'department':'Men','itemType':'Shorts','style':'Denim'},'Women'),['Men','Shorts','Denim'])
        self.assertEqual(category_path({'department':'Women','itemType':'Shorts','style':'Chino'},'Women'),['Women','Shorts','Chino & khaki'])
        self.assertEqual(category_path({'department':'Men','itemType':'Shorts'},'Women'),['Men','Shorts','Other'])
        self.assertTrue(size_pattern('28').fullmatch('28 in.'))
        self.assertFalse(size_pattern('28').fullmatch('38 in.'))

    def test_camisoles_and_bralettes_remain_distinct_from_generic_tops(self):
        for kind,expected in [('Camisole',['Tops & blouses','Camisoles']),('Bralette',['Underwear','Bras']),('Tube Top',['Tops & blouses','Tank tops']),('Top',['Tops & blouses','Other'])]:
            item={'department':'Women','itemType':kind}
            self.assertEqual(category_path(item,'Women'),['Women',*expected])
            self.assertEqual(item['itemType'],kind)
        with self.assertRaises(ValueError):category_path({'department':'Men','itemType':'Bralette'},'Women')

    def test_unisex_uses_configured_department_and_sweatshirts_are_not_tees(self):
        self.assertEqual(category_path({'department':'Unisex','itemType':'T-Shirt'},'Women'),['Women','Tops & blouses','T-shirts'])
        self.assertEqual(category_path({'department':'Men','itemType':'Sweatshirt'},'Men'),['Men','Sweaters','Sweatshirts'])
        self.assertEqual(category_path({'department':'Men','itemType':'Sweater Vest'},'Men'),['Men','Sweaters','Vests'])

    def test_sizes_and_shipping_are_exact_and_clothing_cannot_use_media_mail(self):
        self.assertTrue(size_pattern('M').fullmatch('M (38-40)'))
        self.assertFalse(size_pattern('M').fullmatch('XL (16-18)'))
        self.assertEqual(label_quote('USPS Ground Advantage Up to 1 lb $5.50'),(5.5,16))
        self.assertIsNone(label_quote('USPS Media Mail Up to 2 lb $2.00'))

    def test_ids_reject_foreign_domains_and_non_us_paths(self):
        self.assertEqual(listing_id('https://www.mercari.com/us/item/m12345678901/'),'m12345678901')
        self.assertIsNone(listing_id('https://www.mercari.com.evil.test/us/item/m12345678901/'))
        self.assertIsNone(listing_id('https://jp.mercari.com/item/m12345678901/'))
        self.assertEqual(order_id('https://www.mercari.com/transaction/order_status/m12345678901/'),'m12345678901')

    def test_only_verified_seller_orders_can_confirm_a_sale(self):
        value={'orderId':'m12345678901','sellerView':True,'products':['https://www.mercari.com/us/item/m12345678901/'],
               'itemCount':1,'status':'Awaiting shipment','payment':'Paid','fulfillmentReady':True}
        self.assertEqual(normalize_order(value,value['orderId'])[0]['classification'],'confirmed_sale')
        for status in ('Cancelled','Refunded','Payment processing'):
            self.assertEqual(normalize_order({**value,'status':status},value['orderId'])[0]['classification'],'not_sale')
        self.assertEqual(normalize_order({**value,'payment':None,'fulfillmentReady':False},value['orderId'])[0]['classification'],'requires_review')
        self.assertEqual(normalize_order({**value,'paymentConflict':True},value['orderId'])[0]['classification'],'requires_review')
        self.assertEqual(normalize_order({**value,'payment':'Unrecognized state'},value['orderId'])[0]['classification'],'requires_review')
        for change in ({'sellerView':False},{'itemCount':2},{'orderId':'other'}):
            with self.assertRaises(ValueError):normalize_order({**value,**change},value['orderId'])


if __name__=='__main__':unittest.main()
