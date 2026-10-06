"""Poshmark's native listing fields. This module never presses Next or publishes."""
import re
import math
from contextlib import contextmanager, ExitStack
from pathlib import Path
import tempfile


CONDITIONS = {
    "New with tags": "New With Tags (NWT)",
    "New without tags": "Like New",
    "Like new": "Like New", "Good": "Good", "Pre-owned": "Good", "Fair": "Fair",
}
COLORS = {value.casefold(): value for value in (
    "Red", "Pink", "Orange", "Yellow", "Green", "Blue", "Purple", "Gold", "Silver",
    "Black", "Gray", "White", "Cream", "Brown", "Tan",
)}


def norm(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def category_path(item):
    department = norm(item.get("department"))
    if department in {'boy', 'boys'}:
        if norm(item.get('itemType')) != 'jeans': raise ValueError('This boys item needs a verified Poshmark category mapping')
        return 'Kids', 'Bottoms'
    if department in {"men", "mens", "male", "menswear"}:
        department = "Men"
    elif department in {"women", "womens", "female", "womenswear", "unisex", "unisexadult", "unisexadults"}:
        # User chose Women for Poshmark unisex items; Depop keeps its own rule.
        department = "Women"
    else:
        raise ValueError("Poshmark needs a reviewed Men or Women department")
    kind = norm(item.get("itemType"))
    groups = [
        (("hoodie", "sweatshirt"), "Shirts" if department == "Men" else "Tops"),
        (("tshirt", "tee", "shirt", "polo", "buttonup", "buttondown", "blouse", "tanktop", "tank", "camisole", "cami", "top", "bodysuit"), "Shirts" if department == "Men" else "Tops"),
        (("cardigan", "sweater", "pullover"), "Sweaters"),
        (("jacket", "coat", "vest"), "Jackets & Coats"),
        (("jeans",), "Jeans"), (("shorts",), "Shorts"),
        (("pants", "trousers", "leggings", "jumpsuit"), "Pants" if department == "Men" else "Pants & Jumpsuits"),
        (("dress",), "Dresses" if department == "Women" else None),
        (("skirt",), "Skirts" if department == "Women" else None),
        (("bag",), "Bags"), (("shoes", "sneakers", "boots", "sandals"), "Shoes"),
        (("bra", "bralette", "sleepwear"), "Intimates & Sleepwear" if department == "Women" else None),
        (("necklace", "bracelet", "earrings", "jewelry"), "Jewelry" if department == "Women" else "Accessories"),
        (("hat", "cap", "belt", "scarf"), "Accessories"),
    ]
    for endings, group in groups:
        if any(kind.endswith(ending) for ending in endings) and group:
            return department, group
    raise ValueError("Poshmark has no verified category mapping for this item type")


def size_label(value):
    raw = str(value or "").strip()
    if re.fullmatch(r'\d+p', raw, re.I): return raw.upper()
    return {"xs": "XS", "s": "S", "m": "M", "l": "L", "xl": "XL",
            "extrasmall": "XS", "small": "S", "medium": "M", "large": "L",
            "extralarge": "XL", "xxlarge": "XXL", "2xl": "XXL", "xxl": "XXL"}.get(norm(value), raw)


def alphabetic_jeans_size(department, item_type, size, quantity):
    return department == 'Women' and norm(item_type) == 'jeans' and quantity == 1 and size_label(size) in {'XS','S','M','L','XL'}


def select_size(page, value, department, item_type=None, quantity=1, custom_numeric=False):
    """Select inside the size-picker scope supplied by fill_size."""
    from playwright.sync_api import expect
    size = size_label(value)
    junior = False
    if department == 'Boys':
        if quantity != 1: raise ValueError('Poshmark boys multi-unit sizes need verification')
        page.get_by_text('Boys', exact=True).click()
    elif custom_numeric and department == 'Women':
        tab = page.get_by_text('Juniors', exact=True)
        if tab.count():
            from playwright.sync_api import expect
            expect(tab).to_have_count(1); tab.click(); junior = True
    choice = page.get_by_role('button', name=size, exact=True)
    if choice.count() == 0 and re.fullmatch(r'\d{2}', size):
        waist = page.get_by_role('button', name='Waist ' + size, exact=True)
        if waist.count() == 1:
            size = 'Waist ' + size
            choice = waist
    # Poshmark puts plain men's XXL and larger under this tab alongside tall
    # variants. Select the exact plain label; never substitute an LT/XLT size.
    if choice.count() == 0 and department == 'Men' and norm(size) in {'xxl','3xl','4xl','5xl','6xl'}:
        tab = page.get_by_text('Big & Tall', exact=True)
        expect(tab).to_have_count(1)
        tab.click()
    elif choice.count() == 0 and department == 'Women' and re.fullmatch(r'\d+P', size):
        tab = page.get_by_text('Petite', exact=True)
        expect(tab).to_have_count(1)
        tab.click()
    elif choice.count() == 0 and department == 'Women' and norm(size) in {'xxl','xxxl','0x','1x','2x','3x','4x','5x'}:
        # Women's Plus includes both XXL and 2X. They are different choices;
        # open that tab and retain the exact reviewed label.
        tab = page.get_by_text('Plus', exact=True)
        expect(tab).to_have_count(1)
        tab.click()
    custom = (norm(item_type) == 'belt' and re.fullmatch(r'\d{2}', size)
              or custom_numeric and re.fullmatch(r'\d{1,2}', size)
              or alphabetic_jeans_size(department, item_type, size, quantity))
    if choice.count() == 0 and custom:
        page.get_by_text('Custom', exact=True).click()
        field = page.locator('#customSizeInput0')
        expect(field).to_have_count(1)
        field.fill(''); field.press_sequentially(size, delay=35); field.press('Tab')
        expect(field).to_have_value(size)
        page.get_by_role('button', name='Save', exact=True).click()
        if quantity == 1: page.get_by_role('button', name='Done', exact=True).click()
        return size
    expect(choice).to_have_count(1)
    choice.click()
    return size + ' (Boy)' if department == 'Boys' else size + ' (Juniors)' if junior else size


def fill_size(page, value, department, item_type=None, quantity=1, custom_numeric=False):
    from playwright.sync_api import expect
    from .choice_scope import opened_choices
    trigger = page.locator('.dropdown__selector:visible').filter(has_text=re.compile(r'^\s*(?:Select Size|OS|One Size)\s*$'))
    expect(trigger).to_have_count(1)
    selected = trigger.inner_text().strip()
    if quantity == 1 and norm(value) in {'onesize','onesizefitsall','os'} and norm(selected) in {'os','onesize'}:
        return selected
    menu,_dialog = opened_choices(page, trigger, trigger.click, 'Poshmark Size', adjacent_panel=True)
    return select_size(menu, value, department, item_type, quantity, custom_numeric)


def select_condition(page, condition):
    from playwright.sync_api import expect
    page.get_by_text('Select Condition', exact=True).click()
    choice = page.get_by_role('list').filter(visible=True).get_by_text(condition, exact=True)
    expect(choice).to_have_count(1); choice.click()
    expect(page.locator('.dropdown__selector:visible').filter(has_text=re.compile(rf'^\s*{re.escape(condition)}\s*$'))).to_have_count(1)


def colors_for(item):
    values = []
    for field in ("color", "secondaryColor"):
        raw = item.get(field)
        if not raw:
            continue
        name = str(raw).strip().casefold()
        # Poshmark exposes basic color families; keep the reviewed shade in
        # listing copy while mapping the dark-red shades to its Red option.
        name = {"grey":"gray", "maroon":"red", "burgundy":"red", "navy":"blue",
                "teal":"blue", "olive":"green", "beige":"tan"}.get(name,name)
        if name not in COLORS:
            raise ValueError(f"Poshmark has no exact color option for {raw}")
        if COLORS[name] not in values: values.append(COLORS[name])
    return values


def fill_checked(locator, value):
    value = str(value)
    limit = locator.get_attribute("maxlength")
    if limit and limit.isdigit() and len(value) > int(limit):
        raise ValueError("Reviewed text exceeds this Poshmark field's length limit")
    locator.fill(value)
    if locator.input_value() != value:
        raise ValueError("Poshmark did not retain the reviewed field value")


def whole_price(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("Poshmark needs a valid price")
    # Nearest dollar, with .50 going up. Python round() uses a different tie rule.
    lower = math.floor(value)
    rounded = lower + (value - lower >= 0.5)
    if not 1 <= rounded <= 9007199254740991:
        raise ValueError("Poshmark needs a valid price that rounds to at least $1")
    return str(rounded)


def quantity_for(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 999:
        raise ValueError("Poshmark quantity must be a whole number from 1 to 999")
    return value


def verify_quantity(page, item):
    from playwright.sync_api import expect
    quantity = quantity_for(item.get("quantity", 1))
    rows = page.locator("tr.listing-editor__inventory-table-body-row")
    if quantity == 1:
        expect(rows).to_have_count(0)
        return
    expect(rows).to_have_count(1)
    size = size_label(item.get("size"))
    expected = re.compile(r'^(?:Waist\s+)?' + re.escape(size) + '$') if re.fullmatch(r'\d{2}',size) else size
    expect(rows.locator("td").first).to_have_text(expected)
    expect(rows.locator('input[data-vv-name="quantityAvailable0"]')).to_have_value(str(quantity))
    expect(rows.locator('input[data-vv-name="sku0"]')).to_have_value(item["sku"])


def verify_reviewed_size_selection(page, filled):
    if filled.get('department') == 'Kids': values = ['Kids Bottoms', 'Jeans', filled['size']]
    elif filled.get('reviewedSizeScale'): values = [filled['size']]
    else: return
    from playwright.sync_api import expect
    for value in values:
        expect(page.locator('.dropdown__selector:visible').filter(has_text=re.compile(rf'^\s*{re.escape(value)}\s*$'))).to_have_count(1)


def fill_listing_fields(page, item):
    from playwright.sync_api import expect

    department, group = category_path(item)
    condition = CONDITIONS.get(item.get("condition"))
    if not condition: raise ValueError("Poshmark condition is not mapped")
    quantity = quantity_for(item.get("quantity", 1))
    colors = colors_for(item)
    size = size_label(item.get("size"))
    if not size: raise ValueError("Poshmark needs a reviewed size")
    price = whole_price(item.get("price"))

    fill_checked(page.get_by_placeholder("What are you selling? (required)", exact=True), item["title"])
    fill_checked(page.get_by_placeholder("Describe it! (required)", exact=True), item["description"])
    page.get_by_text("Select Category", exact=True).click()
    page.locator("p").filter(has_text=re.compile(rf"^\s*{re.escape(department)}\s*$")).click()
    page.get_by_text(group, exact=True).click()
    expect(page.locator(".dropdown__selector:visible").filter(has_text=re.compile(rf"^\s*{department} {re.escape(group)}\s*$"))).to_have_count(1)
    if norm(item.get('itemType')) == 'belt':
        belts = page.get_by_text('Belts', exact=True)
        if belts.count() != 1 or not belts.is_visible():
            page.get_by_text('Select Subcategory (optional)', exact=True).click()
        expect(belts).to_have_count(1); belts.click()
        expect(page.locator('.dropdown__selector:visible').filter(has_text=re.compile(r'^\s*Belts\s*$'))).to_have_count(1)

    if quantity > 1: page.get_by_role("button", name="Multi Item", exact=True).click()
    custom_numeric = department == 'Women' and norm(item.get('itemType')) == 'jeans' and bool(re.search(r'\bjuniors?\b', str(item.get('title') or ''), re.I))
    size = fill_size(page, size, 'Boys' if department == 'Kids' else department, item.get('itemType'), quantity, custom_numeric)
    if quantity > 1:
        page.get_by_role("button", name="Done", exact=True).click()
        fill_checked(page.locator('input[data-vv-name="quantityAvailable0"]'), quantity)
        page.get_by_text("Add item SKUs", exact=True).click()
        fill_checked(page.locator('input[data-vv-name="sku0"]'), item["sku"])
    else:
        # Single-item sizes commit immediately; Multi Item requires Done.
        expect(page.locator(".dropdown__selector:visible").filter(has_text=re.compile(rf"^\s*{re.escape(size)}\s*$"))).to_have_count(1)
    verify_quantity(page, item)
    if department == 'Kids':
        # Kids subcategories become usable after its size data has loaded.
        # Recheck size afterwards because a subcategory change can reset it.
        page.locator('.dropdown__selector:visible').filter(has_text=re.compile(r'^\s*Select Subcategory \(optional\)\s*$')).click()
        jeans = page.get_by_text('Jeans', exact=True).filter(visible=True)
        expect(jeans).to_have_count(1); jeans.click()
        expect(page.locator('.dropdown__selector:visible').filter(has_text=re.compile(r'^\s*Jeans\s*$'))).to_have_count(1)
        reset = page.locator('.dropdown__selector:visible').filter(has_text=re.compile(r'^\s*Select Size\s*$'))
        if reset.count(): size = fill_size(page, item['size'], 'Boys', item.get('itemType'), quantity)
        expect(page.locator('.dropdown__selector:visible').filter(has_text=re.compile(rf'^\s*{re.escape(size)}\s*$'))).to_have_count(1)
    select_condition(page, condition)

    if item.get("brand"):
        fill_checked(page.get_by_placeholder("Enter the Brand/Designer", exact=True), item["brand"])
        page.get_by_placeholder("Enter the Brand/Designer", exact=True).press("Tab")
    if colors:
        page.get_by_text("Select up to 2 colors", exact=True).click()
        for color in colors: page.get_by_text(color, exact=True).click()
        page.get_by_role("button", name="Done", exact=True).click()
        selected = page.locator('[data-et-name="color"] li')
        expect(selected).to_have_count(len(colors))
        if [text.strip() for text in selected.all_text_contents()] != colors:
            raise ValueError("Poshmark colors did not match the reviewed colors")

    # Original price is a separate optional field with the same placeholder.
    price_field = page.locator('input[data-vv-name="listingPrice"]')
    price_field.click()
    fill_checked(page.get_by_role("textbox", name="Listing Price", exact=True), price)
    page.get_by_role("button", name="Done", exact=True).click()
    expect(price_field).to_have_value(price)
    page.get_by_text("show details", exact=True).click()
    fill_checked(page.get_by_role("textbox", name="sku", exact=True), item["sku"])
    expect(page.get_by_text("Smart Sell OFF", exact=True)).to_be_visible()
    expect(page.locator(".dropdown__selector:visible").filter(has_text=re.compile(r"^For Sale$"))).to_have_count(1)
    return {"department": department, "category": group, "size": size, "quantity": quantity, "condition": condition, "colors": colors,
            **({'reviewedSizeScale': True} if custom_numeric or alphabetic_jeans_size(department, item.get('itemType'), size, quantity) else {})}


@contextmanager
def upload_photo_copies(photos):
    """Fit the entire reviewed image into Poshmark's fixed 3:4 crop viewport."""
    from PIL import Image, ImageOps
    directory=Path(tempfile.mkdtemp(prefix='blackcat-poshmark-photos-'))
    copies=[]
    try:
        for index,source in enumerate(photos):
            with Image.open(source) as original:
                picture=ImageOps.exif_transpose(original).convert('RGBA')
            width=3*max(1,math.ceil(min(1200,max(picture.width,picture.height*3/4))/3))
            height=width*4//3
            picture.thumbnail((width,height),Image.Resampling.LANCZOS)
            canvas=Image.new('RGB',(width,height),'white')
            canvas.paste(picture,((width-picture.width)//2,(height-picture.height)//2),picture)
            target=directory/f'{index:02d}-{Path(source).stem}.jpg'
            copies.append(str(target));canvas.save(target,'JPEG',quality=95,subsampling=0)
        yield copies
    finally:
        # Remove only files this call created, without any recursive directory
        # deletion. A browser holding a file open must not mask a listing result.
        for value in copies:
            try:Path(value).unlink(missing_ok=True)
            except OSError:pass
        try:directory.rmdir()
        except OSError:pass


def attach_photos(page, photos, *, lifetime=None):
    """Attach local files and accept the initial covershot; not remote-upload proof."""
    from playwright.sync_api import expect

    if lifetime is None:
        with ExitStack() as local:
            return attach_photos(page,photos,lifetime=local)
    if not 1 <= len(photos) <= 16: raise ValueError("Poshmark requires 1 to 16 listing photos")
    thumbnails = page.locator('img.listing-editor__image')
    if thumbnails.count() or page.locator('img[alt="thumb"]').count():
        raise ValueError("Poshmark already contains photos; refusing to mix listings")
    # Local previews do not prove that later submission finished reading its
    # File objects. The publisher owns these copies through public verification.
    copies=lifetime.enter_context(upload_photo_copies(photos))
    page.locator("#img-file-input").set_input_files(copies)
    page.get_by_role("button", name="Apply", exact=True).click()
    expect(page.get_by_text("Select a Covershot.", exact=True)).not_to_be_visible(timeout=30_000)
    expect(thumbnails).to_have_count(len(photos), timeout=30_000)
    page.wait_for_function("n => {const imgs=[...document.querySelectorAll('img.listing-editor__image')];return imgs.length===n && imgs.every(i=>i.complete&&i.naturalWidth>0)}", arg=len(photos), timeout=30_000)
    return len(photos)
