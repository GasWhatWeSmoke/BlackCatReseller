"""eBay's browser listing form. These helpers never click List it."""
import json
import math
import re
from decimal import Decimal, InvalidOperation
from .work_browser import keep_work_page_ready
from .choice_scope import opened_choices
from contextlib import contextmanager
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit, urljoin

CREATE_URL = "https://www.ebay.com/sl/sell"
CONDITIONS = {
    "New with tags": ["New with tags"], "New without tags": ["New without tags"],
    "Like new": ["Pre-owned - Excellent", "Pre-owned"],
    "Good": ["Pre-owned - Good", "Pre-owned"], "Pre-owned": ["Pre-owned - Good", "Pre-owned"],
    "Fair": ["Pre-owned - Fair", "Pre-owned"],
}


def norm(value): return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def reviewed_inseam(item, category):
    if category[-1] != 'Jeans':
        return None
    value = str(item.get('inseam') or '').strip()
    match = re.fullmatch(r'(\d{1,2}(?:\.\d{1,2})?)\s*(?:in(?:ches)?\.?|")?', value, re.I)
    if not match or float(match[1]) <= 0:
        raise ValueError('eBay jeans need a reviewed inseam measurement; the tag size is not an inseam')
    return f'{float(match[1]):g} in'


def reviewed_outer_shell_material(item, category):
    if category[-1] != 'Coats, Jackets & Vests':return None
    material=item.get('material')
    if not isinstance(material,str) or not material.strip() or norm(material)=='unknown':
        raise ValueError('eBay outerwear needs a reviewed outer shell material')
    return material.strip()


def title_for(value):
    title = " ".join(value.split())
    if len(title) <= 80: return title
    cut = title[:80]
    return cut[:cut.rfind(" ")].strip() if cut.rfind(" ") > 40 else cut.strip()


def department_for(value):
    key = norm(value)
    if key in {"men", "mens", "male", "menswear"}: return "Men"
    if key in {"women", "womens", "female", "womenswear"}: return "Women"
    if key in {"unisex", "unisexadult", "unisexadults"}: return "Unisex Adults"
    if key in {"boy", "boys"}: return "Boys"
    raise ValueError("eBay needs a reviewed adult department")


def board_shorts(item):
    kind = norm(item.get('itemType'))
    return kind.endswith('shorts') and 'board' in (kind + norm(item.get('style')))


def listing_department(item):
    department = department_for(item.get('department'))
    # eBay's swimwear category offers Men, not Unisex Adults. Keep the
    # reviewed unisex title and other marketplaces' department choices intact.
    return 'Men' if department == 'Unisex Adults' and board_shorts(item) else department


def size_and_type(item, category):
    size = {'small':'S','medium':'M','large':'L','extralarge':'XL','extrasmall':'XS'}.get(norm(item.get('size')), str(item.get('size') or ''))
    fit = norm(item.get('fit'))
    size_type = 'Petites' if 'petite' in fit else 'Big & Tall' if 'tall' in fit else 'Plus' if 'plus' in fit else 'Regular'
    petite = re.fullmatch(r'(\d+)P', size, re.I)
    if petite and "Women's Clothing" in category:
        # A title size such as 6P is size6 in the Petites scale, independently
        # of the garment's regular/slim/relaxed silhouette.
        return petite[1], 'Petites'
    if size_type == 'Regular' and "Women's Clothing" in category and re.search(r'\bjuniors?\b', str(item.get('title') or ''), re.I):
        size_type = 'Juniors'
    return size, size_type


def category_for(item):
    department = department_for(item.get("department"))
    branch = "Women" if department == "Women" else "Men"
    kind = norm(item.get("itemType"))
    prefix = ['Clothing, Shoes & Accessories', branch]
    if department == 'Boys':
        if kind != 'jeans': raise ValueError('This boys item needs a verified eBay category mapping')
        size = str(item.get('size') or '').strip()
        if not re.fullmatch(r'[0-9]+', size) or int(size) < 4:
            raise ValueError('This eBay boys jeans category needs a reviewed numeric size 4 or above')
        return ['Clothing, Shoes & Accessories', 'Kids', 'Boys', "Boys' Clothing (Sizes 4 & Up)", 'Jeans']
    if branch == 'Men' and board_shorts(item):
        return prefix + ["Men's Clothing", 'Swimwear']
    if kind in {'bag','handbag','purse','backpack','shoulderbag','duffelbag'}:
        return prefix + (["Women's Bags & Handbags"] if branch == 'Women' else ["Men's Accessories", 'Bags'])
    if branch == 'Women' and kind in {'bra','bralette'}:
        return prefix + ["Women's Clothing", 'Intimates & Sleep', 'Bras & Bra Sets']
    accessories = {'hat':'Hats','cap':'Hats','beanie':'Hats','belt':'Belts','scarf':'Scarves & Wraps' if branch == 'Women' else 'Scarves'}
    if kind in accessories:
        return prefix + ["Women's Accessories" if branch == 'Women' else "Men's Accessories", accessories[kind]]
    shoes = {'sneaker':'Athletic Shoes','sneakers':'Athletic Shoes','boots':'Boots','boot':'Boots',
             'sandals':'Sandals','sandal':'Sandals','heels':'Heels','flats':'Flats'}
    if kind in shoes:
        return prefix + ["Women's Shoes" if branch == 'Women' else "Men's Shoes", shoes[kind]]
    families = [(('hoodie', 'sweatshirt'), 'Hoodies & Sweatshirts'),
                (('tshirt', 'tee'), 'T-Shirts' if branch == 'Men' else 'Tops'),
                (('dressshirt',), 'Dress Shirts' if branch == 'Men' else 'Tops'),
                (('polo', 'poloshirt'), 'Polos' if branch == 'Men' else 'Tops'),
                (('tanktop', 'tank', 'camisole', 'cami'), 'T-Shirts' if branch == 'Men' else 'Tops'),
                (('blouse', 'shirt', 'top', 'buttondown', 'buttonup'), 'Casual Button-Down Shirts' if branch == 'Men' else 'Tops'),
                (('sweater', 'cardigan', 'pullover', 'sweatervest'), 'Sweaters'),
                (('jeans',), 'Jeans'), (('shorts',), 'Shorts'), (('pants', 'trousers'), 'Pants'),
                (('jacket', 'coat', 'vest'), 'Coats, Jackets & Vests'), (('dress',), 'Dresses'), (('skirt',), 'Skirts')]
    for endings, family in families:
        if any(kind.endswith(word) for word in endings):
            if branch == 'Men' and family in {'Dresses', 'Skirts'}: break
            parents = ["Women's Clothing" if branch == 'Women' else "Men's Clothing"]
            if branch == 'Men' and family in {'T-Shirts','Casual Button-Down Shirts','Dress Shirts','Polos'}: parents.append('Shirts')
            if branch == 'Women' and family == 'Hoodies & Sweatshirts': parents.append('Activewear')
            return prefix + parents + [family]
    raise ValueError("This item needs an eBay category mapping")


def visible(locator):
    return [locator.nth(index) for index in range(locator.count()) if locator.nth(index).is_visible()]


def type_specifics(item):
    kind=norm(item.get('itemType'))
    if board_shorts(item) and department_for(item.get('department')) != 'Women':
        return {'Type':'Bottom','Swim Bottom Style':'Board Shorts'}
    if kind in {'tank','tanktop','camisole','cami'}:
        return {'Type':'Tank'} if department_for(item.get('department'))=='Women' else {'Type':'T-Shirt','Sleeve Length':'Sleeveless'}
    if kind.endswith(('buttondown','buttonup','buttondownshirt','buttonupshirt')):
        result = {'Type':'Button-Up'}
        if kind.startswith('longsleeve'): result['Sleeve Length'] = 'Long Sleeve'
        elif kind.startswith('shortsleeve'): result['Sleeve Length'] = 'Short Sleeve'
        return result
    if kind.endswith('tshirt') and not kind.endswith('sweatshirt'):
        result = {'Type':'T-Shirt'}
        if kind.startswith('longsleeve'): result['Sleeve Length'] = 'Long Sleeve'
        elif kind.startswith('shortsleeve'): result['Sleeve Length'] = 'Short Sleeve'
        return result
    if kind.endswith('skirt'):
        copy = ' '.join(str(item.get(field) or '') for field in ['title','description','itemType'])
        lengths = {value for word,value in [('mini','Short'),('short','Short'),('midi','Midi'),('maxi','Long')]
                   if re.search(r'\b'+word+r'[\s-]*skirt\b',copy,re.I)}
        if len(lengths) > 1: raise ValueError('Conflicting reviewed skirt lengths need review')
        return {'Type':'Skirt', **({'Skirt Length':next(iter(lengths))} if lengths else {})}
    if kind.endswith('dress'):
        copy = ' '.join(str(item.get(field) or '') for field in ['title','description','itemType'])
        lengths = {value for word,value in [('mini','Short'),('short','Short'),('knee[\\s-]+length','Knee Length'),('midi','Midi'),('maxi','Long'),('long','Long')]
                   if re.search(r'\b'+word+r'[\s-]*dress\b',copy,re.I)}
        if len(lengths) > 1: raise ValueError('Conflicting reviewed dress lengths need review')
        return {'Type':'Dress', **({'Dress Length':next(iter(lengths))} if lengths else {})}
    return {'Type':item.get('itemType')}


def control(page, names, required=True):
    deadline = monotonic() + (15 if required else 0)
    while True:
        found = find_control(page, names)
        if found is not None: return found
        if monotonic() >= deadline: break
        (page.page if hasattr(page, 'page') else page).wait_for_timeout(100)
    if required: raise ValueError(f"eBay control not found: {names[0]}")
    return None


def find_control(page, names):
    for name in names:
        if name == 'Condition':
            condition = visible(page.locator('button#summary-condition-field-value[name="condition"]'))
            if len(condition) == 1: return condition[0]
        if name in {'Format','Listing format'}:
            values = visible(page.locator('button[aria-haspopup="listbox"]').filter(has_text=re.compile(r'^(Buy It Now|Auction)$')))
            if len(values) == 1: return values[0]
            if len(values) > 1: raise ValueError('eBay has multiple visible listing format controls')
        named = visible(page.locator('button[name=' + json.dumps('attributes.' + name) + ']'))
        if len(named) == 1: return named[0]
        if len(named) > 1: raise ValueError(f"eBay has multiple visible {name} controls")
        matches = visible(page.get_by_label(re.compile(r"^" + re.escape(name) + r"(?:\s*\*|\s*\(required\))?$", re.I)))
        if len(matches) == 1: return matches[0]
        if len(matches) > 1: raise ValueError(f"eBay has multiple visible {name} controls")
        # Essential specifics use a tooltip label referenced by aria-describedby,
        # rather than an accessible name on the actual value button.
        labels = visible(page.locator('.summary__attributes--label').get_by_role('button', name=name, exact=True))
        linked = []
        for label in labels:
            label_id = label.get_attribute('id')
            if label_id:
                linked.extend(visible(page.locator('button[aria-describedby~=' + json.dumps(label_id) + ']:not(.tooltip__host)')))
        if len(linked) == 1: return linked[0]
        if len(linked) > 1: raise ValueError(f"eBay has multiple visible {name} controls")
    return None


def click_choice(scope, labels, timeout=10000, trigger=None):
    deadline = monotonic() + timeout / 1000
    page = scope.page if hasattr(scope, 'page') else scope
    while monotonic() < deadline:
        if trigger is not None and trigger.get_attribute('aria-expanded') == 'false':
            trigger.click()
        for label in labels:
            pattern = re.compile('^' + re.escape(label).replace(r'\-', '[-–—]') + '$', re.I)
            for locator in [scope.get_by_role('option', name=pattern), scope.get_by_role('radio', name=pattern), scope.get_by_role('menuitemradio', name=pattern), scope.get_by_role('menuitemcheckbox', name=pattern), scope.get_by_role('button', name=pattern),
                            scope.get_by_role('link', name=pattern), scope.get_by_text(pattern)]:
                matches = visible(locator)
                if len(matches) == 1:
                    matches[0].click(); return label
                if len(matches) > 1: raise ValueError(f"eBay choice is ambiguous: {label}")
        page.wait_for_timeout(100)
    raise ValueError(f"eBay does not offer the reviewed choice: {labels[0]}")


def set_field(page, names, value, aliases=(), group=None):
    from playwright.sync_api import TimeoutError as BrowserTimeout
    for attempt in range(3):
        try:
            return _set_field_once(page, names, value, aliases, group)
        except (BrowserTimeout, AssertionError, ValueError) as error:
            if isinstance(error, ValueError) and not (
                    str(error) == f'eBay did not retain {names[0]}'
                    or str(error).startswith('eBay choice is ambiguous: ')):
                raise
            # eBay can replace an item-specific menu while photo suggestions
            # arrive. Reopen only that dropdown and still require one exact
            # reviewed choice; never redo uploads or publishing.
            field = control(page, names)
            if attempt == 2 or field.evaluate('e=>e.tagName') in {'INPUT', 'TEXTAREA', 'SELECT'}:
                raise
            field.press('Escape')
            page.wait_for_timeout(500)


def _set_field_once(page, names, value, aliases=(), group=None):
    from playwright.sync_api import expect
    field = control(page, names)
    choices = [str(value), *aliases]
    tag = field.evaluate('e=>e.tagName')
    if field.locator('button[aria-pressed]').count():
        pattern = re.compile('^(?:' + '|'.join(re.escape(choice) for choice in choices) + ')$', re.I)
        selected = field.get_by_role('button', name=pattern)
        expect(selected).to_have_count(1)
        if selected.get_attribute('aria-pressed') != 'true': selected.click()
        expect(selected).to_have_attribute('aria-pressed','true')
        expect(field.locator('button[aria-pressed="true"]')).to_have_count(1)
        return selected.inner_text().strip()
    if field.get_by_role('radio').count():
        pattern = re.compile('^(?:' + '|'.join(re.escape(choice) for choice in choices) + ')$', re.I)
        selected = field.get_by_role('radio', name=pattern)
        expect(selected).to_have_count(1)
        selected.check()
        expect(selected).to_be_checked()
        actual = field_value(field, names)
        if not any(norm(actual) == norm(choice) for choice in choices):
            raise ValueError(f"eBay did not retain {names[0]}")
        return actual
    if group and tag not in {'INPUT','TEXTAREA','SELECT'} and norm(field_value(field,names))==norm(f'{group} - {value}'):
        return str(value)
    if tag not in {'INPUT', 'TEXTAREA', 'SELECT'} and any(norm(field_value(field, names)) == norm(choice) for choice in choices):
        return field_value(field, names)
    if tag == 'SELECT':
        options = field.locator('option').evaluate_all('els=>els.map(e=>({text:e.textContent.trim(),value:e.value,disabled:e.disabled}))')
        matches = [option for option in options if not option['disabled'] and any(norm(option['text']) == norm(label) for label in choices)]
        if len(matches) != 1: raise ValueError(f"eBay has no unique {names[0]} choice for {value}")
        field.select_option(matches[0]['value'])
        expect(field).to_have_value(matches[0]['value'])
        return matches[0]['text']
    if tag in {'INPUT', 'TEXTAREA'}:
        if field.get_attribute('role') == 'combobox' or field.get_attribute('aria-autocomplete') == 'list':
            scope, _dialog = opened_choices(page, field, lambda: field.fill(str(value)), f'eBay {names[0]}')
            option = scope.get_by_role('option', name=re.compile('^(?:' + '|'.join(re.escape(x) for x in choices) + ')$', re.I))
            expect(option).to_have_count(1, timeout=15000)
            option.click()
        else:
            field.fill(str(value))
        field.press('Tab')
        expect(field).to_have_value(re.compile('^(?:' + '|'.join(re.escape(x) for x in choices) + ')$', re.I))
        return field.input_value()
    native_menu = field.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," fake-menu-button ")][1]').locator(':scope > .fake-menu-button__menu')
    # Photo suggestions can rebuild item specifics and replace generated IDs.
    # Follow the stable value control's menu through that rebuild.
    scope, dialog = opened_choices(page, field, field.click, f'eBay {names[0]}', native_menu)
    search = visible(scope.get_by_role('textbox', name=re.compile(r'^Search')))
    # Native material menus are multi-select and may contain photo suggestions.
    # Clear their committed selections before narrowing the search, including
    # suggestions that would disappear from the filtered options.
    if scope.get_by_role('menuitemcheckbox').count():
        if len(search) == 1: search[0].fill('')
        checked = scope.get_by_role('menuitemcheckbox', checked=True)
        for _ in range(checked.count()):
            selected_choices = visible(checked)
            if not selected_choices: break
            choice = selected_choices[0]
            label = choice.inner_text().strip()
            choice.click()
            expect(scope.get_by_role('menuitemcheckbox', name=label, exact=True)).not_to_be_checked()
    if len(search) == 1 and not group: search[0].fill(str(value))
    if group:
        details = scope.locator('details').filter(has=page.locator('summary').filter(has_text=re.compile('^' + re.escape(group) + '$')))
        expect(details).to_have_count(1, timeout=15000)
        if details.get_attribute('open') is None: details.locator('summary').click()
        scope = details
    selected = click_choice(scope, choices, trigger=field if field.get_attribute('aria-controls') or native_menu.count() == 1 else None)
    if dialog is not None:
        done = dialog.get_by_role('button', name='Done', exact=True)
        if len(visible(done)) == 1: done.click()
    field = control(page, names)
    expected = f'{group} - {selected}' if group else selected
    if norm(field_value(field, names)) != norm(expected): raise ValueError(f"eBay did not retain {names[0]}")
    if field.get_attribute('aria-expanded') == 'true':
        field.press('Escape')
        if field.get_attribute('aria-expanded') == 'true': field.click()
        expect(field).to_have_attribute('aria-expanded', 'false')
    return selected


def field_value(field, names):
    tag = field.evaluate('e=>e.tagName')
    if field.locator('button[aria-pressed]').count():
        selected = field.locator('button[aria-pressed="true"]')
        return selected.inner_text().strip() if selected.count() == 1 else ''
    if field.get_by_role('radio').count():
        checked = field.get_by_role('radio', checked=True)
        if checked.count() != 1: return ''
        return checked.evaluate('''e=>e.getAttribute('aria-label') ||
          (e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim() ||
          [...(e.labels||[])].map(label=>label.textContent.trim()).join(' ') || (e.textContent||'').trim()''')
    if tag == 'SELECT': return field.locator('option:checked').inner_text().strip()
    if tag in {'INPUT', 'TEXTAREA'}: return field.input_value()
    value = field.get_attribute('aria-valuetext')
    if value is not None: return value
    value = field.inner_text().strip()
    for name in names: value = re.sub(r'^' + re.escape(name) + r'[:\s]*', '', value, flags=re.I)
    return value.strip()


def section(page, name):
    names=[name,'Item category'] if name.lower()=='category' else [name]
    heading = page.get_by_role('heading', name=re.compile('^(?:' + '|'.join(re.escape(value) for value in names) + ')$', re.I))
    if len(visible(heading)) == 1:
        for xpath in ['xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," smry ")][1]', 'xpath=ancestor::section[1]', 'xpath=ancestor::*[@role="region"][1]', 'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," section ")][1]']:
            found = heading.locator(xpath)
            if found.count() == 1: return found
    raise ValueError(f"eBay section not found: {name}")


def prelisting_category(page, item):
    from playwright.sync_api import expect
    dialogs = visible(page.get_by_role('dialog').filter(
        has=page.get_by_placeholder('Enter a category value', exact=True)))
    if not dialogs:
        return False
    if len(dialogs) != 1:
        raise ValueError('eBay prelisting category dialog is ambiguous')
    # The search input disappears after entering a category branch. Do not keep
    # filtering the live dialog by that initial input while traversing children.
    dialog = page.get_by_role('dialog').filter(visible=True)
    expect(dialog).to_have_count(1)
    path = category_for(item)
    suggested = visible(dialog.get_by_text(' > '.join(path), exact=True))
    if len(suggested) > 1:
        raise ValueError('eBay suggested category is ambiguous')
    if suggested:
        suggested[0].click()
    else:
        for part in path:
            click_choice(dialog, [part])
    if dialog.is_visible():
        click_choice(dialog, ['Done'])
    expect(dialog).not_to_be_visible()
    return True


def open_form(page, item):
    from playwright.sync_api import TimeoutError as BrowserTimeout
    page.set_default_timeout(20000)
    deadline=monotonic()+90
    while monotonic()<deadline:
        location = urlsplit(page.url)
        if 'signin' in (location.hostname or '') or '/signin' in location.path:
            raise ValueError("Sign into eBay Seller Hub in your normal Chrome, then retry")
        if '/splashui/' in location.path or 'captcha' in location.path:
            raise ValueError('Complete the eBay account verification in Chrome before retrying')
        if control(page, ['Title', 'Item title'], required=False): return
        if prelisting_category(page, item):
            page.wait_for_timeout(700);continue
        if location.path.rstrip('/') == '/lstng':
            page.wait_for_timeout(300)
            continue
        if location.path.rstrip('/') == '/sh/lst/active':
            choices=visible(page.get_by_role('link',name='Create listing',exact=True))
            if len(choices)>1:raise ValueError('eBay has multiple visible Create listing links')
            if len(choices)==1:
                target=urlsplit(urljoin(page.url,choices[0].get_attribute('href') or ''))
                if target.scheme!='https' or target.hostname!='www.ebay.com' or target.path!='/sl/sell' or target.port or target.username or target.password:
                    raise ValueError('eBay Create listing link is not the expected selling entry')
                choices[0].click();page.wait_for_timeout(700);continue
        if location.path.rstrip('/') == '/sl/sell':
            launch = page.get_by_role('button', name='Sell now', exact=True).or_(page.get_by_role('link', name='Sell now', exact=True))
            choices = visible(launch)
            if len(choices) == 1:
                choices[0].click(); page.wait_for_timeout(700); continue
        native_start=control(page,['Enter brand, model, description, etc.'],required=False)
        if native_start:
            try:
                native_start.fill(title_for(item['title']), timeout=3000)
                native_start.press('Enter', timeout=3000)
            except BrowserTimeout:
                # This initial search can navigate before filling or pressing
                # Enter has finished. If the
                # input is gone, inspect the next guided screen instead of
                # treating navigation as a failed listing. Publish is much later.
                if control(page,['Enter brand, model, description, etc.'],required=False):
                    raise
            page.wait_for_timeout(700);continue
        start = control(page, ['Tell us what you’re selling', "Tell us what you're selling", 'What are you selling?', 'Enter a title or product name'], required=False)
        if start:
            start.fill(title_for(item['title']))
            click_choice(page, ['Get started', 'Search'])
        elif (next_choices := visible(page.get_by_role('button', name=re.compile(r'^Continue without (?:a )?match$', re.I)))):
            if len(next_choices) != 1: raise ValueError('eBay continuation control is ambiguous')
            if not next_choices[0].is_enabled():
                # The category dialog can arrive after this loop's first check.
                # Reinspect it rather than waiting on a disabled background button.
                page.wait_for_timeout(300)
                continue
            next_choices[0].click()
        elif visible(page.get_by_role('heading', name=re.compile('condition', re.I))):
            # Some guided matches ask only New/Used before the full editor.
            # The reviewed grade is still applied after category correction.
            broad='New' if item['condition'] in {'New with tags','New without tags'} else 'Used'
            click_choice(page, [*CONDITIONS[item['condition']],broad])
            click_choice(page, ['Continue to listing','Continue'])
        else:
            page.wait_for_timeout(1000)
            continue
        page.wait_for_timeout(700)
    raise BrowserTimeout("eBay listing editor did not finish loading")


def fill_category(page, item):
    from playwright.sync_api import expect
    path = category_for(item)
    group = section(page, 'Category')
    summary=' '.join(group.inner_text().split())
    if all(re.search(r'(?<!\w)'+re.escape(part)+r'(?!\w)',summary,re.I) for part in path): return path
    click_choice(group, ['Edit category', 'Change category', 'Edit'])
    dialog = page.get_by_role('dialog')
    expect(dialog).to_have_count(1)
    primary=dialog.get_by_role('button',name=re.compile(r'^First category\b',re.I))
    if primary.count()==1:primary.click()
    selected=dialog.get_by_text('Selected',exact=True)
    if selected.count()==1 and selected.is_visible():
        # Existing-category breadcrumbs navigate to the parent picker. First
        # return to All categories, then select the actual root category row.
        breadcrumbs = visible(dialog.locator('.category-picker__selected-nodes'))
        if len(breadcrumbs) > 1:
            raise ValueError('eBay selected category breadcrumbs are ambiguous')
        click_choice(breadcrumbs[0] if breadcrumbs else dialog,[path[0]])
        expect(selected).not_to_be_visible(timeout=10000)
    for part in path: click_choice(dialog, [part])
    for label in ['Done', 'Save', 'Apply']:
        button = dialog.get_by_role('button', name=label, exact=True)
        if len(visible(button)) == 1:
            button.click(); break
    expect(group).to_contain_text(path[1])
    expect(group).to_contain_text(path[-1])
    return path


def description_field(page):
    direct = control(page, ['Description', 'Item description'], required=False)
    if direct:
        tag = direct.evaluate('e=>e.tagName')
        if tag in {'INPUT','TEXTAREA'}: return direct, True
        if tag == 'IFRAME': return direct.content_frame.locator('[contenteditable="true"]'), False
        if direct.evaluate('e=>e.isContentEditable'): return direct, False
    selector = 'iframe[title*="description" i]:visible,iframe[title*="rich text" i]:visible'
    frame = page.locator(selector)
    if frame.count() != 1: raise ValueError("eBay description editor could not be identified")
    return page.frame_locator(selector).locator('[contenteditable="true"]'), False


def fill_description(page, description):
    from playwright.sync_api import expect
    editor, input_value = description_field(page)
    expect(editor).to_have_count(1)
    editor.fill(description)
    if input_value: expect(editor).to_have_value(description)
    else: expect(editor).to_have_text(description, use_inner_text=True)


def fixed_price(page):
    from playwright.sync_api import expect
    field = control(page, ['Format', 'Listing format'], required=False)
    if field:
        set_field(page, ['Format', 'Listing format'], 'Fixed price', ['Buy It Now'])
        return
    auction = page.get_by_role('switch', name='Auction', exact=True)
    if not visible(auction): auction = page.get_by_role('checkbox', name='Auction', exact=True)
    if len(visible(auction)) != 1: raise ValueError("eBay fixed-price format cannot be verified")
    if auction.is_checked(): auction.press('Space')
    expect(auction).not_to_be_checked()


def fill_policy(page, labels, desired=None, required=True):
    from playwright.sync_api import expect
    field = control(page, labels, required=required)
    if field is None: return None
    if field.get_attribute('role') == 'combobox':
        if not desired and field.input_value().strip(): return field.input_value()
        field.click()
        popup_id = field.get_attribute('aria-controls')
        if not popup_id: raise ValueError(f'eBay {labels[0]} options could not be identified')
        popup = page.locator('[id=' + json.dumps(popup_id) + ']')
        expect(popup).to_be_visible()
        candidates = visible(popup.get_by_role('option'))
        # A blank policy can use the sole existing account policy. Multiple
        # policies require an explicit configured name; never select by order.
        if desired:
            candidates = [choice for choice in candidates if norm(re.sub(r'\s*[\[(]\d+ listings?[\])]$', '', choice.inner_text().strip())) == norm(desired)]
        if len(candidates) != 1: raise ValueError(f'Choose an existing eBay {labels[0].lower()} in Settings')
        candidates[0].click()
        value = field.input_value().strip()
        if not value: raise ValueError(f'eBay {labels[0]} was not retained')
        return value
    if desired: set_field(page, labels, desired)
    value = field_value(field, labels).strip()
    if not value or norm(value) in {'select','selectpolicy','none','chooseapolicy'}: raise ValueError(f'Choose an existing eBay {labels[0].lower()}')
    return value


@contextmanager
def policy_settings(page, label):
    from playwright.sync_api import expect
    dialog = None
    if label == 'Return policy' and control(page, [label], required=False) is None:
        edit = page.get_by_role('button', name='Your settings - edit', exact=True)
        if len(visible(edit)) == 1:
            edit.click()
            dialog = page.get_by_role('dialog')
            expect(dialog).to_have_count(1)
            expect(dialog).to_contain_text('Your settings')
    try:
        yield
    finally:
        if dialog is not None:
            dialog.get_by_role('button', name='Done', exact=True).click()
            expect(dialog).not_to_be_visible()


def expand_specifics(page):
    more = visible(page.locator('.summary__attributes--container').get_by_role(
        'button', name=re.compile(r'^Show more$', re.I)))
    if len(more) > 1: raise ValueError('eBay item-specific expansion control is ambiguous')
    if more and more[0].get_attribute('aria-expanded') == 'false':
        more[0].click()


def package_fields(page, item, weight_only=False):
    weight = item.get('weightOz')
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
        raise ValueError("eBay needs a positive package weight")
    pounds = control(page, ['Pounds', 'lbs', 'Package weight (lbs.)', 'Enter weight in pounds'], required=False)
    ounces = control(page, ['Ounces', 'oz', 'Package weight (oz.)', 'Enter weight in ounces'], required=False)
    total = Decimal(str(weight))
    major, minor = divmod(total, Decimal(16))
    # A pounds-only editor must retain the remainder as fractional pounds.
    # If its control rejects that value, stop rather than guessing a rounding rule.
    fields = {}
    for key, field, value in [('pounds', pounds, major if ounces else total / Decimal(16)),
                              ('ounces', ounces, minor if pounds else total)]:
        if field is not None: fields[key] = (field, format(value.normalize(), 'f'))
    if weight_only: return fields
    try: shipping_scope = section(page, 'Shipping')
    except ValueError: shipping_scope = None
    for key in ['length', 'width', 'height']:
        names = [f'Package {key}', key.title()] if shipping_scope else [f'Package {key}']
        names.append(f'Enter package {"depth" if key == "height" else key} in inches')
        field = control(shipping_scope or page, names, required=False)
        if field is not None:
            value = item.get('packageDims', {}).get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("eBay package dimensions need review")
            fields[key] = (field, format(Decimal(str(value)).normalize(), 'f'))
    return fields


def verify_package_fields(page, item, expected):
    fields = package_fields(page, item)
    if {key: value for key, (_, value) in fields.items()} != expected:
        raise ValueError('eBay package controls or reviewed values changed before publication')
    for key, (field, value) in fields.items():
        if field.evaluate("e=>e.getAttribute('aria-invalid')==='true'||(e.validity&&!e.validity.valid)"):
            raise ValueError(f'eBay rejected package {key}; review before publication')
        try: actual = Decimal(field.input_value().strip())
        except InvalidOperation:
            raise ValueError(f'eBay package {key} could not be verified before publication') from None
        if not actual.is_finite() or actual != Decimal(value):
            raise ValueError(f'eBay package {key} changed before publication')


def fill_listing_fields(page, item, options):
    from playwright.sync_api import expect
    if type(item.get('quantity')) is not int or item['quantity'] != 1: raise ValueError("eBay direct posting uses one item per listing")
    if item.get('condition') not in CONDITIONS: raise ValueError("eBay condition needs review")
    if not isinstance(item.get('brand'), str) or not item['brand'].strip() or item['brand'] == 'Unknown': raise ValueError("eBay needs a reviewed brand")
    if isinstance(item.get('price'), bool) or not isinstance(item.get('price'), (int,float)) or not math.isfinite(item['price']) or item['price'] <= 0:
        raise ValueError("eBay needs a positive reviewed price")
    keep_work_page_ready(page)
    category = fill_category(page, item)
    inseam = reviewed_inseam(item, category)
    shell_material = reviewed_outer_shell_material(item, category)
    title = title_for(item['title'])
    set_field(page, ['Title', 'Item title'], title)
    sku = control(page, ['Custom label (SKU)', 'Custom label', 'SKU'], required=False)
    # Some seller editors omit native SKU entirely. The durable item/listing-ID
    # relationship still identifies the piece; never add SKU to buyer-facing copy.
    if sku:set_field(page, ['Custom label (SKU)', 'Custom label', 'SKU'], item['sku'])
    kind = norm(item.get('itemType'))
    accessory = kind in {'bag','handbag','purse','backpack','shoulderbag','duffelbag','hat','cap','beanie','belt','scarf'}
    if control(page, ['Brand'], required=False) is None:
        expand_specifics(page)
    selected = {'Brand': set_field(page, ['Brand'], item['brand'])}
    if not accessory or control(page, ['Department'], required=False):
        department = listing_department(item)
        selected['Department'] = set_field(page, ['Department'], department, ['Unisex'] if department == 'Unisex Adults' else [])
    size, size_type = size_and_type(item, category)
    if (not accessory and not size) or not item.get('color'): raise ValueError("eBay requires reviewed size and color")
    has_size = control(page, ['Size', 'US Shoe Size'], required=not accessory)
    combined_size = bool(category[1] != 'Kids' and has_size and has_size.get_attribute('name') == 'attributes.Size'
                         and has_size.evaluate('e=>e.tagName') not in {'SELECT','INPUT','TEXTAREA'}
                         and control(page,['Size Type','Size type'],required=False) is None)
    generated_bag_size = kind in {'bag','handbag','purse','backpack','shoulderbag','duffelbag'} and norm(size) == 'onesize'
    if not generated_bag_size and (not accessory or has_size):
        aliases = [str(item['size'])] if str(item['size']) != size else []
        if norm(size) in {'xxl','xxlarge'}: aliases.append('2XL')
        if size_type == 'Petites' and "Women's Clothing" in category:
            petite_label = {'xxs':'P2XS','xs':'PXS','s':'PS','m':'PM','l':'PL','xl':'PXL','xxl':'P2XL','2xl':'P2XL'}.get(norm(size))
            if petite_label: aliases.append(petite_label)
        selected['Size'] = set_field(page, ['Size', 'US Shoe Size'], size, aliases, group=size_type if combined_size else None)
        if combined_size: selected['Size Type'] = size_type
    selected['Color'] = set_field(page, ['Color', 'Colour', 'Exterior Color'], item['color'])
    if inseam:
        selected['Inseam'] = set_field(page, ['Inseam'], inseam, [inseam.removesuffix(' in')])
    if shell_material:
        selected['Outer Shell Material'] = set_field(page, ['Outer Shell Material'], shell_material)
    for label, value in [*type_specifics(item).items(),('Material',item.get('material')),('Style',item.get('style')),
                         ('Pattern',item.get('pattern')),('Fit',item.get('fit')),('Country/Region of Manufacture',item.get('countryOfOrigin'))]:
        if label=='Material' and shell_material:continue
        names = [label, 'Exterior Material'] if label == 'Material' else [label,'Country of Origin'] if label == 'Country/Region of Manufacture' else [label]
        if value and (label in {'Sleeve Length','Skirt Length','Dress Length'} or control(page, names, required=False)): selected[label] = set_field(page, names, value)
    if control(page, ['Size Type', 'Size type'], required=False):
        selected['Size Type'] = set_field(page, ['Size Type', 'Size type'], size_type)
    condition = set_field(page, ['Condition'], CONDITIONS[item['condition']][0], CONDITIONS[item['condition']][1:])
    fill_description(page, item['description'])
    fixed_price(page)
    set_field(page, ['Buy It Now price', 'Buy it now price', 'Item price', 'Price'], f"{item['price']:.2f}")
    set_field(page, ['Quantity'], '1')
    policies = {}
    for setting, labels in [('shippingPolicyName',['Shipping policy']),('returnPolicyName',['Return policy']),('paymentPolicyName',['Payment policy'])]:
        with policy_settings(page, labels[0]):
            value = fill_policy(page, labels, options.get(setting), required=setting != 'paymentPolicyName' or bool(options.get(setting)))
        if value is not None: policies[labels[0]] = value
    package = package_fields(page, item, weight_only=True)
    for field, text in package.values():
        field.fill(text); expect(field).to_have_value(text)
    # Preserve dimension discovery after weight entry, which can reveal them.
    package = package_fields(page, item)
    for key, (field, text) in package.items():
        if key not in {'pounds', 'ounces'}:
            field.fill(text); expect(field).to_have_value(text)
    from .ebay_promotion import configure_promotion
    promotion_rate = options.get('generalAdRate')
    configure_promotion(page, promotion_rate)
    for label in ['Gallery Plus', 'Schedule listing', 'Schedule your listing', 'Allow offers',
                  'Automatically accept offers', 'Automatically send offers', 'Automatically lower price']:
        for role in ['checkbox', 'switch']:
            fields = visible(page.get_by_role(role, name=label, exact=True))
            if len(fields) > 1: raise ValueError(f"eBay has ambiguous {label} controls")
            if fields:
                if fields[0].is_checked(): fields[0].press('Space')
                expect(fields[0]).not_to_be_checked()
    return {'title': title, 'category': category, 'specifics': selected, 'price': item['price'], 'condition': condition, 'policies': policies,'skuWritten':sku is not None,'combinedSize':combined_size,'promotionAdRate':promotion_rate,
            'packageValues': {key: text for key, (_, text) in package.items()}}


def verify_required_specifics(page):
    rows=page.locator('.summary__attributes--field').filter(has=page.locator('.summary__attributes--label.required-field'))
    missing=[]
    for row in visible(rows):
        fields=visible(row.locator('.summary__attributes--value [name^="attributes."]'))
        label=row.locator('.summary__attributes--label.required-field').inner_text().strip().split('\n')[0]
        if not fields:
            linked = find_control(row, [label])
            if linked is not None: fields = [linked]
        if len(fields)!=1:
            raise ValueError(f'eBay required item specific could not be identified: {label}')
        value=field_value(fields[0],[label])
        if norm(value) in {'','select','selectone','selectanoption'} or fields[0].get_attribute('aria-invalid')=='true':
            missing.append(label)
    if missing:raise ValueError('eBay still requires item specifics: '+', '.join(missing))


def verify_listing_fields(page, item, filled):
    from playwright.sync_api import expect
    from .ebay_promotion import configure_promotion
    configure_promotion(page, filled.get('promotionAdRate'), verify_only=True)
    shell_material = reviewed_outer_shell_material(item, filled['category'])
    if shell_material and norm(field_value(control(page,['Outer Shell Material']),['Outer Shell Material'])) != norm(shell_material):
        raise ValueError('eBay outer shell material changed before publication')
    inseam = reviewed_inseam(item, filled['category'])
    if inseam:
        actual = field_value(control(page, ['Inseam']), ['Inseam'])
        if reviewed_inseam({'inseam': actual}, filled['category']) != inseam:
            raise ValueError('eBay inseam changed before publication')
    expect(control(page, ['Title', 'Item title'])).to_have_value(filled['title'])
    if filled.get('skuWritten',True):expect(control(page, ['Custom label (SKU)', 'Custom label', 'SKU'])).to_have_value(item['sku'])
    description, input_value = description_field(page)
    if input_value: expect(description).to_have_value(item['description'])
    else: expect(description).to_have_text(item['description'], use_inner_text=True)
    for label, value in filled['specifics'].items():
        if filled.get('combinedSize') and label in {'Size','Size Type'}:
            expected = filled['specifics']['Size Type'] + ' - ' + filled['specifics']['Size']
            if norm(field_value(control(page,['Size']),['Size'])) != norm(expected): raise ValueError('eBay size or size type changed before publication')
            continue
        names = [label, 'US Shoe Size'] if label == 'Size' else [label, 'Colour', 'Exterior Color'] if label == 'Color' else [label, 'Exterior Material'] if label == 'Material' else [label,'Country of Origin'] if label == 'Country/Region of Manufacture' else [label]
        if norm(field_value(control(page, names), names)) != norm(value): raise ValueError(f"eBay {label} changed before publication")
    if filled['category'][-1] in {'Skirts','Dresses'}:
        label = 'Skirt Length' if filled['category'][-1] == 'Skirts' else 'Dress Length'
        length = field_value(control(page,[label]),[label])
        if norm(length) in {'','select','select'+norm(label)}: raise ValueError(f'eBay {label} needs review before publication')
    if norm(field_value(control(page, ['Condition']), ['Condition'])) != norm(filled['condition']): raise ValueError('eBay condition changed before publication')
    for label, value in filled['policies'].items():
        with policy_settings(page, label):
            if field_value(control(page, [label]), [label]) != value: raise ValueError(f'eBay {label} changed before publication')
    format_field = control(page, ['Format', 'Listing format'], required=False)
    if format_field:
        if norm(field_value(format_field, ['Format', 'Listing format'])) not in {'fixedprice', 'buyitnow'}: raise ValueError('eBay format changed before publication')
    else:
        auction = page.get_by_role('switch', name='Auction', exact=True)
        if not visible(auction): auction = page.get_by_role('checkbox', name='Auction', exact=True)
        expect(auction).not_to_be_checked()
    group = section(page, 'Category')
    expect(group).to_contain_text(filled['category'][1]); expect(group).to_contain_text(filled['category'][-1])
    price = control(page, ['Buy It Now price', 'Buy it now price', 'Item price', 'Price']).input_value()
    if float(price.replace(',', '').replace('$','')) != item['price']: raise ValueError("eBay price changed before publication")
    expect(control(page, ['Quantity'])).to_have_value('1')
    verify_package_fields(page, item, filled['packageValues'])
    missing = page.locator('main input:visible,main textarea:visible,main select:visible').evaluate_all("""els=>els.filter(e=>
      !e.disabled && ((e.required && !e.validity.valid) || (e.getAttribute('aria-required')==='true'&&!e.value)))
      .map(e=>e.getAttribute('aria-label')||[...e.labels||[]].map(l=>l.textContent.trim()).join(' ')||e.name||'required field')""")
    if missing: raise ValueError('eBay still requires: ' + ', '.join(missing[:8]))
    verify_required_specifics(page)


def image_key(value):
    try:
        url = urlsplit(value)
        match = re.search(r'^/images/g/([^/]+)/', url.path) or re.search(r'^/00/s/[^/]+/z/([^/]+)/', url.path)
        return match[1] if url.scheme == 'https' and url.hostname == 'i.ebayimg.com' and match else None
    except (TypeError, ValueError): return None


def attach_photos(page, photos):
    from playwright.sync_api import TimeoutError as BrowserTimeout
    if not 1 <= len(photos) <= 24 or any(not Path(photo).is_file() for photo in photos): raise ValueError("eBay needs 1 to 24 reviewed photo files")
    gallery = section(page, 'Photos & video')
    def keys():
        sources = gallery.locator('img,button.uploader-thumbnails-ux__image').evaluate_all("""els=>els.flatMap(e=>{
          if(e.tagName==='IMG')return e.complete&&e.naturalWidth>0?[e.currentSrc||e.src]:[];
          const match=getComputedStyle(e).backgroundImage.match(/^url\\(["']?(.*?)["']?\\)$/);
          return match?[match[1]]:[];
        })""")
        return list(dict.fromkeys(key for value in sources if (key := image_key(value))))
    if keys(): raise ValueError("eBay already contains photos; refusing to mix listings")
    ordered = []
    for index, photo in enumerate(photos):
        upload = gallery.locator('input[type="file"][accept*="image"],input[type="file"][accept*=".jpg"],input[type="file"][accept*=".png"]')
        if upload.count() == 0: upload = page.locator('input#fehelix-uploader[type="file"][accept*="image"]')
        if upload.count() == 0: upload = gallery.locator('input[type="file"]')
        if upload.count() != 1: raise ValueError("eBay photo uploader could not be identified")
        # Complete each file before the next so asynchronous uploads cannot
        # choose a different cover. A timeout is inspected, never re-uploaded.
        try: upload.set_input_files([photo], timeout=120000)
        except BrowserTimeout: pass
        keep_work_page_ready(page); gallery.scroll_into_view_if_needed()
        deadline = monotonic() + 90
        while monotonic() < deadline:
            uploaded = keys()
            if len(uploaded) > index + 1: raise ValueError("eBay contains unexpected extra photos")
            if len(uploaded) == index + 1:
                if uploaded[:index] != ordered: raise ValueError("eBay changed the reviewed photo order")
                ordered = uploaded
                break
            page.wait_for_timeout(250)
        else: raise ValueError("eBay photo upload could not be verified; no second upload was attempted")
    return ordered
