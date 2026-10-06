from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.seller_sales import normalize_receipt, receipt_identity, scan_sales


class SellerSalesTests(unittest.TestCase):
    def snapshot(self, marketplace):
        order = '12-12345-12345' if marketplace == 'ebay' else '1234567890'
        prefix = 'itm' if marketplace == 'ebay' else 'listing'
        return order, {'receiptId':order,'itemCount':1,'products':[f'https://www.{marketplace}.com/{prefix}/123456789012'],
                       'paymentStatus':'Paid','orderStatus':'Ready to ship','buyer':'not retained'}

    def test_exact_paid_orders_only_retain_the_sale_identity(self):
        for platform in ('ebay','etsy'):
            order, value = self.snapshot(platform)
            row = normalize_receipt(platform,value,order)[0]
            self.assertEqual(row['classification'],'confirmed_sale')
            self.assertEqual(row['reference'],order+'/123456789012')
            self.assertNotIn('buyer',row)

    def test_unpaid_refunded_and_cancelled_orders_never_confirm(self):
        for platform in ('ebay','etsy'):
            order, value = self.snapshot(platform)
            for status in ('Payment processing','Unpaid','Refunded','Cancelled','Awaiting payment'):
                self.assertEqual(normalize_receipt(platform,{**value,'paymentStatus':status},order)[0]['classification'],'not_sale')
            self.assertEqual(normalize_receipt(platform,{**value,'paymentStatus':None},order)[0]['classification'],'requires_review')
            self.assertEqual(normalize_receipt(platform,{**value,'orderStatus':'Refunded'},order)[0]['classification'],'not_sale')

    def test_incomplete_or_cross_platform_receipts_are_rejected(self):
        for platform in ('ebay','etsy'):
            order,value = self.snapshot(platform)
            for changes in ({'receiptId':'wrong'},{'itemCount':2},{'products':['https://evil.test/listing/123456789012']},{'itemCount':None}):
                with self.assertRaises(ValueError): normalize_receipt(platform,{**value,**changes},order)

    def test_receipt_links_require_seller_origin_path_and_one_valid_id(self):
        self.assertEqual(receipt_identity('ebay','https://www.ebay.com/sh/ord/details?orderid=12-12345-12345'),'12-12345-12345')
        self.assertEqual(receipt_identity('etsy','https://www.etsy.com/your/orders/sold?order_id=123'),'123')
        for url in ('https://www.etsy.com.evil.test/your/orders/sold?order_id=123','https://www.etsy.com/your/orders/sold?order_id=123&order_id=456','https://www.etsy.com/your/purchases?order_id=123'):
            self.assertIsNone(receipt_identity('etsy',url))

    def test_cached_receipts_do_not_consume_the_unread_receipt_budget(self):
        known = [str(number) for number in range(100)]
        urls = [f'https://www.etsy.com/your/orders/sold?order_id={number}' for number in range(101)]
        _, value = self.snapshot('etsy'); value['receiptId'] = '100'
        rows = normalize_receipt('etsy', value, '100')
        with patch('black_cat_worker.seller_sales.discover_receipts', return_value=(urls, True, None)), \
             patch('black_cat_worker.seller_sales.read_receipt', return_value=rows) as read:
            report = scan_sales(None, 'etsy', known)
        self.assertEqual(report['confirmedReceiptIds'], ['100'])
        read.assert_called_once_with(None, 'etsy', urls[-1])


if __name__ == '__main__': unittest.main()
