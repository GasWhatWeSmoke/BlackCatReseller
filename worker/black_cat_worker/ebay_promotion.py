"""Explicit fixed-rate General promotion; never enables pay-per-click ads."""
import math
import re


def validate_ad_rate(rate):
    if rate is None:
        return None
    if (type(rate) not in (int, float) or not math.isfinite(rate) or
            not 2 <= rate <= 100 or abs(rate * 10 - round(rate * 10)) > 0.000001):
        raise ValueError('eBay promotion needs a fixed ad rate from 2% to 100%, with at most one decimal')
    return rate


def configure_promotion(page, rate, verify_only=False):
    from playwright.sync_api import expect
    validate_ad_rate(rate)
    controls = {}
    for label in ['Promote your listing', 'Promote it', 'Toggle General', 'Toggle Priority']:
        matches = []
        for role in ['switch', 'checkbox']:
            locator = page.get_by_role(role, name=label, exact=True)
            matches.extend(field for field in locator.all() if field.is_visible())
        if len(matches) > 1:
            raise ValueError(f'eBay has ambiguous {label} controls')
        if matches:
            controls[label] = matches[0]
    if rate is not None and 'Toggle General' not in controls:
        raise ValueError('eBay General promotion control is missing; fixed ad rate cannot be verified')
    for label, field in controls.items():
        enabled = rate is not None and label != 'Toggle Priority'
        if not verify_only and field.is_checked() != enabled:
            field.press('Space')
        expect(field).to_be_checked(checked=enabled)
    if rate is None:
        return
    fixed = page.get_by_role('radio', name=re.compile(r'^Fixed ad rate\b'))
    dynamic = page.get_by_role('radio', name=re.compile(r'^Dynamic ad rate\b'))
    if fixed.count():
        expect(fixed).to_have_count(1)
        if not verify_only and not fixed.is_checked():
            fixed.check()
        expect(fixed).to_be_checked()
        expect(dynamic).to_have_count(1)
        expect(dynamic).not_to_be_checked()
        field = page.get_by_role('textbox', name='Ad rate', exact=True)
    else:
        # The native listing editor uses a manually entered listing-level rate,
        # while Seller Hub's promotion dialog includes the strategy radios.
        expect(dynamic).to_have_count(0)
        expect(page.get_by_role('button', name='Help tip for Listing ad rate field', exact=True)).to_be_visible()
        field = page.get_by_role('textbox', name='Ad rate in percent', exact=True)
    expect(field).to_have_count(1)
    expect(field).to_be_editable()
    if not verify_only:
        field.fill(f'{rate:g}')
        field.press('Tab')
    try:
        actual = float(field.input_value())
    except ValueError:
        raise ValueError('eBay fixed ad rate was not retained') from None
    if actual != rate or field.get_attribute('aria-invalid') == 'true':
        raise ValueError('eBay fixed ad rate changed; review before publishing')
