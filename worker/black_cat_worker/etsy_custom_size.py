"""One exact custom size when the reviewed label has no native size option."""
import re


VARYING_FIELDS = ('Prices vary', 'Processing profiles vary', 'Quantities vary', 'SKUs vary')


def _normalized(value):
    return re.sub(r'[^a-z0-9]', '', str(value or '').casefold())


def custom_size_required(item):
    return (_normalized(item.get('department')) in {'unisex','unisexadult','unisexadults'}
            and _normalized(item.get('itemType')) == 'jeans'
            and re.fullmatch(r'\d{1,2}', str(item.get('size') or '').strip()) is not None)


def _womens_numeric_pants(item):
    return (_normalized(item.get('department')) in {'women','womens'}
            and _normalized(item.get('itemType')) in {'pants','trousers'}
            and re.fullmatch(r'\d{1,2}', str(item.get('size') or '').strip()) is not None)


def custom_size_value(item):
    value = str(item.get('size') or '').strip()
    if custom_size_required(item) or _womens_numeric_pants(item):
        return value
    return None


def custom_size_in_use(page, item):
    if custom_size_required(item): return True
    if custom_size_value(item) is None: return False
    return page.get_by_role('table').filter(has=page.get_by_role('columnheader', name='Size', exact=True)).count() > 0


def _button(scope, name):
    from playwright.sync_api import expect
    # Etsy wraps some actual buttons in a second element with role=button.
    button = scope.get_by_role('button', name=name, exact=True).and_(scope.locator('button'))
    expect(button).to_have_count(1)
    return button


def _quantity(item):
    if type(item.get('quantity')) is not int or item['quantity'] != 1:
        raise ValueError('Etsy custom sizing requires one item and one size option')


def _native_size(page, clear=False, item=None):
    from playwright.sync_api import expect
    scales = page.locator('select[id^="attributes-"][id$="-scale-select"]')
    if scales.count() == 0:
        return
    expect(scales).to_have_count(1)
    labels = scales.locator('option').all_text_contents()
    expected = {'choose a scale', 'us letter'}
    if item is not None and _womens_numeric_pants(item):
        expected = {'choose a scale', "us women's numeric", "us women's letter", "uk women's", "fr women's",
                    "de women's", "au women's", "jp women's", "in women's letter"}
    if {label.strip().casefold() for label in labels} != expected:
        raise ValueError('Etsy custom size category now offers different native scales; review its mapping')
    if clear and scales.input_value() != '-1':
        scales.select_option('-1')
    expect(scales).to_have_value('-1')


def _manager(page, value):
    from playwright.sync_api import expect
    dialog = page.get_by_role('dialog', name='Manage variations', exact=True)
    expect(dialog).to_have_count(1)
    groups = dialog.get_by_role('group')
    expect(groups).to_have_count(1)
    expect(groups).to_have_accessible_name('Size 1 option')
    summary = re.sub(r'\b(?:Edit|Remove)\b', '', groups.inner_text())
    if not re.fullmatch(r'\s*Size\s*1\s*option\s*' + re.escape(value) + r'\s*', summary):
        raise ValueError('Etsy custom variation does not contain exactly the reviewed size')
    for name in VARYING_FIELDS:
        expect(dialog.get_by_role('checkbox', name=name, exact=True)).not_to_be_checked()
    return dialog


def _main_values(page, item, value):
    from playwright.sync_api import expect
    _quantity(item)
    table = page.get_by_role('table').filter(has=page.get_by_role('columnheader', name='Size', exact=True))
    expect(table).to_have_count(1)
    expect(table.get_by_role('rowheader')).to_have_count(1)
    expect(table.get_by_role('rowheader')).to_have_text(value)
    expect(table.get_by_role('checkbox', name='Enabled status for variation row number: 1', exact=True)).to_be_checked()
    expect(page.locator('#listing-price-input')).to_have_value(f"{item['price']:.2f}")
    expect(page.locator('#listing-quantity-input')).to_have_value('1')
    expect(page.locator('#listing-sku-input')).to_have_value(item['sku'])
    _native_size(page, item=item)


def verify_custom_size(page, item):
    from playwright.sync_api import expect
    value = custom_size_value(item)
    if value is None:
        raise ValueError('This item has no verified Etsy custom-size mapping')
    _main_values(page, item, value)
    _button(page.locator('main'), 'Manage variations').click()
    dialog = _manager(page, value)
    _button(dialog, 'Cancel').click()
    expect(dialog).not_to_be_visible()
    _main_values(page, item, value)


def fill_custom_size(page, item):
    from playwright.sync_api import expect
    value = custom_size_value(item)
    if value is None:
        raise ValueError('This item has no verified Etsy custom-size mapping')
    _quantity(item)
    main = page.locator('main')
    existing = main.get_by_role('button', name='Manage variations', exact=True).and_(main.locator('button'))
    if existing.count():
        verify_custom_size(page, item)
        return value
    _native_size(page, clear=True, item=item)
    _button(main, 'Add variation').click()
    _button(page.get_by_role('dialog', name='Add variations', exact=True), 'Create your own').click()
    edit = page.get_by_role('dialog', name='Edit variations', exact=True)
    expect(edit).to_have_count(1)
    edit.get_by_role('textbox', name='Name', exact=True).fill('Size')
    expect(edit.get_by_role('checkbox', name='Link photos to this variation', exact=True)).not_to_be_checked()
    edit.get_by_role('textbox', name='Add option', exact=True).fill(value)
    _button(edit, 'Add').click()
    expect(edit.get_by_role('heading', name='Options 1', exact=True)).to_be_visible()
    _button(edit, 'Done').click()
    manage = _manager(page, value)
    _button(manage, 'Apply').click()
    expect(manage).not_to_be_visible()
    _main_values(page, item, value)
    return value
