"""Mercari's current seller form. Filling and verification never press List."""
import base64
import hashlib
import io
import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from PIL import Image, ImageChops, ImageOps, ImageStat
from .mercari_form import CONDITIONS, category_path, exact, listing_id, norm, size_pattern
from .petite_size import petite_size_base
from .normalize import canonical_brand


def dismiss_tips(page):
    tip=page.get_by_role('dialog').filter(has_text='List faster with templates')
    if tip.count()==1 and tip.is_visible():tip.get_by_role('button',name='Got it',exact=True).click()
    notice=page.get_by_text('Privacy settings',exact=True).locator('xpath=ancestor::*[.//button[normalize-space()="Review details"] and .//button[normalize-space()="Got it"]][1]')
    if notice.count()==1 and notice.is_visible():notice.get_by_role('button',name='Got it',exact=True).click()


def image_rgb(data):
    with Image.open(io.BytesIO(data)) as image:
        return ImageOps.exif_transpose(image).convert('RGB')


def image_pixels(data):
    return image_rgb(data).resize((64,64),Image.Resampling.LANCZOS)


def image_matches(source,data):
    expected=image_rgb(Path(source).read_bytes());actual=image_rgb(data)
    original_expected,original_actual=expected,actual
    # Compare at the same native resolution before sampling. A 4000px label
    # sampled straight to64 differs from the site's 4000->720->64 resampling.
    # Keep all pixel/local-tile/edge thresholds unchanged.
    if expected.size != actual.size:
        common=(max(64,min(expected.width,actual.width)),max(64,min(expected.height,actual.height)))
        expected=expected.resize(common,Image.Resampling.LANCZOS)
        actual=actual.resize(common,Image.Resampling.LANCZOS)
    if _matching_pixels(expected,actual):return True
    # Browser preview resizing can use a different interpolation kernel. Permit
    # bicubic only for a proportional downsize, under the same strict checks.
    if (64<=original_actual.width<original_expected.width and
            64<=original_actual.height<original_expected.height and
            original_expected.width*original_actual.height==original_expected.height*original_actual.width):
        return _matching_pixels(original_expected.resize(original_actual.size,Image.Resampling.BICUBIC),original_actual)
    return False


def preview_matches(page,source,data):
    if image_matches(source,data):return True
    original=Path(source).read_bytes()
    with Image.open(io.BytesIO(original)) as raw, Image.open(io.BytesIO(data)) as preview:
        if raw.format!='JPEG' or preview.format!='JPEG':return False
        width,height=ImageOps.exif_transpose(raw).size
        target_width,target_height=preview.size
    if not (64<=target_width<width and 64<=target_height<height and
            width*target_height==height*target_width):return False
    # Mercari uses Chrome's default canvas JPEG preview. Fine fabric can differ
    # from Pillow's resampling; accept only an EXACT native reproduction here.
    # The canvas stays off-DOM. No gallery, original, or upload is changed.
    expected=page.evaluate('''async ({source,width,height})=>{
      const image=new Image();image.src=source;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d');context.imageSmoothingQuality='low';
      context.drawImage(image,0,0,width,height);
      return canvas.toDataURL('image/jpeg',0.92).split(',')[1];
    }''',{'source':'data:image/jpeg;base64,'+base64.b64encode(original).decode('ascii'),
           'width':target_width,'height':target_height})
    return base64.b64decode(expected,validate=True)==data


def _matching_pixels(expected,actual):
    expected=expected.resize((64,64),Image.Resampling.LANCZOS)
    actual=actual.resize((64,64),Image.Resampling.LANCZOS)
    delta=ImageChops.difference(expected,actual)
    difference=sum(ImageStat.Stat(delta).mean)/3
    def edges(image):
        pixels=image.convert('L').resize((17,16),Image.Resampling.LANCZOS).tobytes()
        return [pixels[y*17+x]>pixels[y*17+x+1] for y in range(16) for x in range(16)]
    distance=sum(a!=b for a,b in zip(edges(expected),edges(actual)))
    if difference<=5 and distance<=8:return True
    # JPEG quantization can flip weak edge signs on nearly flat fabric. Accept
    # that case only when pixels are exceptionally close globally AND in every
    # local tile; a low global average must not hide a changed graphic or crop.
    # Chroma subsampling can add a little regional error on woven fabric even
    # when global error stays below one RGB level. Bound every tile to 1.5/255.
    return difference<=1 and all(sum(ImageStat.Stat(delta.crop((x,y,x+8,y+8))).mean)/3<=1.5
                                 for x in range(0,64,8) for y in range(0,64,8))


def preview_data(page):
    values=page.get_by_test_id('PreviewThumbnail').evaluate_all('els=>els.map(e=>({src:e.currentSrc||e.src,ready:e.complete&&e.naturalWidth>0}))')
    result=[]
    for value in values:
        if not value['ready'] or not re.match(r'^data:image/(?:jpeg|png|webp);base64,',value['src']):
            raise ValueError('Mercari photo preview is not ready')
        data=base64.b64decode(value['src'].split(',',1)[1],validate=True)
        if not data or len(data)>20_000_000:raise ValueError('Mercari photo preview is invalid')
        result.append(data)
    return result


def photo_hashes(page):
    return ['preview:'+hashlib.sha256(data).hexdigest() for data in preview_data(page)]


def attach_photos(page,photos):
    from playwright.sync_api import expect, Error as BrowserError, TimeoutError as BrowserTimeout
    dismiss_tips(page)
    if not 1<=len(photos)<=12 or any(not Path(path).is_file() for path in photos):raise ValueError('Mercari needs 1 to 12 selected photos')
    if page.get_by_test_id('PreviewThumbnail').count():raise ValueError('Mercari form already contains photos')
    try: page.get_by_test_id('SellPhotoInput').set_input_files([str(path) for path in photos],timeout=120000)
    except BrowserTimeout:
        # A completed selection can outlive the input call. Verify it once.
        pass
    except BrowserError as error:
        if 'Cannot transfer files larger than 50Mb to a browser not co-located with the server' not in str(error):raise
        if page.get_by_test_id('PreviewThumbnail').count():raise ValueError('Mercari gallery changed during a rejected transfer') from error
        # The batch was rejected before transfer. The same native input appends
        # individual originals; wait for each preview before selecting the next.
        for count,path in enumerate(photos,1):
            try: page.get_by_test_id('SellPhotoInput').set_input_files(str(path),timeout=120000)
            except BrowserTimeout: pass
            expect(page.get_by_test_id('PreviewThumbnail')).to_have_count(count,timeout=30000)
            page.wait_for_function('()=>[...document.querySelectorAll("[data-testid=PreviewThumbnail]")].every(e=>e.complete&&e.naturalWidth>0)',timeout=30000)
    expect(page.get_by_test_id('PreviewThumbnail')).to_have_count(len(photos),timeout=30000)
    page.wait_for_function('()=>[...document.querySelectorAll("[data-testid=PreviewThumbnail]")].every(e=>e.complete&&e.naturalWidth>0)',timeout=30000)
    for index,(path,data) in enumerate(zip(photos,preview_data(page)),1):
        if not preview_matches(page,path,data):raise ValueError(f'Mercari photo preview differs from the selected photo or order (photo {index})')
    return photo_hashes(page)


def set_category(page,item,department):
    from playwright.sync_api import expect
    planned=category_path(item,department)
    control=page.get_by_text('Category',exact=True).locator('xpath=ancestor::*[.//button][1]').get_by_role('button')
    expect(control).to_have_count(1);control.click()
    dialog=page.get_by_role('dialog').filter(visible=True)
    expect(dialog).to_have_count(1)
    if dialog.get_by_role('button',name=exact(planned[0])).count()!=1:
        dialog.get_by_text('All Categories',exact=True).click()
    aliases={'Button-front':['Button down shirt','Button down'],'Polo':['Polos','Polo shirt','Polo shirts'],'Tank tops':['Tank'],'Blouses':['Blouse']}
    chosen=[]
    for label in planned:
        options=[label,*aliases.get(label,[])]
        matches=[dialog.get_by_role('button',name=exact(value)) for value in options]
        available=[choice for choice in matches if choice.count()==1 and choice.is_visible()]
        if not available:raise ValueError('Mercari category option is missing: '+label)
        choice=available[0];chosen.append(choice.inner_text().strip());choice.click()
    expect(page.get_by_role('button',name=' > '.join(chosen),exact=True)).to_be_visible(timeout=10000)
    return chosen


def set_brand(page,item,options):
    from playwright.sync_api import expect
    brand=item['brand']
    aliases=list(dict.fromkeys([brand,canonical_brand(brand)]))
    control=page.locator('input#sellBrandId')
    def finish(fallback):
        value=control.input_value()
        control.press('Escape');control.press('Tab')
        expect(page.get_by_role('option').filter(visible=True)).to_have_count(0,timeout=5000)
        expect(control).to_have_value(value)
        absent=page.get_by_role('checkbox',name='No brand / Not sure',exact=True)
        if fallback:expect(absent).to_be_checked()
        elif absent.count():expect(absent).not_to_be_checked()
        return {'fallback':fallback,'value':brand if fallback else value}
    pattern=re.compile(r'^\s*(?:'+'|'.join(re.escape(value) for value in aliases)+r')\s*$',re.I)
    for search in aliases:
        control.fill('');control.press_sequentially(search,delay=35,timeout=max(5000,len(search)*35+2000))
        choice=page.get_by_role('option',name=pattern)
        try:expect(choice).to_have_count(1,timeout=5000)
        except AssertionError:
            if choice.count()>1:raise ValueError('Mercari offered ambiguous matching brand options')
            continue
        selected=choice.inner_text().strip()
        choice.click();expect(control).to_have_value(exact(selected))
        return finish(False)
    approved=options.get('unlistedBrands',[])
    if not isinstance(approved,list) or norm(brand) not in {norm(value) for value in approved if isinstance(value,str)}:
        raise ValueError(f'Mercari does not offer {brand}; approve its No brand / Not sure fallback before posting') from None
    # Unbranded describes an absent maker and is removed by the shared
    # copy sanitizer. Known brands still have to remain in both fields.
    if norm(brand) != 'unbranded' and (norm(brand) not in norm(item['title']) or norm(brand) not in norm(item['description'])):
        raise ValueError('The approved brand fallback must keep the real brand in title and description')
    # Use the actual dropdown option when offered. Clicking the suggestion
    # chip while a failed search is active can be overwritten by its blur.
    control.fill('No brand')
    generic=page.get_by_role('option',name='No brand / Not sure',exact=True)
    try:expect(generic).to_have_count(1,timeout=5000)
    except AssertionError:pass
    else:
        generic.click();expect(control).to_have_value('No brand / Not sure')
        expect(page.get_by_role('checkbox',name='No brand / Not sure',exact=True)).to_be_checked()
        return finish(True)
    control.fill('');control.press('Escape');control.press('Tab');page.wait_for_timeout(300)
    expect(control).to_have_value('')
    fallback=page.get_by_role('checkbox',name='No brand / Not sure',exact=True)
    expect(fallback).to_have_count(1)
    if not fallback.is_checked():
        identifier=fallback.get_attribute('id')
        label=page.locator('label[for='+json.dumps(identifier)+']') if identifier else None
        if label is not None and label.count()==1:
            label.click()
        else:
            fallback.check()
    expect(fallback).to_be_checked()
    return finish(True)


def set_size(page,item,department):
    from playwright.sync_api import expect
    petite = petite_size_base(item, department)
    control=page.get_by_test_id('Size')
    if control.count() == 0 and norm(item.get('itemType')) in {'belt','bag','handbag','purse','shoulderbag','duffelbag','backpack'}:
        size = str(item.get('size') or '').strip()
        if norm(size) not in {'onesize','onesizefitsall','os'} and (not size or not any(
                re.search(r'\bsize\s*:?\s*'+re.escape(size)+r'\b',str(item.get(field) or ''),re.I) for field in ['title','description'])):
            raise ValueError('Keep the reviewed accessory size in the listing copy')
        return None
    expect(control).to_have_count(1);control.click()
    options=page.get_by_test_id('Size-option')
    options.first.wait_for(timeout=10000)
    names=options.all_inner_texts()
    key={'small':'s','medium':'m','large':'l','extralarge':'xl','extrasmall':'xs','2xl':'xxl'}.get(norm(item['size']),norm(item['size']))
    regular={'Women':{'xs':'XS (0-2)','s':'S (4-6)','m':'M (8-10)','l':'L (12-14)','xl':'XL (16-18)','xxl':'2XL (20-22)'},
             'Men':{'xs':'XS (30-32)','s':'S (34-36)','m':'M (38-40)','l':'L (42-44)','xl':'XL (46-48)','xxl':'XXL (50-52)'}}
    preferred=regular.get(department,{}).get(key)
    if petite == '6': preferred = 'S (4-6)'
    matches=[text for text in names if preferred and text.strip().casefold()==preferred.casefold()]
    if not matches:matches=[text for text in names if size_pattern(item['size']).fullmatch(text.strip())]
    distinct={text.strip() for text in matches}
    if len(distinct)!=1:raise ValueError('Mercari size is missing or offers conflicting size ranges')
    value=next(iter(distinct))
    # The current picker repeats identical labels with different internal IDs.
    # Use its first standard-size entry, never a different displayed range.
    options.filter(has_text=exact(value)).first.click();expect(control).to_have_text(value)
    return value


def set_shipping(page,item,options,ship_from):
    from playwright.sync_api import expect
    zipcode=str(ship_from.get('zip') or '')
    if not re.fullmatch(r'\d{5}',zipcode):raise ValueError('Mercari ship-from ZIP is missing')
    if page.get_by_test_id('ShipsFrom').inner_text().strip()!=zipcode:
        page.locator('main').get_by_role('button',name='Edit',exact=True).click()
        addresses=page.get_by_role('dialog').filter(has=page.get_by_role('heading',name='My addresses',exact=True))
        location=page.get_by_test_id('MyAddressesCity').filter(has_text=re.compile(r'\b'+re.escape(zipcode)+r'(?:-\d{4})?\b'))
        choice=addresses.get_by_test_id('MyAddressesAddressRow').filter(has=location)
        expect(choice).to_have_count(1,timeout=15000)
        choice.get_by_test_id('MyAddressesCity').click()
        addresses.get_by_role('button',name='Use',exact=True).click()
        expect(addresses).not_to_be_visible(timeout=15000)
    expect(page.get_by_test_id('ShipsFrom')).to_have_text(zipcode)
    if options.get('shippingMode','buyer_label')!='buyer_label':raise ValueError('This native Mercari form requires the configured buyer-paid label route')
    page.get_by_test_id('MercariShipping').click()
    expect(page.get_by_role('radio',name='mercariShipping',exact=True)).to_be_checked()
    weight=item['weightOz'];dims=item['packageDims']
    if not isinstance(weight,(float,int)) or not math.isfinite(weight) or weight<=0:raise ValueError('Mercari package weight is missing')
    dimensions=[dims[key] for key in ('length','width','height')]
    if any(not isinstance(value,(int,float)) or not math.isfinite(value) or value<=0 for value in dimensions):raise ValueError('Mercari package dimensions are missing')
    page.get_by_test_id('SelectShipping').click()
    tip=page.get_by_role('dialog').filter(has_text='Weigh and measure your package accurately')
    if tip.count()==1 and tip.is_visible():tip.get_by_role('button',name='Got it',exact=True).click()
    dialog=page.get_by_role('dialog').filter(visible=True)
    pounds,ounces=divmod(math.ceil(weight),16)
    dialog.get_by_test_id('ItemWeightInPounds').fill(str(pounds))
    dialog.get_by_test_id('ItemWeightInOunces').fill(str(ounces))
    fits=all(value<=limit for value,limit in zip(sorted(dimensions,reverse=True),(14,10,5)))
    dialog.get_by_test_id('FitsInShoeboxYes' if fits else 'FitsInShoeboxNo').check()
    if not fits:
        for label,key in [('Length','length'),('Width','width'),('Height','height')]:
            dimension=dialog.get_by_test_id('Input'+label);dimension.fill(str(dims[key]))
            expect(dimension).to_have_value(str(dims[key]))
    if (float(dialog.get_by_test_id('ItemWeightInPounds').input_value() or '0')!=pounds
            or float(dialog.get_by_test_id('ItemWeightInOunces').input_value() or '0')!=ounces):
        raise ValueError('Mercari did not retain the reviewed package weight')
    dialog.get_by_role('button',name='Next',exact=True).click()
    expect(dialog.get_by_role('heading',name='Which label would you like to use?',exact=True)).to_be_visible(timeout=20000)
    services=['USPS Ground Advantage','UPS Ground Saver','UPS Ground','FedEx Ground Economy','FedEx Home','USPS Priority Mail']
    quotes=[]
    for service in services:
        name=dialog.get_by_text(service,exact=True)
        if name.count()!=1:continue
        card=name.locator('xpath=ancestor::*[.//input[@type="radio"]][1]')
        radio=card.locator('input[type=radio]')
        if radio.count()!=1 or not radio.is_enabled():continue
        amount=re.search(r'\$(\d+(?:\.\d{1,2})?)',card.inner_text())
        if amount:quotes.append((float(amount[1]),service,radio))
    if not quotes:raise ValueError('Mercari offered no supported parcel quote for this package')
    price,service,radio=min(quotes,key=lambda row:row[:2]);radio.check();expect(radio).to_be_checked()
    dialog.get_by_role('button',name='Save',exact=True).click();expect(dialog).not_to_be_visible(timeout=15000)
    page.get_by_test_id('ShippingPayerOption').click();page.get_by_role('option',name='No',exact=True).click()
    return {'zip':zipcode,'weight':math.ceil(weight),'dims':dims,'fitsShoebox':fits,'service':service,'price':price}


def smart_pricing_toggle(page):
    from playwright.sync_api import expect
    heading=page.get_by_role('heading',name=exact('Smart pricing'))
    if heading.count()==0:
        # Some native forms omit this optional section. Read only the three
        # pricing values from the form backing this input, never its other data.
        state=page.get_by_test_id('Price').evaluate('''e=>{
          let f=e[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];
          for(let depth=0;f&&depth<24;depth++,f=f.return){const p=f.memoizedProps||{};
            const form=typeof p.getValues==='function'?p:typeof p.value?.getValues==='function'?p.value:null;
            if(form){const enabled=form.getValues('sellIsAutoPriceDrop'),floor=form.getValues('sellMinPriceForAutoPriceDrop');
              return {price:form.getValues('sellPrice'),known:enabled!==undefined&&floor!==undefined,enabled,floor};}}
          return null;
        }''')
        price=page.get_by_test_id('Price').input_value().replace(',','')
        # The current low-price form can encode its empty floor as numeric zero.
        # Keep rejecting positive floors, malformed values and active/unknown flags.
        if (not state or state.get('known') is not True or not (state.get('enabled') is None or state.get('enabled') is False)
                or not (state.get('floor') is None or type(state.get('floor')) in (int,float) and state['floor'] == 0)
                or type(state.get('price')) not in (int,float)
                or not math.isfinite(state['price']) or abs(float(price)-state['price'])>.001):
            raise ValueError('Mercari hidden Smart Pricing state could not be verified as off')
        return None
    expect(heading).to_be_visible(timeout=20000)
    panel=heading.locator('xpath=ancestor::*[.//button[@aria-pressed]][1]')
    toggle=panel.locator('button[aria-pressed]')
    expect(toggle).to_have_count(1)
    return toggle


def fill_listing(page,item,options,ship_from):
    from playwright.sync_api import expect
    if item.get('quantity')!=1:raise ValueError('Mercari posts one piece per listing')
    if not isinstance(item.get('price'),(int,float)) or not math.isfinite(item['price']) or not 1<=item['price']<=2000:raise ValueError('Mercari price is outside the supported range')
    if not item.get('title') or len(item['title'])>80 or not item.get('description') or len(item['description'])>1000 or len(item['description'].split())<5:raise ValueError('Mercari title or description needs review')
    title=page.get_by_test_id('Title');description=page.get_by_label('Description',exact=True)
    title.fill(item['title']);description.fill(item['description'])
    expect(title).to_have_value(item['title']);expect(description).to_have_value(item['description'])
    category=set_category(page,item,options.get('unisexDepartment','Women'))
    brand=set_brand(page,item,options)
    condition=CONDITIONS.get(item.get('condition'))
    if not condition:raise ValueError('Mercari condition needs review')
    label=page.get_by_test_id('Condition'+condition.replace(' ','').replace('new','New'))
    label.click()
    condition_id={'New':'1','Like new':'2','Good':'3','Fair':'4'}[condition]
    expect(page.locator(f'input[name="sellCondition"][id="{condition_id}"]')).to_be_checked()
    size=set_size(page,item,category[0])
    shipping=set_shipping(page,item,options,ship_from)
    price=page.get_by_test_id('Price')
    # The live currency mask can append replacement text to its suggested price.
    # Clear it through the same key events as a person and prove it is empty first.
    price.click();price.press('Control+A');price.press('Backspace')
    expect(price).to_have_value('')
    price.press_sequentially(f"{item['price']:.2f}",delay=40);price.press('Tab')
    # Let Mercari's debounced pricing/fee update finish before disabling its
    # automatic floor. Otherwise a late update can restore an old floor and fee
    # behind an OFF switch and the server rejects the reviewed price.
    page.wait_for_timeout(2500)
    toggle=smart_pricing_toggle(page)
    floor=page.get_by_test_id('SmartPricingFloorPrice')
    if toggle is not None and toggle.get_attribute('aria-pressed')=='false':
        toggle.click()
        expect(toggle).to_have_attribute('aria-pressed','true')
    if toggle is not None and floor.count()==1 and floor.is_visible():
        floor.click();floor.press('Control+A');floor.press('Backspace')
        expect(floor).to_have_value('')
    if toggle is not None and toggle.get_attribute('aria-pressed')=='true':
        toggle.click()
        if toggle.get_attribute('aria-pressed')=='true':
            confirmation=page.get_by_role('dialog').filter(has_text=re.compile('Before you turn off Smart Pricing',re.I))
            expect(confirmation).to_be_visible(timeout=10000)
            confirmation.get_by_role('button',name='Turn off',exact=True).click()
            expect(confirmation).not_to_be_visible(timeout=10000)
    if toggle is not None:expect(toggle).to_have_attribute('aria-pressed','false')
    for name in ('Smart Pricing','Smart Offers','Automatic offers'):
        control=page.get_by_role('switch',name=exact(name)).or_(page.get_by_role('checkbox',name=exact(name))).filter(visible=True)
        if control.count()>1:raise ValueError('Mercari pricing controls are ambiguous')
        if control.count() and control.is_checked():control.uncheck()
    result={'native':True,'title':item['title'],'brand':brand,'condition':condition,'conditionId':condition_id,'size':size,'category':category,'price':item['price'],'shipping':shipping}
    verify_fields(page,item,result)
    return result


def verify_fields(page,item,filled):
    from playwright.sync_api import expect
    expect(page.get_by_test_id('Title')).to_have_value(item['title'])
    expect(page.get_by_label('Description',exact=True)).to_have_value(item['description'])
    expect(page.get_by_role('button',name=' > '.join(filled['category']),exact=True)).to_be_visible()
    if filled['brand']['fallback']:expect(page.get_by_role('checkbox',name='No brand / Not sure',exact=True)).to_be_checked()
    else:expect(page.locator('input#sellBrandId')).to_have_value(exact(filled['brand']['value']))
    expect(page.locator(f'input[name="sellCondition"][id="{filled["conditionId"]}"]')).to_be_checked()
    if filled['size'] is None: expect(page.get_by_test_id('Size')).to_have_count(0)
    else: expect(page.get_by_test_id('Size')).to_have_text(filled['size'])
    if abs(float(page.get_by_test_id('Price').input_value().replace(',',''))-filled['price'])>.001:raise ValueError('Mercari price changed')
    shipping=filled['shipping']
    expect(page.get_by_test_id('ShipsFrom')).to_have_text(shipping['zip'])
    expect(page.get_by_role('radio',name='mercariShipping',exact=True)).to_be_checked()
    expect(page.get_by_test_id('ShippingPayerOption')).to_have_text('No')
    toggle=smart_pricing_toggle(page)
    if toggle is not None:expect(toggle).to_have_attribute('aria-pressed','false')
    expect(page.get_by_test_id('SelectShipping')).to_have_value(shipping['service'])
    summary=page.get_by_test_id('ShippingClass').inner_text()
    capacity=re.search(r'Up to (\d+(?:\.\d+)?)\s*(lb|oz)',summary,re.I)
    charge=re.search(r'Buyer pays \$(\d+(?:\.\d+)?)',summary,re.I)
    if not capacity or float(capacity[1])*(16 if capacity[2].lower()=='lb' else 1)<shipping['weight']:raise ValueError('Mercari label does not cover the reviewed weight')
    if not charge or abs(float(charge[1])-shipping['price'])>.001:raise ValueError('Mercari shipping payer or quote changed')
    for name in ('Smart Pricing','Smart Offers','Automatic offers'):
        control=page.get_by_role('switch',name=exact(name)).or_(page.get_by_role('checkbox',name=exact(name))).filter(visible=True)
        if control.count():expect(control).not_to_be_checked()
    expect(page.locator('input:visible:invalid,textarea:visible:invalid,select:visible:invalid')).to_have_count(0)


class NoImageRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('Mercari image redirected unexpectedly')


def verify_posted(page,url,filled,cover_path):
    from playwright.sync_api import expect
    from .mercari_inventory import find_card
    identifier=listing_id(url)
    if not identifier:raise ValueError('Invalid Mercari publication identity')
    card=find_card(page,identifier,'active')
    expect(card.get_by_role('link',name=filled['title'],exact=True)).to_have_count(2)
    if abs(float(card.locator('input[placeholder="0.00"]').input_value())-filled['price'])>.001:raise ValueError('Mercari active price differs')
    response=page.goto(url,wait_until='domcontentloaded',timeout=30000)
    if not response or response.status!=200 or listing_id(page.url)!=identifier:raise ValueError('Mercari product page did not load')
    expect(page.get_by_role('heading',level=1,name=filled['title'],exact=True)).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('ItemPrice')).to_have_text(f"${filled['price']:.2f}")
    expect(page.get_by_test_id('EditListing')).to_have_attribute('href',f'/sell/edit/{identifier}/')
    if filled.get('category'):
        breadcrumbs=page.locator('main nav').first.get_by_role('link').all_inner_texts()
        if [norm(value) for value in breadcrumbs[-len(filled['category']):]]!=[norm(value) for value in filled['category']]:
            raise ValueError('Mercari published category differs from the reviewed category')
    if filled.get('condition'):
        brand=filled.get('brand',{})
        suffix=r'(?:\s*\|\s*'+re.escape(brand['value'])+r')?' if brand.get('value') and not brand.get('fallback') else ''
        if not filled.get('size') and brand.get('value') and not brand.get('fallback'):
            # The details table repeats the condition by itself. Bind to the
            # product summary with its reviewed brand when there is no size.
            suffix=r'\s*\|\s*'+re.escape(brand['value'])
        size_prefix = re.escape(filled['size'])+r'\s*\|\s*' if filled.get('size') else ''
        summary=re.compile(r'^'+size_prefix+r'(?:Used\s*-\s*)?'+re.escape(filled['condition'])+suffix+r'$',re.I)
        expect(page.locator('main').get_by_text(summary)).to_be_visible()
    photos=filled.get('photoPaths') or [cover_path]
    images=page.get_by_test_id('ProductSquareImage').locator('img')
    expect(images).to_have_count(len(photos),timeout=15000)
    for index,path in enumerate(photos):
        source=images.nth(index).evaluate('e=>e.currentSrc||e.src');target=urlsplit(source)
        if target.scheme!='https' or not (target.hostname or '').endswith('.mercdn.net') or target.port or target.username or target.password:raise ValueError('Unexpected Mercari product image host')
        with build_opener(NoImageRedirect()).open(source,timeout=20) as image_response:data=image_response.read(20_000_001)
        if len(data)>20_000_000 or not image_matches(path,data):raise ValueError(f'Mercari published photo {index+1} differs from the approved photo')
    return f'https://www.mercari.com/us/item/{identifier}/'
