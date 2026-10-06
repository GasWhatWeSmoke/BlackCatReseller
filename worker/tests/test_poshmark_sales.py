import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker.poshmark_sales import listing_identity, normalize_order, page_range, booked_timestamp
from black_cat_worker.post_poshmark import listing_url

ORDER = "aaaaaaaaaaaaaaaaaaaaaaaa"
LISTING = "bbbbbbbbbbbbbbbbbbbbbbbb"
LINE = "cccccccccccccccccccccccc"


def snapshot():
    return {"isSale": True, "orderId": ORDER, "displayStatus": "Order Complete", "visibleStatus": "Order Complete",
            "cancellationKnown": True, "cancelled": False,
            "lines": [{"lineId": LINE, "status": "r", "productId": LISTING, "parentPostId": None,
                       "productUrl": f"https://poshmark.com/listing/{LISTING}", "sku": "000001"}]}


class PoshmarkSalesTests(unittest.TestCase):
    def test_native_sold_journey_confirms_a_new_sale_before_shipping(self):
        value = snapshot()
        value.update(displayStatus='Sold', visibleStatus='Sold', orderState='seller_confirm_initiated',
                     soldEventInProgress=True, visibleSoldInProgress=True, paymentApproved=False,
                     totalPrice={'currency_code':'USD','val':'17.0'}, visiblePrices=['$17.00'],
                     inventoryBookedAt='2026-09-18T07:59:10-07:00')
        result = normalize_order(value, ORDER)[0]
        self.assertEqual(result['classification'], 'confirmed_sale')
        self.assertEqual(result['financials'], {'currency':'USD','salePriceCents':1700,'soldAt':'2026-09-18T14:59:10.000Z'})
        for field, wrong in [('orderState','payment_pending'), ('soldEventInProgress',False), ('visibleSoldInProgress',False)]:
            changed = {**value, field: wrong}
            self.assertEqual(normalize_order(changed, ORDER)[0]['classification'], 'requires_review')
        value['cancelled'] = True
        self.assertEqual(normalize_order(value, ORDER)[0]['classification'], 'not_sale')

    def test_booking_date_requires_a_valid_timestamp_with_timezone(self):
        for value in [None, 123, '', '2026-09-18', '2026-09-18T07:59:10', 'not a date']:
            self.assertIsNone(booked_timestamp(value))

    def test_actual_paid_price_must_match_the_single_displayed_order_item(self):
        value=snapshot();value.update(totalPrice={'currency_code':'USD','val':'10.0'},visiblePrices=['$10.00'])
        self.assertEqual(normalize_order(value,ORDER)[0]['financials'],{'currency':'USD','salePriceCents':1000})
        value['visiblePrices']=['$20.00']
        result=normalize_order(value,ORDER)[0]
        self.assertEqual(result['classification'],'confirmed_sale');self.assertNotIn('financials',result)

    def test_completed_order_has_exact_identity_without_customer_data(self):
        value = snapshot()
        value["buyer"] = {"email": "not-collected@example.test", "address": "not collected"}
        result = normalize_order(value, ORDER)[0]
        self.assertEqual(result["classification"], "confirmed_sale")
        self.assertEqual(result["listingId"], LISTING)
        self.assertEqual(result["lineId"], LINE)
        self.assertNotIn("buyer", result)
        self.assertNotIn("not-collected", str(result))

    def test_generic_native_listing_url_and_slug_share_the_same_id(self):
        self.assertEqual(listing_identity(f"https://poshmark.com/listing/{LISTING}"), LISTING)
        self.assertEqual(listing_identity(f"https://poshmark.com/listing/Some-title-{LISTING}"), LISTING)
        self.assertEqual(listing_url(f"https://poshmark.com/listing/{LISTING}", LISTING), f"https://poshmark.com/listing/{LISTING}")

    def test_fresh_order_requires_explicit_payment_approval_and_no_cancellation(self):
        value = snapshot(); value['displayStatus'] = value['visibleStatus'] = 'Order Placed'
        self.assertEqual(normalize_order(value, ORDER)[0]['classification'], 'requires_review')
        value['paymentApproved'] = True
        self.assertEqual(normalize_order(value, ORDER)[0]['classification'], 'confirmed_sale')
        value['cancelled'] = True
        self.assertEqual(normalize_order(value, ORDER)[0]['classification'], 'not_sale')

    def test_cancelled_and_unverified_states_cannot_trigger_a_sale(self):
        value = snapshot(); value["cancelled"] = True
        self.assertEqual(normalize_order(value, ORDER)[0]["classification"], "not_sale")
        value = snapshot(); value["displayStatus"] = value["visibleStatus"] = "Order Placed"
        self.assertEqual(normalize_order(value, ORDER)[0]["classification"], "requires_review")
        value = snapshot(); value["lines"][0]["status"] = "unknown"
        self.assertEqual(normalize_order(value, ORDER)[0]["classification"], "requires_review")

    def test_wrong_order_or_purchase_page_or_conflicting_status_is_rejected(self):
        for key, wrong in [("orderId", "dddddddddddddddddddddddd"), ("isSale", False),
                           ("visibleStatus", "Cancelled"), ("cancellationKnown", False)]:
            value = snapshot(); value[key] = wrong
            with self.assertRaises(ValueError): normalize_order(value, ORDER)

    def test_url_identity_cannot_be_guessed_from_title_or_photo(self):
        value = snapshot()
        value["lines"][0]["productUrl"] = f"https://poshmark.com/listing/eeeeeeeeeeeeeeeeeeeeeeee"
        with self.assertRaises(ValueError): normalize_order(value, ORDER)
        self.assertIsNone(listing_identity(f"https://poshmark.com.evil.test/listing/{LISTING}"))

    def test_duplicate_lines_are_rejected_instead_of_reporting_two_sales(self):
        value = snapshot(); value["lines"].append(copy.deepcopy(value["lines"][0]))
        with self.assertRaises(ValueError): normalize_order(value, ORDER)

    def test_page_counter_proves_completion_instead_of_the_always_enabled_next_arrow(self):
        self.assertEqual(page_range("Showing 1\u20133 of 3"), (1, 3, 3))
        self.assertEqual(page_range("Showing 21-40 of 51"), (21, 40, 51))
        self.assertEqual(page_range("Showing 0-0 of 0"), (0, 0, 0))
        for value in ["Loading", "Showing 0-3 of 3", "Showing 1-4 of 3"]:
            with self.assertRaises(ValueError): page_range(value)


if __name__ == "__main__": unittest.main()
