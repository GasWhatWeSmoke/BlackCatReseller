"""Reviewed core fields for Etsy's native editor. Never saves or publishes."""
import math
import re
from .work_browser import keep_work_page_ready
from decimal import Decimal
from .etsy_custom_size import custom_size_value, custom_size_in_use, fill_custom_size, verify_custom_size


def _norm(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def _button_front(kind):
    return any(kind.endswith(ending) for ending in ('buttondown','buttondownshirt','buttonup','buttonupshirt'))


def category_label(item):
    department = _norm(item.get("department"))
    prefix = {"women": "Women's", "womens": "Women's", "men": "Men's", "mens": "Men's",
              "unisex": "Gender-Neutral Adult", "unisexadult": "Gender-Neutral Adult", "unisexadults": "Gender-Neutral Adult"}.get(department)
    if not prefix:
        raise ValueError("Etsy needs a reviewed adult department for this category mapping")
    kind = _norm(item.get("itemType"))
    families = {
        "tshirt": "T-Shirts", "tee": "T-Shirts", "tank": "Tank Tops", "tanktop": "Tank Tops",
        "shorts": "Shorts", "jeans": "Jeans", "pants": "Pants", "trousers": "Pants",
        "sweater": "Sweaters", "cardigan": "Cardigans", "hoodie": "Hoodies",
        "sweatshirt": "Sweatshirts", "dress": "Dresses", "skirt": "Skirts",
    }
    family = families.get(kind)
    if not family and kind.endswith('tshirt'):
        family = 'T-Shirts'
    if prefix == "Men's" and _button_front(kind):
        family = 'Oxfords & Button Downs'
    elif kind in {"shirt", "longsleeveshirt", "longsleevebuttondown", "buttondown", "buttonup", "blouse", "top"}:
        family = "Shirts & Tees" if prefix == "Men's" else "Tops & Tees"
    if not family:
        raise ValueError("Etsy has no verified category search for this item type")
    return f"{prefix} {family}"


def fill_category(page, item):
    from playwright.sync_api import expect
    label = category_label(item)
    control = page.locator("#listing-editor_category-search-typeahead")
    keep_work_page_ready(page)
    if control.get_attribute("readonly") is not None:
        control.hover()
        page.locator('#field-category button[aria-label="Clear"]').click()
    expect(control).to_be_editable()
    # This native search commits its query through keyboard events; fill() can
    # be reset by its controlled state without producing any search results.
    control.click()
    control.press("ControlOrMeta+A")
    control.press_sequentially(label, delay=70)
    expect(control).to_have_value(label)
    # Read the primary label, excluding the Physical custom element's shadow
    # content. Recent shortcuts omit gender and are not category evidence.
    primary = page.locator("p > span:first-child").filter(
        has_text=re.compile("^" + re.escape(label) + "$", re.I))
    option = page.locator('[id^="category-search-option-"]').filter(
        has=primary)
    expect(option).to_have_count(1, timeout=15000)
    if option.locator("clg-signal").evaluate_all("els=>els.map(e=>e.textContent.trim())") != ["Physical"]:
        raise ValueError("Etsy category is not confirmed as a physical item")
    keep_work_page_ready(page)
    option.click()
    # Etsy's warning is in a portal without role=dialog. The input echoes the
    # new category BEFORE this confirmation while size still uses the old one.
    status = page.locator('#field-category [role="status"]')
    confirm = page.locator("#wt-portals").filter(
        has_text="Warning: Changing category will reset attributes").get_by_role(
        "button", name="Change category anyway", exact=True)
    from time import monotonic
    deadline = monotonic() + 15
    while monotonic() < deadline:
        if confirm.is_visible():
            confirm.click()
            break
        if status.count() == 1 and status.inner_text().strip().casefold() == f"Category changed to {label}".casefold():
            break
        page.wait_for_timeout(100)
    expect(status).to_have_text(re.compile("^Category changed to " + re.escape(label) + "$", re.I), timeout=15000)
    return label


def size_label(value):
    raw = str(value or "").strip()
    return {"extrasmall": "XS", "small": "S", "medium": "M", "large": "L",
            "extralarge": "XL", "xxlarge": "XXL", "xxsmall": "XXS",
            "onesize": "One size"}.get(_norm(raw), raw)


def size_scale_label(item):
    size = size_label(item.get("size"))
    if not size:
        raise ValueError("Etsy needs a reviewed size")
    department = _norm(item.get("department"))
    gender = "women's" if department in {"women", "womens"} else "men's" if department in {"men", "mens"} else None
    if gender is None:
        # Gender-neutral taxonomy has its own choices; use its unqualified US
        # scale only when actually offered, never silently assign men's sizing.
        if department not in {"unisex", "unisexadult", "unisexadults"}:
            raise ValueError("Etsy size needs a reviewed adult department")
        gender = ""
    style = "numeric" if re.fullmatch(r"\d+(?:\.\d+)?", size) else "letter"
    return " ".join(part for part in ("US", gender, style) if part)


def size_scale_candidates(item):
    wanted=size_scale_label(item)
    # These observed categories expose an unqualified US letter scale in the verified
    # department category. It preserves the letter size; it is not a conversion.
    kind = _norm(item.get('itemType'))
    unqualified = (kind.endswith('shorts') or (kind.endswith('tshirt') and not kind.endswith('sweatshirt')) or kind == 'tee'
                   or (_norm(item.get('department')) in {'men','mens'} and _button_front(kind)))
    if unqualified and wanted.endswith(' letter') and wanted!='US letter':
        return [wanted,'US letter']
    return [wanted]


def size_field_label(item):
    kind = _norm(item.get('itemType'))
    if kind.endswith('shorts'): return 'Waist size'
    if _norm(item.get('department')) in {'men','mens'} and _button_front(kind): return 'Chest size'
    return 'Size'


def choose_size_scale(item, options):
    """Use only the department's offered US scale; never convert sizes across it."""
    wanted = size_scale_label(item)
    for label in size_scale_candidates(item):
        if label == 'US letter' and wanted != 'US letter' and any(
                _norm(o.get('text')) in {'usmensletter','uswomensletter'} for o in options if not o.get('disabled')):
            continue
        matches = [o for o in options if not o.get("disabled") and _norm(o.get("text")) == _norm(label)]
        if len(matches)==1:return matches[0]['value']
        if len(matches)>1:break
    raise ValueError(f"Etsy does not offer one exact {wanted} scale for this reviewed size")


def fill_size(page, item):
    from playwright.sync_api import expect
    if custom_size_in_use(page, item):
        return fill_custom_size(page, item)
    wanted = size_label(item.get("size"))
    scale = page.locator("#attributes-1-scale-select")
    # Fresh editors load category attributes after acknowledging the category.
    available=re.compile('^(?:'+'|'.join(re.escape(label) for label in size_scale_candidates(item))+')$',re.I)
    expect(scale.locator('option').filter(has_text=available).first).to_be_attached(timeout=15000)
    options = scale.locator("option").evaluate_all("els=>els.map(e=>({value:e.value,text:e.textContent.trim(),disabled:e.disabled}))")
    selected = choose_size_scale(item, options)
    scale.select_option(selected)
    keep_work_page_ready(page)
    control = page.get_by_label(size_field_label(item), exact=True)
    control.click()
    choice = page.get_by_role("menuitemradio", name=re.compile("^" + re.escape(wanted) + "$", re.I))
    expect(page.get_by_role('menuitemradio')).not_to_have_count(0, timeout=15000)
    if choice.count() == 0 and custom_size_value(item) is not None:
        # Preserve the reviewed number; never turn a waist/tag label into a
        # nearby US dress size. Only fall back after native options have loaded.
        control.press('Escape')
        return fill_custom_size(page, item)
    expect(choice).to_have_count(1)
    choice.click()
    expect(control).to_have_value(re.compile("^" + re.escape(wanted) + "$", re.I))
    expect(scale).to_have_value(selected)
    return wanted


def verify_native_size(page, item):
    from playwright.sync_api import expect
    expect(page.get_by_label(size_field_label(item), exact=True)).to_have_value(re.compile('^' + re.escape(size_label(item.get('size'))) + '$', re.I))
    scale = page.locator('#attributes-1-scale-select')
    scales = scale.locator('option').evaluate_all('els=>els.map(e=>({text:e.textContent.trim(),value:e.value,disabled:e.disabled}))')
    expect(scale).to_have_value(choose_size_scale(item, scales))


def shipping_values(item):
    weight = item.get("weightOz")
    dims = item.get("packageDims")
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
        raise ValueError("Etsy needs a positive package weight")
    if not isinstance(dims, dict) or any(isinstance(dims.get(k), bool) or not isinstance(dims.get(k), (int, float)) or
            not math.isfinite(dims[k]) or dims[k] <= 0 for k in ("length", "width", "height")):
        raise ValueError("Etsy needs positive package dimensions")
    pounds, ounces = divmod(Decimal(str(weight)), Decimal(16))
    number = lambda value: format(Decimal(str(value)).normalize(), "f")
    return {"#listing-weight-primary-input": number(pounds),
            "#listing-weight-secondary-input": number(ounces),
            **{f"#shipping_item_dimension-item{k.title()}": number(dims[k]) for k in ("length", "width", "height")}}


def fill_package(page, item):
    from playwright.sync_api import expect
    values = shipping_values(item)
    for selector, value in values.items():
        page.locator(selector).fill(value)
    for selector, value in values.items():
        expect(page.locator(selector)).to_have_value(value)
    return {"weight": True, "dimensions": True}


def fill_shipping_profile(page, name):
    from playwright.sync_api import expect
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Choose the Etsy shipping profile in Black Cat Settings")
    name = name.strip()
    section = page.locator("#field-sourceShippingProfileId")
    keep_work_page_ready(page)
    selected = section.get_by_text(name, exact=True)
    if selected.count() != 1 or not selected.is_visible():
        button = section.get_by_role("button", name="Select profile", exact=True)
        if not button.is_visible():
            button = section.get_by_role("button", name="Change", exact=True)
        button.click()
        # The picker repeats the current profile above the full list as Applied.
        # Only a card offering Apply is an actionable choice.
        card = page.locator("#wt-portals .wt-panel:visible").filter(has=page.get_by_text(name, exact=True)).filter(
            has=page.get_by_role("button", name="Apply", exact=True))
        expect(card).to_have_count(1, timeout=15000)
        card.get_by_role("button", name="Apply", exact=True).click()
    expect(section.get_by_text(name, exact=True)).to_be_visible()
    # Keep the shop's selected processing and return policies. Do not create or
    # rewrite shop policies while posting an individual item.
    processing = page.locator("#field-readinessStateId")
    returns = page.locator("#field-returnPolicyId")
    expect(processing.get_by_role("button", name="Change profile", exact=True)).to_be_visible()
    expect(processing).to_contain_text("Ready to ship")
    expect(returns.get_by_role("button", name="Change policy", exact=True)).to_be_visible()
    return name


def set_renewal(page, automatic):
    from playwright.sync_api import expect
    if type(automatic) is not bool:
        raise ValueError("Etsy renewal needs an explicit manual or automatic choice")
    radio = page.get_by_role("radio", name=re.compile(r"^Automatic" if automatic else r"^Manual"))
    expect(radio).to_be_enabled()
    if not radio.is_checked():
        # Etsy's styled label and sticky footer can cover the native radio.
        # Activate the accessible radio with its normal keyboard interaction.
        keep_work_page_ready(page)
        radio.press("Space")
    expect(radio).to_be_checked()


def verify_filled_listing(page, item, options, photos):
    from playwright.sync_api import expect
    values = reviewed_core(item)
    for key, selector in {"title": "#listing-title-input", "description": "#listing-description-textarea",
                          "price": "#listing-price-input", "quantity": "#listing-quantity-input", "sku": "#listing-sku-input"}.items():
        expect(page.locator(selector)).to_have_value(values[key])
    expect(page.get_by_role("radio", name="Another company or person", exact=True)).to_be_checked()
    expect(page.get_by_role("radio", name="A finished product", exact=True)).to_be_checked()
    era = page.locator("#when-made-select")
    eras = era.locator("option").evaluate_all("""els=>els.map(e=>({value:e.value,text:e.textContent.trim(),
      group:e.parentElement.tagName==='OPTGROUP'?e.parentElement.label:'',disabled:!!(e.disabled||e.parentElement.disabled)}))""")
    expect(era).to_have_value(choose_vintage_era(values["whenMade"], eras))
    expect(page.locator('#field-category [role="status"]')).to_have_text(
        re.compile("^Category changed to " + re.escape(category_label(item)) + "$", re.I))
    if custom_size_in_use(page, item):
        verify_custom_size(page, item)
    else:
        verify_native_size(page, item)
    for selector, value in shipping_values(item).items():
        expect(page.locator(selector)).to_have_value(value)
    expect(page.locator("#field-sourceShippingProfileId").get_by_text(options["shippingProfileName"].strip(), exact=True)).to_be_visible()
    expect(page.get_by_role("radio", name=re.compile(r"^Automatic" if options["autoRenew"] else r"^Manual"))).to_be_checked()
    verify_photos(page, len(photos))


def photo_snapshot(page):
    tiles = page.locator("#field-listingImages .le-media-grid__item").filter(
        has=page.locator('[data-testid="image-delete-button"]'))
    result = []
    for index in range(tiles.count()):
        image = tiles.nth(index).locator("img")  # also finds Etsy's shadow-root image
        if image.count() != 1:
            result.append({"ready": False})
            continue
        result.append(image.evaluate("""e=>({ready:e.complete && e.naturalWidth>0 && (()=>{
          try{const u=new URL(e.currentSrc);return u.protocol==='https:'&&u.hostname==='i.etsystatic.com'}catch{return false}
        })(),alt:e.alt})"""))
    return result


def verify_photos(page, count, timeout=90):
    from time import monotonic
    if type(count) is not int or not 1 <= count <= 20:
        raise ValueError("Etsy photo verification needs a count from 1 to 20")
    keep_work_page_ready(page)
    page.locator("#field-listingImages").scroll_into_view_if_needed()
    deadline = monotonic() + timeout
    while True:
        images = photo_snapshot(page)
        if len(images) > count:
            raise ValueError("Etsy contains more photos than this reviewed item")
        expected = ["Primary listing image"] + [f"Edit Listing image {index}" for index in range(2, count + 1)]
        if len(images) == count and all(image.get("ready") and image.get("alt") == alt for image, alt in zip(images, expected)):
            return count
        if monotonic() >= deadline:
            raise ValueError("Etsy photo upload is incomplete or could not be verified")
        page.wait_for_timeout(250)


def attach_photos(page, photos):
    from pathlib import Path
    from playwright.sync_api import TimeoutError as BrowserTimeout, Error as BrowserError
    if not isinstance(photos, list) or not 1 <= len(photos) <= 20 or any(not isinstance(p, str) or not Path(p).is_file() for p in photos):
        raise ValueError("Etsy needs 1 to 20 existing reviewed photo files")
    if photo_snapshot(page):
        raise ValueError("Etsy already contains photos; refusing to mix items or repeat an upload")
    # An empty editor has one combined file input. After uploading it is replaced
    # with separate Add photos/Add videos controls; do not reuse that old input.
    uploader = page.locator('#field-listingImages input[type="file"]')
    if uploader.count() != 1:
        raise ValueError("Etsy's empty photo uploader could not be identified")
    try:
        uploader.set_input_files(photos, timeout=120000)
    except BrowserTimeout:
        # A timeout can still have uploaded all images. Inspect CDN thumbnails;
        # NEVER call set_input_files a second time and duplicate the photo set.
        pass
    except BrowserError as error:
        if 'Cannot transfer files larger than 50Mb to a browser not co-located with the server' not in str(error):
            raise
        if photo_snapshot(page):
            raise ValueError('Etsy gallery changed during a rejected transfer') from error
        # The transport rejected the batch before sending any files. Etsy gives
        # both new inputs the same accept list; the photo-specific parent tells
        # the image control apart from Add videos after the first upload.
        for count, photo in enumerate(photos, 1):
            if count > 1:
                uploader = page.locator('#field-listingImages [data-testid="empty-photo-thumbnail"] input[type="file"]')
            if uploader.count() != 1 or not uploader.is_enabled():
                raise ValueError('Etsy Add photos uploader could not be identified')
            try: uploader.set_input_files(photo, timeout=120000)
            except BrowserTimeout: pass
            verify_photos(page, count)
        return len(photos)
    return verify_photos(page, len(photos))


def reviewed_core(item):
    if item.get("trueVintage") is not True:
        raise ValueError("Direct Etsy resale needs the reviewed True Vintage confirmation")
    era = item.get("whenMade")
    if not isinstance(era, str) or not era.strip(): raise ValueError("The reviewed manufacturing era is missing")
    for field in ("sku", "title", "description"):
        if not isinstance(item.get(field), str) or not item[field].strip(): raise ValueError(f"The reviewed {field} is missing")
    price = item.get("price")
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0 or round(price, 2) != price:
        raise ValueError("Etsy requires a positive reviewed price in whole cents")
    if type(item.get("quantity")) is not int or item["quantity"] != 1:
        raise ValueError("This direct Etsy workflow lists one item at a time")
    return {"sku": item["sku"], "title": item["title"], "description": item["description"],
            "price": f"{price:.2f}", "quantity": "1", "whenMade": era}


def choose_vintage_era(reviewed, options):
    """Match the reviewed era exactly inside Etsy's actual Vintage group.
    Never use a shared year to match a Recently option or guess an older decade.
    """
    if not isinstance(reviewed, str) or not isinstance(options, list): raise ValueError("Etsy manufacturing choices are unavailable")
    label = re.sub(r"\s*\(Vintage\)\s*$", "", reviewed.strip(), flags=re.I)
    normalize = lambda value: " ".join(value.replace("–", "-").replace("—", "-").split()).casefold()
    matches = [option for option in options if isinstance(option, dict) and option.get("group") == "Vintage" and
               option.get("disabled") is False and isinstance(option.get("text"), str) and
               isinstance(option.get("value"), str) and option["value"] and normalize(option["text"]) == normalize(label)]
    if len(matches) != 1: raise ValueError("Etsy does not offer one exact Vintage option for the reviewed era")
    return matches[0]["value"]


def fill_reviewed_core(page, item):
    from playwright.sync_api import expect
    values = reviewed_core(item)
    era = page.locator("#when-made-select")
    options = era.locator("option").evaluate_all("""els=>els.map(e=>({value:e.value,text:e.textContent.trim(),
      group:e.parentElement.tagName==='OPTGROUP'?e.parentElement.label:'',disabled:!!(e.disabled||e.parentElement.disabled)}))""")
    choice = choose_vintage_era(values["whenMade"], options)
    maker = page.get_by_role("radio", name="Another company or person", exact=True)
    product = page.get_by_role("radio", name="A finished product", exact=True)
    keep_work_page_ready(page)
    for radio in (maker, product):
        expect(radio).to_be_enabled()
        if not radio.is_checked(): radio.press("Space")
    era.select_option(choice)
    fields = {"title": "#listing-title-input", "description": "#listing-description-textarea",
              "price": "#listing-price-input", "quantity": "#listing-quantity-input", "sku": "#listing-sku-input"}
    for field, selector in fields.items():
        control = page.locator(selector)
        if field == "sku" and not control.is_visible(): page.get_by_role("button", name="Add SKU", exact=True).click()
        control.fill(values[field])
    # This verifies the core only. Category, size, photos, shipping and the final
    # publication check remain the caller's responsibility.
    expect(maker).to_be_checked(); expect(product).to_be_checked()
    expect(era).to_have_value(choice)
    for field, selector in fields.items(): expect(page.locator(selector)).to_have_value(values[field])
    return {"title": True, "description": True, "price": True, "quantity": True, "sku": True, "whenMade": True}
