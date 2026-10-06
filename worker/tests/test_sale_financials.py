import sys
from pathlib import Path
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.sale_financials import usd_cents,amount_cents,single_item_financials,sold_timestamp


class SaleFinancialTests(unittest.TestCase):
    def test_money_has_explicit_currency_and_exact_cents(self):
        self.assertEqual(usd_cents('US$19.99'),1999)
        self.assertEqual(usd_cents('$1,234.50'),123450)
        self.assertEqual(amount_cents({'currency_code':'USD','val':'19.99'}),1999)
        for value in ['CA$19.99','19.99','-$19.99','$1,23.99','$19.999']:
            self.assertIsNone(usd_cents(value))
        self.assertIsNone(amount_cents({'currency_code':'EUR','val':'19.99'}))
        self.assertIsNone(amount_cents({'currency_code':'USD','val':'19.999'}))

    def test_receipt_totals_cannot_be_duplicated_across_a_bundle_or_unpaid_items(self):
        rows=[{'classification':'confirmed_sale'},{'classification':'confirmed_sale'}]
        self.assertEqual(single_item_financials(rows,1999),rows)
        self.assertTrue(all('financials' not in row for row in rows))
        self.assertNotIn('financials',single_item_financials([{'classification':'not_sale'}],1999)[0])

    def test_missing_shipping_is_not_invented_as_zero_and_dates_are_receipt_dates(self):
        row=single_item_financials([{'classification':'confirmed_sale'}],1999)[0]
        self.assertNotIn('shippingChargedCents',row['financials'])
        self.assertNotIn('soldAt',row['financials'])
        self.assertEqual(sold_timestamp(1788730516),'2026-09-06T21:35:16.000Z')
        self.assertIsNone(sold_timestamp(True))
