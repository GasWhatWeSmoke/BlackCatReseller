"""Depop's grouped category picker and labelled listing fields, observed on web."""
import json
import re
import unicodedata

from .browser_form import _parse_capacity_oz
from .petite_size import petite_size_base
from .normalize import canonical_brand


def normalized(value):
    text = unicodedata.normalize("NFKD", str(value or "")).casefold()
    return "".join(char for char in text if char.isalnum())


def department(value):
    name = normalized(value)
    # Operator decision: direct Depop listings marked Unisex use Men.
    if name in {"men", "mens", "male", "menswear", "unisex", "unisexadults"}:
        return "Men"
    if name in {"women", "womens", "female", "womenswear"}:
        return "Women"
    if name in {"kids", "children", "boys", "girls", "unisexkids"}:
        return "Kids"
    raise ValueError("Depop category needs a known department")


def category_path(item):
    kind = normalized(item.get("itemType"))
    rules = [
        (("polo", "poloshirt"), "Tops", "Polo shirts"),
        (("tank", "tanktop", "cami", "camisole", "camitop"), "Tops", "Tank tops and camis"),
        (("bralette", "bra"), "Underwear", "Bras"),
        (("blouse",), "Tops", "Blouses"),
        (("hoodie",), "Tops", "Hoodies"),
        (("sweatshirt",), "Tops", "Sweatshirts"),
        (("tshirt", "tee"), "Tops", "T-shirts"),
        (("cardigan",), "Tops", "Cardigans"),
        (("sweater", "pullover"), "Tops", "Sweaters"),
        (("shirt", "buttonup", "buttondown"), "Tops", "Shirts"),
        (("croptop",), "Tops", "Crop tops"),
        (("bodysuit",), "Tops", "Bodysuits"),
        (("corset",), "Tops", "Corsets"),
        (("jeans",), "Bottoms", "Jeans"),
        (("shorts",), "Bottoms", "Shorts"),
        (("sweatpants",), "Bottoms", "Sweatpants"),
        (("pants", "trousers"), "Bottoms", "Pants"),
        (("leggings",), "Bottoms", "Leggings"),
        (("skirt",), "Bottoms", "Skirts"),
        (("dress",), "Dresses", "Other"),
        (("jacket",), "Coats and jackets", "Jackets"),
        (("coat",), "Coats and jackets", "Coats"),
        (("vest",), "Coats and jackets", "Vests"),
        (("bag",), "Accessories", "Bags"),
        (("belt",), "Accessories", "Belts"),
        (("hat", "cap"), "Accessories", "Hats and caps"),
        (("scarf",), "Accessories", "Scarves and wraps"),
        (("necklace", "bracelet", "earring", "jewelry", "jewellery"), "Accessories", "Jewelry"),
        (("top",), "Tops", "Other"),
    ]
    for words, group, label in rules:
        if any(kind.endswith(word) for word in words):
            return f"{department(item.get('department'))} > {group}", label
    raise ValueError("Depop category has no verified mapping for this item type")


def choose_option(options, candidates, group=None):
    for candidate in candidates:
        matches = [option for option in options if normalized(option["label"]) == normalized(candidate)
                   and (group is None or option.get("group") == group) and not option.get("disabled")]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError("The marketplace offered ambiguous matching options")
    return None


def size_candidates(value, item_type, department_value=None):
    aliases = {"extrasmall": "XS", "small": "S", "medium": "M", "large": "L",
               "extralarge": "XL", "2xl": "XXL", "xxlarge": "XXL", "onesizefitsall": "One size"}
    raw = str(value or "")
    result = [raw]
    if (normalized(department_value) in {'boys','boy','girls','girl','kids','children','unisexkids'}
            and normalized(item_type) == 'jeans' and re.fullmatch(r'[0-9]{1,2}', raw.strip())
            and 2 <= int(raw) <= 16):
        result.append(f'{int(raw)} years')
    if normalized(raw) in aliases:
        result.append(aliases[normalized(raw)])
    waist = re.fullmatch(r"\s*(\d{2})\s*[xX]\s*\d{2}\s*", raw)
    if waist and any(word in normalized(item_type) for word in ("jeans", "pants", "trousers")):
        result.append(waist.group(1))
    return result


def parcel_option(options, weight):
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or weight <= 0:
        raise ValueError("Depop shipping needs a positive package weight")
    fits = []
    for option in options:
        capacity = _parse_capacity_oz(option["text"])
        if capacity is not None and not option.get("disabled"):
            under = "under" in option["text"].lower()
            if (weight < capacity if under else weight <= capacity):
                fits.append((capacity, option))
    if not fits:
        raise ValueError("No Depop package size covers this item's shipping weight")
    return min(fits, key=lambda entry: entry[0])[1]


def _option_snapshot(page, control):
    menu_id = control.get_attribute("aria-controls")
    menu = page.locator(f"[id={json.dumps(menu_id)}]")
    return menu.get_by_role("option").evaluate_all("""els => els.map(e => ({
      id: e.id, label: (e.querySelector('p')?.textContent || e.textContent).trim(),
      text: e.textContent.trim(), group: e.parentElement.firstElementChild.textContent.trim(),
      disabled: e.getAttribute('aria-disabled') === 'true'
    }))""")


def _open_options(page, label, search=None):
    control = page.get_by_role("combobox", name=label, exact=True)
    if control.count() != 1:
        raise ValueError(f"Depop {label} control was not found uniquely")
    control.click()
    if search is not None:
        control.fill(search)
        page.wait_for_timeout(600)
    menu_id = control.get_attribute("aria-controls")
    if not menu_id:
        raise ValueError(f"Depop {label} menu could not be identified")
    menu = page.locator(f"[id={json.dumps(menu_id)}]")
    menu.wait_for(state="visible", timeout=10000)
    return control, _option_snapshot(page, control)


def _select(page, control, option, label, click_timeout=30000):
    if not option or not option.get("id"):
        raise ValueError(f"No matching Depop {label} option")
    page.locator(f"[id={json.dumps(option['id'])}]").click(timeout=click_timeout)
    for _ in range(30):
        if (normalized(control.input_value()) == normalized(option["label"]) and
                control.get_attribute("aria-expanded") == "false" and control.get_attribute("aria-invalid") != "true"):
            return option["label"]
        page.wait_for_timeout(100)
    raise ValueError(f"Depop {label} selection was not confirmed")


def _select_field(page, label, candidates, search=None):
    if label == "Brand":
        current = page.get_by_role("combobox", name=label, exact=True)
        clear = current.locator("xpath=../..").get_by_role("button", name="clear the selected value", exact=True)
        # Depop can select a brand from the description before we reach this
        # field. Its selected brand is excluded from subsequent suggestions.
        # Only accept a closed, committed selection, never a typed search value.
        if clear.count() == 1:
            value = current.input_value()
            if (current.get_attribute("aria-expanded") == "false" and current.get_attribute("aria-invalid") != "true"
                    and any(normalized(value) == normalized(candidate) for candidate in candidates)):
                return value
            clear.click()
    control, options = _open_options(page, label, search)
    choice = choose_option(options, candidates)
    # Brand suggestions arrive asynchronously. Wait for the exact option without
    # retyping and restarting the search or accepting a similarly named brand.
    if search is not None:
        resets = 0
        for _ in range(32):
            if choice:
                break
            clear = control.locator("xpath=../..").get_by_role("button", name="clear the selected value", exact=True)
            if label == "Brand" and clear.count() == 1 and resets < 2:
                # An automatic selection arrived after we started typing. The
                # displayed search text is not proof of that selection's ID.
                # Clear it and explicitly choose the requested brand instead.
                clear.click()
                resets += 1
                control, options = _open_options(page, label, search)
            else:
                page.wait_for_timeout(250)
                options = _option_snapshot(page, control)
            choice = choose_option(options, candidates)
    return _select(page, control, choice, label)


def _selected_colors(control):
    # Color is a multi-select. The input remains empty; removable chips are
    # the committed selections, including colors Depop inferred itself.
    return control.locator("xpath=..").get_by_role("button", name=re.compile(r"^Remove ")).evaluate_all(
        "els => els.map(e => e.getAttribute('aria-label').slice(7))")


def _fill_colors(page, values):
    aliases = {"gray": "Grey", "multicolor": "Multi", "offwhite": "Cream", "maroon": "Burgundy",
               "teal": "Blue", "olive": "Green", "beige": "Tan"}
    desired = []
    for value in values:
        if value:
            name = aliases.get(normalized(value), value)
            if normalized(name) not in {normalized(existing) for existing in desired}:
                desired.append(name)
    if len(desired) > 2:
        raise ValueError("Depop accepts at most two colors")
    control = page.get_by_role("combobox", name="Color", exact=True)
    if control.count() != 1:
        if desired:
            raise ValueError("Depop Color control was not found")
        return []
    for selected in _selected_colors(control):
        if normalized(selected) not in {normalized(value) for value in desired}:
            control.locator("xpath=..").get_by_role("button", name=f"Remove {selected}", exact=True).click()
    for value in desired:
        if normalized(value) in {normalized(selected) for selected in _selected_colors(control)}:
            continue
        control, options = _open_options(page, "Color")
        choice = choose_option(options, [value])
        if not choice:
            raise ValueError("No matching Depop Color option")
        page.locator(f"[id={json.dumps(choice['id'])}]").click()
        control.press("Escape")
    selected = _selected_colors(control)
    if {normalized(value) for value in selected} != {normalized(value) for value in desired} or control.get_attribute("aria-invalid") == "true":
        raise ValueError("Depop colors were not confirmed")
    return selected


def shipping_address(page, select=True, recovery_timeout=10000):
    """Retain the selected saved address; never create, edit, or remove one."""
    unavailable = page.get_by_test_id('address-container').get_by_text(
        re.compile(r'Something went wrong.*try again later', re.I | re.S))
    if select and unavailable.count() == 1 and unavailable.is_visible():
        # The native widget can fail despite a successful saved-address response.
        # During initial fill only, remount it once through its shipping labels.
        # Never edit an address or relax the final saved-address verification.
        usps = page.get_by_role('radio', name='Depop Shipping (via USPS)', exact=True)
        other = page.get_by_role('radio', name='Other', exact=True)
        if usps.count() == 1 and other.count() == 1 and usps.is_checked() and usps.is_enabled() and other.is_enabled():
            identifiers = [other.get_attribute('id'), usps.get_attribute('id')]
            if all(identifiers) and identifiers[0] != identifiers[1]:
                labels = [page.locator('label[for=' + json.dumps(identifier) + ']') for identifier in identifiers]
                if all(label.count() == 1 and label.is_visible() for label in labels):
                    try:
                        labels[0].click()
                    finally:
                        if not usps.is_checked(): labels[1].click()
                    if not usps.is_checked(): raise ValueError('Depop USPS shipping could not be restored')
                    from playwright.sync_api import TimeoutError as BrowserTimeout
                    try:
                        unavailable.wait_for(state='hidden', timeout=recovery_timeout)
                        choices = page.get_by_role('combobox', name='Select an address', exact=True).or_(
                            page.get_by_test_id('address-container').locator('input[type="radio"][name="selectAddressRadio"]'))
                        choices.first.wait_for(state='visible', timeout=recovery_timeout)
                    except BrowserTimeout: pass  # Keep the original visible service error below.
                    if not usps.is_checked(): raise ValueError('Depop USPS shipping changed while loading the saved address')
    if any(unavailable.nth(index).is_visible() for index in range(unavailable.count())):
        raise ValueError('Depop saved shipping addresses are temporarily unavailable')
    address = page.get_by_role('combobox', name='Select an address', exact=True)
    if address.count() == 1:
        if select and not address.input_value().strip():
            control, options = _open_options(page, 'Select an address')
            selectable = [option for option in options if not option['disabled']]
            if len(selectable) != 1: raise ValueError('Choose the shipping address in Depop before posting')
            _select(page, control, selectable[0], 'shipping address')
        value = address.input_value().strip()
        if not value or address.get_attribute('aria-invalid') == 'true':
            raise ValueError('Depop shipping address was not confirmed')
        return ('combobox', value)
    cards = page.get_by_test_id('address-container').get_by_test_id('selectAddressRadio')
    radios = cards.locator('input[type="radio"][name="selectAddressRadio"]')
    checked = cards.locator('input[type="radio"][name="selectAddressRadio"]:checked')
    if select and checked.count() == 0 and radios.count() == 1:
        radios.check()
    if checked.count() != 1: raise ValueError('Choose one saved shipping address in Depop before posting')
    value = checked.input_value().strip()
    identifier = checked.get_attribute('id')
    label = cards.locator('label[for=' + json.dumps(identifier) + ']') if identifier else None
    if not value or checked.is_disabled() or label is None or label.count() != 1 or not label.inner_text().strip():
        raise ValueError('Depop shipping address was not confirmed')
    return ('radio', value, label.inner_text().strip())


def select_package(page, weight):
    from playwright.sync_api import TimeoutError as BrowserTimeout
    # Depop can rebuild its shipping widget after committing the initial choice.
    # Reselect only this field, with a bounded settling check; final whole-form
    # verification still runs before the caller may submit.
    for _ in range(3):
        control, options = _open_options(page, "Package size")
        if not options:
            # A rebuild can close/empty the menu between visibility and read.
            control.press('Escape')
            page.wait_for_timeout(600)
            continue
        try:
            selected = _select(page, control, parcel_option(options, weight), "Package size", click_timeout=3000)
        except BrowserTimeout:
            # The selected option can disappear while Playwright scrolls to it.
            # Reopen this field after settling, not the entire upload form.
            control.press('Escape')
            page.wait_for_timeout(600)
            continue
        except ValueError as error:
            if str(error) != "Depop Package size selection was not confirmed":
                raise
            control.press('Escape')
            page.wait_for_timeout(600)
            continue
        page.wait_for_timeout(600)
        if normalized(control.input_value()) == normalized(selected) and control.get_attribute("aria-invalid") != "true":
            return selected
    raise ValueError("Depop Package size did not retain its selection; not confirmed")


def select_brand(page, item, fields, options):
    brand = fields.get("brand")
    if not brand:
        raise ValueError("Depop brand is missing")
    # Use only the shared table's explicit aliases, never fuzzy suggestions.
    aliases = list(dict.fromkeys([brand, canonical_brand(brand)]))
    for search in aliases:
        try:
            return _select_field(page, "Brand", aliases, search=search)
        except ValueError as error:
            if str(error) != "No matching Depop Brand option":
                raise
    approved = options.get("unlistedBrands", [])
    if not isinstance(approved, list) or normalized(brand) not in {
            normalized(value) for value in approved if isinstance(value, str)}:
        raise ValueError(f"Depop does not offer {brand}; approve its Other fallback before posting") from None
    # Unbranded is an approved absence of a maker, not a real brand to
    # retain in copy; the shared description sanitizer removes that word.
    if normalized(brand) != "unbranded" and (
            normalized(brand) not in normalized(item.get("title")) or
            normalized(brand) not in normalized(fields.get("description"))):
        raise ValueError("The approved brand fallback must keep the real brand in title and description")
    return _select_field(page, "Brand", ["Other"], search="Other")


def configure_boost(page, enabled, verify_only=False):
    from playwright.sync_api import expect
    if type(enabled) is not bool:
        raise ValueError("Depop boost setting must be true or false")
    promotion = page.get_by_role("checkbox", name=re.compile(r"Promote your item in search", re.I))
    if promotion.count() != 1:
        raise ValueError("Depop promotion setting control was not found")
    if enabled:
        try:
            expect(promotion).to_have_accessible_name(re.compile(r"(?<![\d.])12%"))
        except AssertionError:
            raise ValueError("Depop boost fee changed or could not be confirmed as 12%; review before posting") from None
    if not verify_only and promotion.is_checked() != enabled:
        promotion.press('Space')
    expect(promotion).to_be_checked(checked=enabled)


def fill_listing_fields(page, item, fields, publish_options=None):
    if item.get("quantity", 1) != 1:
        raise ValueError("Depop multi-unit posting still needs native form verification")
    result = {}
    description = page.get_by_role("textbox", name="Description", exact=True)
    description.fill(fields["description"])
    if description.input_value() != fields["description"]:
        raise ValueError("Depop description was not confirmed")
    result["description"] = True

    group, category = category_path(item)
    control, options = _open_options(page, "Category")
    _select(page, control, choose_option(options, [category], group), "Category")
    result["category"] = f"{group} > {category}"
    result["brand"] = select_brand(page, item, fields, publish_options or {})
    result["condition"] = _select_field(page, "Condition", fields["condition_candidates"])

    size_control = page.get_by_role("combobox", name="Size", exact=True)
    if size_control.count():
        if not fields.get("size"):
            raise ValueError("Depop size is missing")
        candidates = size_candidates(fields["size"], item.get("itemType"), item.get('department'))
        petite = petite_size_base(item, department(item.get('department')))
        if petite: candidates.append(petite)
        result["size"] = _select_field(page, "Size", candidates)
    quantity = item.get("quantity", 1)
    quantity_control = page.get_by_role("spinbutton", name="Quantity", exact=True)
    if quantity_control.count() == 1:
        quantity_control.fill(str(quantity))
        if quantity_control.input_value() != str(quantity):
            raise ValueError("Depop quantity was not confirmed")
    elif quantity != 1:
        raise ValueError("Depop quantity control is missing for this multi-unit item")
    result["quantity"] = quantity

    result["colors"] = _fill_colors(page, [fields.get("color"), item.get("secondaryColor")])
    price = page.get_by_role("spinbutton", name="Item price", exact=True)
    value = f"{float(fields['price']):.2f}"
    price.fill(value)
    if abs(float(price.input_value()) - float(value)) > 0.001:
        raise ValueError("Depop price was not confirmed")
    result["price"] = True

    # Preserve the existing Depop-label shipping workflow, using the capacities
    # displayed NOW. The old Nifty fallback size table is not a web-form contract.
    usps = page.get_by_role("radio", name="Depop Shipping (via USPS)", exact=True)
    if not usps.is_checked():
        raise ValueError("Depop shipping is not set to the expected USPS-label method")
    address = shipping_address(page)
    result["shippingAddress"] = True
    boost = (publish_options or {}).get("boostListings", False)
    configure_boost(page, boost)
    result["boosted"] = boost
    # Select the shipping tier after the other form changes have finished.
    # Keep the final cross-field checks: a later reset must never be published.
    result["shippingPackage"] = select_package(page, item.get("weightOz"))
    expected = {"Category": category, "Brand": result["brand"], "Condition": result["condition"], "Package size": result["shippingPackage"]}
    if "size" in result:
        expected["Size"] = result["size"]
    for label, selected in expected.items():
        control = page.get_by_role("combobox", name=label, exact=True)
        if normalized(control.input_value()) != normalized(selected) or control.get_attribute("aria-invalid") == "true":
            raise ValueError(f"Depop {label} changed after selection; not confirmed")
    if description.input_value() != fields["description"] or abs(float(price.input_value()) - float(value)) > 0.001:
        raise ValueError("Depop description or price changed after filling; not confirmed")
    if shipping_address(page, select=False) != address:
        raise ValueError("Depop shipping address was not confirmed")
    if "colors" in result:
        colors = _selected_colors(page.get_by_role("combobox", name="Color", exact=True))
        if {normalized(value) for value in colors} != {normalized(value) for value in result["colors"]}:
            raise ValueError("Depop colors changed after selection; not confirmed")
    configure_boost(page, boost, verify_only=True)
    return result
