"""Receipt actuals only; unknown amounts never stop sale/delist observations."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import re


def usd_cents(value):
    if not isinstance(value, str): return None
    match = re.fullmatch(r'(?:US\$|US \$|\$)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?', value.strip())
    if not match: return None
    amount = int(match[1].replace(',', '')) * 100 + int(match[2] or '0')
    return amount if amount <= 100_000_000 else None


def amount_cents(value):
    """Poshmark's explicit USD decimal amount; no float rounding."""
    if not isinstance(value, dict) or value.get('currency_code') != 'USD': return None
    try:
        amount = Decimal(value['val']) * 100
        if amount.is_finite() and amount == amount.to_integral_value() and 0 <= amount <= 100_000_000: return int(amount)
    except (KeyError, TypeError, InvalidOperation): pass
    return None


def sold_timestamp(value):
    if type(value) is not int or not 946684800 <= value <= 4102444800: return None
    return datetime.fromtimestamp(value, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def single_item_financials(observations, sale_cents, shipping_cents=None, sold_at=None):
    # A receipt total cannot be assigned to every product in a bundle.
    if len(observations) != 1 or observations[0]['classification'] != 'confirmed_sale': return observations
    if type(sale_cents) is not int or not 0 <= sale_cents <= 100_000_000: return observations
    financials = {'currency': 'USD', 'salePriceCents': sale_cents}
    if type(shipping_cents) is int and 0 <= shipping_cents <= 100_000_000: financials['shippingChargedCents'] = shipping_cents
    if sold_at: financials['soldAt'] = sold_at
    observations[0]['financials'] = financials
    return observations
