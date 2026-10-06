"""Only selected seller receipt flags and identities leave Etsy's page context."""
import json
from pathlib import Path
import sys
import unittest
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.seller_sales import scan_sales,read_receipt

ORDER='4166299599'
URL=f'https://www.etsy.com/your/orders/sold/completed?order_id={ORDER}'


class EtsyNativeSalesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.page=self.browser.new_page();self.paid=True;self.cancelled=False;self.refunded=False;self.review=False;self.wrong_product=False;self.transaction_links=False
        self.amount=4499;self.currency='USD'
        self.page.route('**/*',self.route)

    def tearDown(self):self.page.close()

    def route(self,route):
        url=urlsplit(route.request.url);completed=url.path.endswith('/completed');detail='order_id' in parse_qs(url.query)
        order={'type':'EtsyRetail_Order','order_id':ORDER,'order_state_id':'1','is_canceled':self.cancelled,
               'payment':{'is_fully_paid':self.paid,'is_fully_refunded':self.refunded,'is_flagged_for_manual_review':self.review,
                          'is_partially_refunded':False,'payment_date':1788730516,
                          'cost_breakdown':{'discounted_items_cost':{'type':'Common_Money','value':self.amount,'currency_code':self.currency,'formatted_value':'$44.99'},
                                            'adjusted_shipping_cost':{'type':'Common_Money','value':942,'currency_code':'USD','formatted_value':'$9.42'}}},
               'fulfillment':{'is_fully_or_pending_cancellation':False},'transaction_ids':['5207075020'],
               'transactions':[{'transaction_id':5207075020,'listing_id':123456789}]}
        collection={'type':'Orders_OrdersCollection','total_count':1 if completed else 0,'total_search_hit_count':1 if completed else 0,
                    'order_ids':[ORDER] if completed else [],'orders':[order] if completed else [],'order_states':[{'order_state_id':'1','state_type':'Completed'}]}
        context={'Context':{'data':{'initial_data':{'orders':{'orders_search':collection}}}}}
        html='<main><h1>Orders &amp; Shipping</h1><a href="/your/orders/sold">New0</a><a href="/your/orders/sold/completed">Completed</a>'
        html+=f'<a href="{URL}">#{ORDER}</a>' if completed else '<p>No orders here right now</p>'
        if detail:
            listing='999999999' if self.wrong_product else '123456789'
            product_url=f'https://www.etsy.com/transaction/{"9999999999" if self.wrong_product else "5207075020"}' if self.transaction_links else f'https://www.etsy.com/listing/{listing}'
            html+=f'''<div role="tabpanel"><h4>Receipt #{ORDER}</h4><h4>1 Item</h4>
              <a href="{product_url}">Reviewed item</a><p id="payment-msg">Paid via Etsy Payments on Sep 6, 2026</p>
              <div class="col-group"><div>Item total</div><div>$44.99</div></div>
              <div class="col-group"><div>Shipping price</div><div>$9.42</div></div>
              <div class="col-group"><div>Order total</div><div>$58.56</div></div></div>'''
        html+='</main><script>window.Etsy='+json.dumps(context)+'</script>'
        route.fulfill(content_type='text/html',body=html)

    def test_new_zero_and_completed_receipt_use_matching_collection_counts(self):
        result=scan_sales(self.page,'etsy')
        self.assertTrue(result['complete'],result)
        self.assertEqual(result['confirmedReceiptIds'],[ORDER])
        self.assertEqual(result['observations'][0]['listingId'],'123456789')

    def test_cancelled_or_refunded_payment_is_not_a_sale(self):
        for flag in ['cancelled','refunded']:
            setattr(self,flag,True)
            self.assertEqual(read_receipt(self.page,'etsy',URL)[0]['classification'],'not_sale')
            setattr(self,flag,False)

    def test_actuals_require_usd_and_agreement_with_the_displayed_receipt(self):
        self.assertEqual(read_receipt(self.page,'etsy',URL)[0]['financials'],
                         {'currency':'USD','salePriceCents':4499,'shippingChargedCents':942,'soldAt':'2026-09-06T21:35:16.000Z'})
        self.amount=5856
        result=read_receipt(self.page,'etsy',URL)[0]
        self.assertEqual(result['classification'],'confirmed_sale');self.assertNotIn('financials',result)
        self.amount=4499;self.currency='CAD'
        self.assertNotIn('financials',read_receipt(self.page,'etsy',URL)[0])

    def test_unpaid_and_manual_review_flags_override_paid_looking_text(self):
        self.paid=False
        self.assertEqual(read_receipt(self.page,'etsy',URL)[0]['classification'],'not_sale')
        self.paid=True;self.review=True
        self.assertEqual(read_receipt(self.page,'etsy',URL)[0]['classification'],'requires_review')

    def test_a_different_displayed_product_prevents_confirmation(self):
        self.wrong_product=True
        with self.assertRaisesRegex(ValueError,'products differ'):read_receipt(self.page,'etsy',URL)

    def test_immutable_transaction_snapshot_must_match_the_declared_line_item(self):
        self.transaction_links=True
        self.assertEqual(read_receipt(self.page,'etsy',URL)[0]['classification'],'confirmed_sale')
        self.wrong_product=True
        with self.assertRaisesRegex(ValueError,'products differ'):read_receipt(self.page,'etsy',URL)
