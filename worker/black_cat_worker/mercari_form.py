"""Mercari's native form. No publish, discount or shipping-label purchase here."""
import math
import re
from pathlib import Path
from urllib.parse import urlsplit

CREATE_URL = 'https://www.mercari.com/sell/'
INVENTORY_URL = 'https://www.mercari.com/mypage/listings/active/'
CONDITIONS = {'New with tags':'New','New without tags':'Like new','Like new':'Like new',
              'Good':'Good','Pre-owned':'Good','Fair':'Fair'}


def norm(value): return re.sub(r'[^a-z0-9]', '', str(value or '').casefold())
def exact(value): return re.compile(r'^\s*'+re.escape(str(value))+r'\s*$', re.I)


def size_pattern(value):
    labels={'xs':['XS','Extra small'],'s':['S','Small'],'m':['M','Medium'],'l':['L','Large'],
            'xl':['XL','Extra large'],'xxl':['XXL','2XL','XX Large'],'onesize':['One size','OS']}
    key={'small':'s','medium':'m','large':'l','extralarge':'xl','extrasmall':'xs'}.get(norm(value),norm(value))
    unit = r'(?:\s*in\.?)?' if re.fullmatch(r'\d{2}', str(value).strip()) else ''
    return re.compile(r'^\s*(?:'+'|'.join(re.escape(label) for label in labels.get(key,[str(value)]))+r')'+unit+r'(?:\s*\([^)]*\))?\s*$',re.I)


def listing_id(value):
    if not isinstance(value,str): return None
    try:
        url=urlsplit(value);match=re.fullmatch(r'/us/item/(m\d{9,15})/?',url.path)
        return match[1] if match and url.scheme=='https' and url.hostname in {'www.mercari.com','mercari.com'} and not url.port and not url.username and not url.password else None
    except ValueError:return None


def photo_key(value):
    try:
        url=urlsplit(value)
        if url.scheme=='https' and (url.hostname or '').endswith('.mercdn.net'):
            return url.path
    except (ValueError,TypeError):pass
    return None


def category_path(item,unisex):
    department=norm(item.get('department'))
    if department in {'unisex','unisexadult','unisexadults'}:department=norm(unisex)
    if department in {'men','mens','male','menswear'}:department='Men'
    elif department in {'women','womens','female','womenswear'}:department='Women'
    else:raise ValueError('Mercari needs a reviewed adult department')
    kind=norm(item.get('itemType'))
    tops='Tops' if department=='Men' else 'Tops & blouses'
    if department=='Women' and kind.endswith(('hoodie','sweatshirt')):
        return ['Women','Athletic apparel','Athletic Hoodies' if kind.endswith('hoodie') else 'Athletic Sweatshirts']
    if department=='Women' and kind.endswith('dress'):
        lengths={'mini':'Above knee, mini','abovekneemini':'Above knee, mini','kneelength':'Knee-length',
                 'midi':'Midi','maxi':'Maxi','highlow':'High Low'}
        return ['Women','Dresses',lengths.get(norm(item.get('style')),'Other')]
    accessories = "Men's accessories" if department == 'Men' else "Women's accessories"
    if kind == 'belt': return [department, accessories, 'Belts']
    if kind in {'bag','handbag','purse','shoulderbag','duffelbag','backpack'}:
        if department == 'Women':
            leaf = {'shoulderbag':'Shoulder Bags','backpack':'Backpacks'}.get(kind,'Other')
            return ['Women',"Women's handbags",leaf]
        return ['Men',accessories,'Backpacks' if kind=='backpack' else 'Bags']
    if department == 'Women' and kind in {'skirt','pants','trousers','jeans'}:
        if kind == 'skirt':
            parent='Skirts';labels=['A-line','Asymmetrical','Bubble','Full skirt','Maxi','Mini','Peasant','Pleated','Straight, pencil','Tiered','Wrap']
            aliases={'pencil':'Straight, pencil','straight':'Straight, pencil'}
        elif kind == 'jeans':
            parent='Jeans';labels=['Boot cut','Boyfriend','Cargo','Flare','Leggings','Overalls','Relaxed','Straight leg','Wide leg','Capri Jeans','Cropped Jeans','Skinny Jeans','Slim Jeans']
            aliases={'straight':'Straight leg','skinny':'Skinny Jeans','slim':'Slim Jeans','capri':'Capri Jeans','cropped':'Cropped Jeans'}
        else:
            parent='Pants';labels=['Cargo','Casual pants','Corduroys','Dress pants','Khakis, chinos','Leather','Linen','Capri Pants','Cropped Pants']
            aliases={'corduroy':'Corduroys','chino':'Khakis, chinos','khaki':'Khakis, chinos','capri':'Capri Pants','cropped':'Cropped Pants'}
        choices={**{norm(label):label for label in labels},**aliases}
        leaf=next((choices[value] for value in [norm(item.get('style')),norm(item.get('fit'))] if value in choices),'Other')
        return [department,parent,leaf]
    if kind.endswith('shorts'):
        style=norm(item.get('style'))
        if 'board' in style or 'board' in kind or 'surf' in style:
            leaf='Board, surf' if department=='Men' else 'Other'
        elif 'denim' in style:leaf='Denim'
        elif 'cargo' in style:leaf='Cargo'
        elif 'chino' in style or 'khaki' in style:leaf='Khakis, chinos' if department=='Men' else 'Chino & khaki'
        elif 'casual' in style:leaf='Casual shorts' if department=='Men' else 'Other'
        else:leaf='Other'
        return [department,'Shorts',leaf]
    if department=='Women' and kind in {'bra','bralette'}:
        return ['Women','Underwear','Bras']
    mappings={
        'sweatshirt':['Sweaters','Sweatshirts'] if department=='Men' else ['Sweaters','Crewneck'],
        'hoodie':['Sweaters','Hoodies'], 'sweatervest':['Sweaters','Vests'],
        'tshirt':[tops,'T-shirts'], 'tee':[tops,'T-shirts'], 'tanktop':[tops,'Tank tops'], 'tank':[tops,'Tank tops'],
        'tubetop':[tops,'Tank tops'], 'top':[tops,'Other'],
        'buttondown':[tops,'Button-front'], 'buttonup':[tops,'Button-front'], 'shirt':[tops,'Button-front'],
        'blouse':[tops,'Blouses'], 'polo':[tops,'Polo'], 'poloshirt':[tops,'Polo'], 'cardigan':['Sweaters','Cardigan'],
        'sweater':['Sweaters','Crewneck'], 'pullover':['Sweaters','Crewneck'],
        'jeans':['Jeans'], 'pants':['Pants'], 'trousers':['Pants'], 'shorts':['Shorts'],
        'coat':['Coats & jackets','Other'], 'jacket':['Coats & jackets','Other'],
        'dress':['Dresses'], 'skirt':['Skirts'], 'handbag':['Handbags'], 'bag':['Bags'],
        'hat':[accessories,'Hats'], 'cap':[accessories,'Hats'], 'belt':[accessories,'Belts'],
        'sneakers':['Shoes','Athletic'], 'boots':['Shoes','Boots'], 'sandals':['Shoes','Sandals'],
    }
    if department=='Women':
        mappings.update({'camisole':[tops,'Camisoles'],'cami':[tops,'Camisoles']})
    for key in sorted(mappings,key=len,reverse=True):
        if kind.endswith(key):return [department,*mappings[key]]
    raise ValueError('This item needs a Mercari category mapping')


def field(scope,names,required=True):
    for name in names:
        locator=scope.get_by_label(re.compile(r'^'+re.escape(name)+r'(?:\s*\*|\s*\(required\))?$',re.I))
        visible=[locator.nth(i) for i in range(locator.count()) if locator.nth(i).is_visible()]
        if len(visible)==1:return visible[0]
        if len(visible)>1:raise ValueError(f'Mercari {name} control is ambiguous')
    if required:raise ValueError('Mercari control is missing: '+names[0])
    return None


def choose(scope,value,size=False):
    from playwright.sync_api import expect
    pattern=size_pattern(value) if size else exact(value)
    option=scope.get_by_role('option',name=pattern).or_(scope.get_by_role('button',name=pattern)).or_(scope.get_by_role('radio',name=pattern)).or_(scope.get_by_role('menuitem',name=pattern))
    option=option.filter(visible=True)
    expect(option).to_have_count(1,timeout=10000)
    option.click()


def value_of(control):
    return control.evaluate("e=>e.tagName==='SELECT'?e.selectedOptions[0]?.textContent?.trim():(['INPUT','TEXTAREA'].includes(e.tagName)?e.value:(e.getAttribute('aria-valuetext')||e.innerText||'').trim())")


def set_value(scope,names,value):
    from playwright.sync_api import expect
    from .choice_scope import opened_choices
    control=field(scope,names)
    is_size=names==['Size']
    tag=control.evaluate('e=>e.tagName')
    if tag=='SELECT':
        options=control.locator('option').evaluate_all('els=>els.filter(e=>!e.disabled).map(e=>({text:e.textContent.trim(),value:e.value}))')
        matches=[option for option in options if size_pattern(value).fullmatch(option['text'])] if is_size else [option for option in options if norm(option['text'])==norm(value)]
        if len(matches)!=1:raise ValueError(f'Mercari does not offer the reviewed {names[0]}: {value}')
        control.select_option(matches[0]['value'])
    elif tag in {'INPUT','TEXTAREA'}:
        maximum=control.get_attribute('maxlength')
        if maximum and int(maximum)>=0 and len(str(value))>int(maximum):raise ValueError(f'Mercari {names[0]} would be truncated')
        if control.get_attribute('role')=='combobox' or control.get_attribute('aria-autocomplete')=='list':
            menu,_dialog=opened_choices(scope,control,lambda:control.fill(str(value)),'Mercari '+names[0]);choose(menu,value,is_size)
        else:control.fill(str(value))
        control.press('Tab')
    else:
        menu,_dialog=opened_choices(scope,control,control.click,'Mercari '+names[0]);choose(menu,value,is_size)
    if not (size_pattern(value).fullmatch(str(value_of(control))) if is_size else norm(value_of(control))==norm(value)):raise ValueError(f'Mercari did not retain {names[0]}')
    if tag in {'INPUT','TEXTAREA'} and not is_size:expect(control).to_have_value(str(value))
    return control


def set_category(page,path):
    from playwright.sync_api import expect
    control=field(page,['Category'])
    control.click()
    panel=page.get_by_role('dialog').filter(visible=True)
    expect(panel).to_have_count(1,timeout=10000)
    for label in path:choose(panel,label)
    done=panel.get_by_role('button',name=re.compile(r'^(Done|Save|Apply)$',re.I))
    if done.count()==1 and done.is_visible():done.click()
    verify_category(control,path)


def verify_category(control,path):
    from playwright.sync_api import expect
    opposite='Women' if path[0]=='Men' else 'Men'
    if re.search(r'\b'+opposite+r'\b',control.inner_text(),re.I):raise ValueError('Mercari category department changed')
    for label in path:expect(control).to_contain_text(re.compile(r'(?<!\w)'+re.escape(label)+r'(?!\w)',re.I),timeout=10000)


def photo_section(page):
    section=page.get_by_role('region',name=re.compile(r'^(Photos|Listing photos)$',re.I))
    if section.count()==1:return section
    heading=page.get_by_role('heading',name=exact('Photos'))
    return heading.locator('xpath=ancestor::*[self::section or @role="region"][1]')


def photo_keys(page):
    if page.locator('input#sellName').count():
        from .mercari_native_form import photo_hashes
        return photo_hashes(page)
    return list(dict.fromkeys(key for value in photo_section(page).locator('img').evaluate_all('els=>els.filter(e=>e.complete&&e.naturalWidth>0).map(e=>e.currentSrc||e.src)') if (key:=photo_key(value))))


def attach_photos(page,photos):
    if page.locator('input#sellName').count():
        from .mercari_native_form import attach_photos as attach_native
        return attach_native(page,photos)
    from playwright.sync_api import expect
    if not 1<=len(photos)<=12:raise ValueError('Mercari accepts 1 to 12 photos')
    if photo_keys(page):raise ValueError('Mercari form already contains photos')
    for index,path in enumerate(photos):
        if not Path(path).is_file():raise ValueError('A selected Mercari photo is missing')
        uploads=photo_section(page).locator('input[type=file]')
        images=uploads.evaluate_all("els=>els.map((e,i)=>({i,accept:e.accept,disabled:e.disabled})).filter(e=>!e.disabled&&!/video/i.test(e.accept))")
        if len(images)!=1:raise ValueError('Mercari image upload control is ambiguous')
        uploads.nth(images[0]['i']).set_input_files(str(path),timeout=120000)
        expect(photo_section(page).locator('img[src*=".mercdn.net/"]')).to_have_count(index+1,timeout=90000)
        page.wait_for_function("count=>[...document.querySelectorAll('img')].filter(e=>e.getClientRects().length&&e.complete&&e.naturalWidth>0&&e.src.includes('.mercdn.net/')).length>=count",arg=index+1,timeout=90000)
        if len(photo_keys(page))!=index+1:raise ValueError('Mercari did not confirm each uploaded photo')
    return photo_keys(page)


def label_quote(text):
    carrier=re.search(r'\b(USPS|UPS|FedEx)\b',text,re.I)
    price=re.search(r'\$(\d+(?:\.\d{1,2})?)',text)
    capacity=re.search(r'(?:up to\s*)?(\d+(?:\.\d+)?)\s*(lb|lbs|oz)\b',text,re.I)
    if not carrier or not price or not capacity or re.search(r'Media Mail|envelope|local delivery',text,re.I):return None
    ounces=float(capacity[1])*(16 if capacity[2].lower().startswith('lb') else 1)
    return float(price[1]),ounces


def fill_shipping(page,item,options,ship_from):
    from playwright.sync_api import expect
    zipcode=str(ship_from.get('zip') or '')
    if not re.fullmatch(r'\d{5}',zipcode):raise ValueError('Set the Mercari ship-from ZIP in Settings')
    section=page.get_by_role('region',name=re.compile(r'^(Shipping|Delivery)$',re.I))
    expect(section).to_have_count(1)
    set_value(section,['ZIP code','Ship from ZIP code','Zip code'],zipcode)
    mode=options.get('shippingMode','buyer_label')
    if mode=='ship_on_own':
        payer=section.get_by_role('radio',name=re.compile(r'^(Seller|I.ll pay|Seller pays)$',re.I))
        payer.check();expect(payer).to_be_checked()
        choice=section.get_by_role('radio',name=re.compile(r'^(Ship on your own|I.ll ship on my own)$',re.I))
        choice.check();expect(choice).to_be_checked()
        return {'mode':mode,'zip':zipcode}
    if mode!='buyer_label':raise ValueError('Unknown Mercari shipping mode')
    payer=section.get_by_role('radio',name=re.compile(r'^(Buyer|Buyer pays)$',re.I))
    payer.check();expect(payer).to_be_checked()
    weight=item.get('weightOz')
    if not isinstance(weight,(int,float)) or not math.isfinite(weight) or weight<=0:raise ValueError('Mercari package weight is missing')
    pounds,ounces=divmod(math.ceil(weight),16)
    set_value(section,['Pounds','Weight pounds'],str(pounds))
    set_value(section,['Ounces','Weight ounces'],str(ounces))
    for label,key in [('Length','length'),('Width','width'),('Height','height')]:set_value(section,[label],str(item['packageDims'][key]))
    carrier=section.get_by_role('button',name=re.compile(r'^(Choose shipping|Select carrier|Shipping label)$',re.I))
    carrier.click()
    dialog=page.get_by_role('dialog').filter(visible=True)
    expect(dialog).to_have_count(1)
    choices=dialog.get_by_role('radio')
    candidates=[]
    for index in range(choices.count()):
        control=choices.nth(index)
        text=control.evaluate("e=>e.getAttribute('aria-label')||[...e.labels||[]].map(l=>l.innerText).join(' ')")
        quote=label_quote(text)
        if quote and quote[1]>=math.ceil(weight) and control.is_enabled():candidates.append((quote[0],quote[1],index,text))
    if not candidates:raise ValueError('Mercari has no eligible parcel label for the reviewed weight')
    _,_,index,label=min(candidates)
    choices.nth(index).check()
    dialog.get_by_role('button',name=re.compile(r'^(Save|Apply|Done)$',re.I)).click()
    summary=section.get_by_role('status')
    expect(summary).to_contain_text(label,timeout=10000)
    return {'mode':mode,'zip':zipcode,'weight':math.ceil(weight),'label':label,'dims':item['packageDims']}


def fill_listing(page,item,options,ship_from):
    if page.locator('input#sellName').count():
        from .mercari_native_form import fill_listing as fill_native
        return fill_native(page,item,options,ship_from)
    path=category_path(item,options.get('unisexDepartment','Women'))
    title=set_value(page,['Title','What are you selling?'],item['title'])
    set_value(page,['Description','Describe your item'],item['description'])
    set_category(page,path)
    brand=set_value(page,['Brand'],item['brand'])
    size=field(page,['Size'],required=False)
    if size is not None:set_value(page,['Size'],item['size'])
    elif any(norm(item.get('itemType')).endswith(kind) for kind in ('shirt','tee','tank','tanktop','jeans','pants','shorts','sweater','hoodie','dress','skirt')):
        raise ValueError('Mercari did not offer the garment size control')
    condition=CONDITIONS.get(item.get('condition'))
    if not condition:raise ValueError('Mercari condition needs review')
    set_value(page,['Condition'],condition)
    color=field(page,['Color'],required=False)
    if color is not None and not item.get('color'):raise ValueError('Mercari color needs review')
    if color is not None and item.get('color'):set_value(page,['Color'],'Gray' if norm(item['color'])=='grey' else item['color'])
    sku=field(page,['SKU','Custom SKU'],required=False)
    if sku is not None:set_value(page,['SKU','Custom SKU'],item['sku'])
    if item.get('quantity')!=1:raise ValueError('Mercari posts one piece per listing')
    quantity=field(page,['Quantity'],required=False)
    if quantity is not None:set_value(page,['Quantity'],'1')
    price=item.get('price')
    if not isinstance(price,(int,float)) or not math.isfinite(price) or not 1<=price<=2000:raise ValueError('Mercari price is outside the standard listing range')
    set_value(page,['Price'],f'{price:.2f}')
    for name in ('Smart Pricing','Smart Offers','Automatic offers'):
        control=page.get_by_role('switch',name=exact(name)).or_(page.get_by_role('checkbox',name=exact(name))).filter(visible=True)
        if control.count()>1:raise ValueError('Mercari pricing controls are ambiguous')
        if control.count()==1 and control.is_checked():control.uncheck()
    shipping=fill_shipping(page,item,options,ship_from)
    result={'title':value_of(title),'brand':value_of(brand),'size':value_of(size) if size is not None else None,
            'color':value_of(color) if color is not None else None,
            'category':path,'condition':condition,'price':price,'shipping':shipping}
    verify_listing_fields(page,item,result)
    return result


def verify_listing_fields(page,item,filled):
    if filled.get('native'):
        from .mercari_native_form import verify_fields
        return verify_fields(page,item,filled)
    from playwright.sync_api import expect
    for labels,value in [(['Title','What are you selling?'],filled['title']),(['Description','Describe your item'],item['description']),
                         (['Brand'],filled['brand']),(['Condition'],filled['condition'])]:
        current=value_of(field(page,labels))
        matches=current==value if labels[0] in {'Title','Description'} else norm(current)==norm(value)
        if not matches:raise ValueError('Mercari field changed before publishing: '+labels[0])
    if filled['size'] is not None and norm(value_of(field(page,['Size'])))!=norm(filled['size']):raise ValueError('Mercari size changed')
    if filled['color'] is not None and norm(value_of(field(page,['Color'])))!=norm(filled['color']):raise ValueError('Mercari color changed')
    verify_category(field(page,['Category']),filled['category'])
    if abs(float(value_of(field(page,['Price'])))-filled['price'])>0.001:raise ValueError('Mercari price changed')
    quantity=field(page,['Quantity'],required=False)
    if quantity is not None and str(value_of(quantity))!='1':raise ValueError('Mercari quantity changed')
    shipping=page.get_by_role('region',name=re.compile(r'^(Shipping|Delivery)$',re.I))
    expect(field(shipping,['ZIP code','Ship from ZIP code','Zip code'])).to_have_value(filled['shipping']['zip'])
    if filled['shipping']['mode']=='buyer_label':
        expect(shipping.get_by_role('radio',name=re.compile(r'^(Buyer|Buyer pays)$',re.I))).to_be_checked()
        weight=float(value_of(field(shipping,['Pounds','Weight pounds'])))*16+float(value_of(field(shipping,['Ounces','Weight ounces'])))
        if weight!=filled['shipping']['weight']:raise ValueError('Mercari package weight changed')
        for label,key in [('Length','length'),('Width','width'),('Height','height')]:
            if float(value_of(field(shipping,[label])))!=filled['shipping']['dims'][key]:raise ValueError('Mercari package dimensions changed')
        expect(shipping.get_by_role('status')).to_contain_text(filled['shipping']['label'])
    else:
        expect(shipping.get_by_role('radio',name=re.compile(r'^(Ship on your own|I.ll ship on my own)$',re.I))).to_be_checked()
        expect(shipping.get_by_role('radio',name=re.compile(r'^(Seller|I.ll pay|Seller pays)$',re.I))).to_be_checked()
    for name in ('Smart Pricing','Smart Offers','Automatic offers'):
        control=page.get_by_role('switch',name=exact(name)).or_(page.get_by_role('checkbox',name=exact(name))).filter(visible=True)
        if control.count():expect(control).not_to_be_checked()
    invalid=page.locator('input:visible:invalid,select:visible:invalid,textarea:visible:invalid')
    expect(invalid).to_have_count(0)
