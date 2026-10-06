"""Current Mercari controls, with all network activity fulfilled locally."""
import io
import base64
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, Locator, Error as BrowserError, TimeoutError as BrowserTimeout

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.post_mercari import run_on_page
from black_cat_worker.mercari_native_form import attach_photos, image_matches, preview_matches, verify_posted, smart_pricing_toggle, set_brand, set_category, set_size

ID='m12345678901'
HTML='''<main>
<input type="file" multiple data-testid="SellPhotoInput" onchange="for(const f of this.files){const r=new FileReader();r.onload=()=>{const i=new Image();i.dataset.testid='PreviewThumbnail';i.src=r.result;document.querySelector('#photos').append(i)};r.readAsDataURL(f)}"><div id="photos"></div>
<label>Title<input id="sellName" data-testid="Title" maxlength="80"></label>
<label>Description<textarea maxlength="1000"></textarea></label>
<div><p>Category</p><button id="category" onclick="crumbs=[];document.querySelector('#categoryDialog').showModal()">Men &gt; Tops &gt; T-shirts</button></div>
<dialog id="categoryDialog"><p>All Categories</p><button onclick="crumbs.push('Women')">Women</button><button onclick="crumbs.push('Men')">Men</button>
<button onclick="crumbs.push('Tops & blouses')">Tops &amp; blouses</button><button onclick="crumbs.push('Tops')">Tops</button>
<button onclick="crumbs.push('T-shirts');document.querySelector('#category').innerText=crumbs.join(' > ');this.closest('dialog').close()">T-shirts</button></dialog>
<input id="sellBrandId" placeholder="Select brand" oninput="document.querySelector('#brands').innerHTML=this.value==='Gildan'?'<div role=listbox><button role=option onclick=chooseBrand()>Gildan</button></div>':''"><div id="brands"></div>
<label><input type="checkbox" onchange="if(this.checked)document.querySelector('#sellBrandId').value=''">No brand / Not sure</label>
<label data-testid="ConditionGood"><input id="3" name="sellCondition" type="radio">Good</label>
<div data-testid="Size" onclick="document.querySelector('#sizes').hidden=false">Select size</div>
<ul id="sizes" hidden><li role="option" data-testid="Size-option" onclick="chooseSize(this)">M (8-10)</li><li role="option" data-testid="Size-option" onclick="chooseSize(this)">M (8-10)</li><li role="option" data-testid="Size-option" onclick="chooseSize(this)">M (7-9)</li></ul>
<p data-testid="ShipsFrom">12345</p><input type="radio" aria-label="mercariShipping" checked>
<button data-testid="MercariShipping">Prepaid label</button>
<div data-testid="ShippingClass"><input data-testid="SelectShipping" readonly onclick="openShipping()"><p id="shippingSummary"></p></div>
<div data-testid="ShippingPayerOption" onclick="document.querySelector('#payers').hidden=false">Yes (Recommended)</div>
<div id="payers" hidden role="listbox"><button role="option" onclick="document.querySelector('[data-testid=ShippingPayerOption]').innerText='No';this.parentElement.hidden=true">No</button></div>
<input data-testid="Price" value="10.00">
<section><h3>Smart pricing</h3><button aria-pressed="true" onclick="this.setAttribute('aria-pressed','false');this.innerText='OFF'">ON</button></section>
<button onclick="posts++">List</button>
<dialog id="shippingDialog"></dialog>
</main><script>
let crumbs=[],posts=0;window.shippingValues={};
function chooseBrand(){document.querySelector('#sellBrandId').value='Gildan';document.querySelector('#brands').innerHTML=''}
function chooseSize(e){document.querySelector('[data-testid=Size]').innerText=e.innerText;e.parentElement.hidden=true}
function openShipping(){const d=document.querySelector('#shippingDialog');d.innerHTML=`
<input data-testid="ItemWeightInPounds" onblur="if(this.value==='0')this.value=''"><input data-testid="ItemWeightInOunces">
<input type="radio" name="box" data-testid="FitsInShoeboxYes"><input type="radio" name="box" data-testid="FitsInShoeboxNo">
<input data-testid="InputLength"><input data-testid="InputWidth"><input data-testid="InputHeight">
<button onclick="rates()">Next</button>`;d.showModal()}
function rates(){for(const e of document.querySelectorAll('#shippingDialog input'))shippingValues[e.dataset.testid]=e.type==='radio'?e.checked:e.value;
document.querySelector('#shippingDialog').innerHTML=`<h3>Which label would you like to use?</h3>
<article><input type="radio" name="carrier"><p>UPS Ground</p><h5>$8.00 $10.00</h5></article>
<article><input type="radio" name="carrier"><p>USPS Ground Advantage</p><h5>$5.66 $6.41</h5></article><button onclick="saveShipping()">Save</button>`}
function saveShipping(){let service=document.querySelector('[name=carrier]:checked').parentElement.querySelector('p').innerText;
document.querySelector('[data-testid=SelectShipping]').value=service;
document.querySelector('#shippingSummary').innerText='Up to 1 lb | 1 - 7 days | Buyer pays $5.66 $6.41';document.querySelector('#shippingDialog').close()}
</script>'''


class MercariNativeFormTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.photo=str(Path(self.folder.name,'000001_01.jpg'))
        Image.new('RGB',(80,80),'blue').save(self.photo)
        self.image=Path(self.photo).read_bytes();self.wrong_price=False;self.smart_confirmation=False
        self.address_picker=False;self.duplicate_address=False;self.masked_price=False;self.pricing_race=False;self.public_brand_summary=False;self.public_summary_override=None
        self.item={'sku':'000001','itemId':1,'title':'Gildan reviewed blue shirt','description':'Gildan shirt with reviewed details and photographs.',
            'brand':'Gildan','size':'M','itemType':'T-Shirt','department':'Unisex Adults','condition':'Good','quantity':1,'price':24.99,
            'weightOz':9,'packageDims':{'length':10,'width':8,'height':1}}
        self.options={'unisexDepartment':'Women','shippingMode':'buyer_label'}
        self.page=self.browser.new_page();self.page.set_default_timeout(1000);self.page.route('**/*',self.route)
        self.page.goto('https://www.mercari.com/sell/')

    def tearDown(self):self.page.close();self.folder.cleanup()

    def test_missing_accessory_size_keeps_numeric_size_in_copy_but_never_skips_clothing_size(self):
        self.page.get_by_test_id('Size').evaluate('e=>e.remove()')
        belt={**self.item,'itemType':'Belt','size':'32','title':'Gildan belt size 32'}
        self.assertIsNone(set_size(self.page,belt,'Men'))
        self.assertEqual(belt['size'],'32')
        with self.assertRaisesRegex(ValueError,'accessory size'):
            set_size(self.page,{**belt,'title':'Gildan belt'},'Men')
        with self.assertRaises(AssertionError):set_size(self.page,{**belt,'itemType':'Shorts'},'Men')

    def test_approved_petite_shorts_use_only_the_disclosed_standard_range(self):
        item={**self.item,'department':'Women','itemType':'Shorts','size':'6P',
              'title':'Gildan shorts size 6P petite','description':'Gildan shorts. Size 6P petite.'}
        self.page.locator('#sizes').evaluate('''e=>e.innerHTML='<li role="option" data-testid="Size-option" onclick="chooseSize(this)">S (4-6)</li><li role="option" data-testid="Size-option" onclick="chooseSize(this)">S (5-7)</li>' ''')
        self.assertEqual(set_size(self.page,item,'Women'),'S (4-6)')
        self.assertEqual(item['size'],'6P')
        with self.assertRaisesRegex(ValueError,'both title and description'):
            set_size(self.page,{**item,'description':'Gildan shorts size 6P.'},'Women')

    def test_polo_shirt_uses_the_native_polos_leaf_without_publishing(self):
        self.page.evaluate('''()=>{const button=document.createElement('button');button.textContent='Polos';
          button.onclick=()=>{crumbs.push('Polos');document.querySelector('#category').textContent=crumbs.join(' > ');
            document.querySelector('#categoryDialog').close()};document.querySelector('#categoryDialog').append(button)}''')
        chosen=set_category(self.page,{**self.item,'department':'Men','itemType':'Polo Shirt'},'Women')
        self.assertEqual(chosen,['Men','Tops','Polos'])
        self.assertEqual(self.page.locator('#category').inner_text(),'Men > Tops > Polos')
        self.assertEqual(self.page.evaluate('posts'),0)

    def test_missing_smart_pricing_section_requires_explicit_matching_form_state(self):
        self.page.set_content('<input data-testid="Price" value="8.99">')
        def state(enabled,floor,price=8.99):
            self.page.evaluate('''s=>{document.querySelector('input').__reactFiberFixture={memoizedProps:{getValues:key=>({
              sellPrice:s.price,sellIsAutoPriceDrop:s.enabled,sellMinPriceForAutoPriceDrop:s.floor})[key]}}}''',
              {'enabled':enabled,'floor':floor,'price':price})
        state(None,None)
        self.assertIsNone(smart_pricing_toggle(self.page))
        for enabled,floor,price in [(True,None,8.99),(0,None,8.99),(False,5,8.99),(None,None,19.99)]:
            state(enabled,floor,price)
            with self.assertRaisesRegex(ValueError,'could not be verified'):smart_pricing_toggle(self.page)
        self.page.evaluate("delete document.querySelector('input').__reactFiberFixture")
        with self.assertRaisesRegex(ValueError,'could not be verified'):smart_pricing_toggle(self.page)

    def test_disabled_low_price_form_accepts_numeric_empty_floor_but_not_active_or_malformed_state(self):
        self.page.set_content('<input data-testid="Price" value="7.99">')
        def state(enabled,floor):
            self.page.evaluate('''s=>{document.querySelector('input').__reactFiberFixture={memoizedProps:{getValues:key=>({
              sellPrice:7.99,sellIsAutoPriceDrop:s.enabled,sellMinPriceForAutoPriceDrop:s.floor})[key]}}}''',
              {'enabled':enabled,'floor':floor})
        for enabled in [None,False]:
            state(enabled,0)
            self.assertIsNone(smart_pricing_toggle(self.page))
        for enabled,floor in [(True,0),(0,0),(False,True),(False,'0'),(False,5),(None,-1)]:
            state(enabled,floor)
            with self.assertRaisesRegex(ValueError,'could not be verified'):
                smart_pricing_toggle(self.page)

    def route(self,route):
        url=route.request.url
        if '.mercdn.net/' in url:route.fulfill(status=200,content_type='image/jpeg',body=self.image);return
        if '/mypage/listings/active/' in url:
            price=99 if self.wrong_price else self.item['price']
            html=f'<main><h1>My listings</h1><table><tr><td><a href="/us/item/{ID}/"><img alt="{self.item["title"]}"></a></td><td><a href="/us/item/{ID}/">{self.item["title"]}</a><input placeholder="0.00" value="{price}"></td></tr></table></main>'
        elif '/us/item/' in url:
            html=f'<main><h1>{self.item["title"]}</h1><p data-testid="ItemPrice">${self.item["price"]:.2f}</p><a data-testid="EditListing" href="/sell/edit/{ID}/">Edit item</a><div data-testid="ProductSquareImage"><img src="https://u-mercari-images.mercdn.net/photos/{ID}_1.jpg"></div></main>'
            if self.public_brand_summary:html=html.replace('</main>','<p>M (8-10) | Used - Good | Gildan</p></main>')
            if self.public_summary_override:html=html.replace('</main>',f'<p>{self.public_summary_override}</p></main>')
        else:
            html=HTML
            if self.pricing_race:
                html=html.replace('<input data-testid="Price" value="10.00">', '<input data-testid="Price" value="10.00" oninput="setTimeout(()=>document.querySelector(\'[data-testid=SmartPricingFloorPrice]\').value=\'20.00\',150)">')
                html=html.replace('<section><h3>Smart pricing</h3><button aria-pressed="true" onclick="this.setAttribute(\'aria-pressed\',\'false\');this.innerText=\'OFF\'">ON</button></section>',
                    '<section><h3>Smart pricing</h3><input data-testid="SmartPricingFloorPrice" value="20.00" hidden><button aria-pressed="false" onclick="const on=this.getAttribute(\'aria-pressed\')!==\'true\';this.setAttribute(\'aria-pressed\',String(on));this.innerText=on?\'ON\':\'OFF\';this.previousElementSibling.hidden=!on">OFF</button></section>')
            if self.masked_price:
                html=html.replace('<input data-testid="Price" value="10.00">', '<input data-testid="Price" value="10.00" onkeydown="if(event.key===\'Backspace\')this.dataset.cleared=\'yes\'" oninput="if(this.dataset.cleared!==\'yes\')this.value=\'10\'+this.value">')
            if self.address_picker:
                html=html.replace('<p data-testid="ShipsFrom">12345</p>', '<p data-testid="ShipsFrom">99999</p><button onclick="document.querySelector(\'#addresses\').showModal()">Edit</button>')
                address='<div data-testid="MyAddressesAddressRow"><p data-testid="MyAddressesCity">Fixture, FL 12345</p></div>'
                html+=f'<dialog id="addresses"><h1>My addresses</h1>{address}{address if self.duplicate_address else ""}<button onclick="document.querySelector(\'[data-testid=ShipsFrom]\').innerText=\'12345\';this.closest(\'dialog\').close()">Use</button></dialog>'
            if self.smart_confirmation:
                html=html.replace("this.setAttribute('aria-pressed','false');this.innerText='OFF'", "document.querySelector('#smartConfirm').showModal()")
                html+='<dialog id="smartConfirm"><h2>Before you turn off Smart Pricing...</h2><button onclick="const b=document.querySelector(\'button[aria-pressed]\');b.setAttribute(\'aria-pressed\',\'false\');b.innerText=\'OFF\';this.closest(\'dialog\').close()">Turn off</button></dialog>'
        route.fulfill(status=200,content_type='text/html',body=html)

    def fill(self):
        def forbid():raise AssertionError('Fill must not authorize publishing')
        return run_on_page(self.page,self.item,[self.photo],self.options,{'zip':'12345'},'fill',forbid)

    def test_native_fill_overrides_guessed_category_and_price_and_turns_smart_pricing_off(self):
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.get_by_test_id('Price').input_value(),'24.99')
        self.assertEqual(self.page.get_by_test_id('Size').inner_text(),'M (8-10)')
        self.assertEqual(self.page.get_by_test_id('ShippingPayerOption').inner_text(),'No')
        self.assertEqual(self.page.locator('button[aria-pressed]').get_attribute('aria-pressed'),'false')
        self.assertEqual(self.page.evaluate('posts'),0)
        self.assertEqual(self.page.evaluate('shippingValues.ItemWeightInOunces'),'9')

    def test_fill_requires_an_enabled_list_button_without_clicking_it(self):
        self.page.get_by_role('button',name='List',exact=True).evaluate('e=>e.disabled=true')
        result=self.fill()
        self.assertEqual(result['outcome'],'failed',result)
        self.assertFalse(result['submissionStarted'])
        self.assertEqual(self.page.evaluate('posts'),0)

    def test_packages_larger_than_shoebox_keep_entered_dimensions(self):
        self.item['packageDims']={'length':18,'width':12,'height':4}
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        values=self.page.evaluate('shippingValues')
        self.assertTrue(values['FitsInShoeboxNo']);self.assertEqual(values['InputLength'],'18')
        self.assertEqual(values['InputWidth'],'12');self.assertEqual(values['InputHeight'],'4')

    def test_suggested_currency_value_is_cleared_before_typing_reviewed_cents(self):
        self.masked_price=True;self.page.reload()
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.get_by_test_id('Price').input_value(),'24.99')

    def test_late_price_update_cannot_leave_an_automatic_floor_behind_off_switch(self):
        self.pricing_race=True;self.page.reload()
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.get_by_test_id('SmartPricingFloorPrice').input_value(),'')
        self.assertTrue(self.page.get_by_test_id('SmartPricingFloorPrice').is_hidden())
        self.assertEqual(self.page.get_by_test_id('Price').input_value(),'24.99')

    def test_smart_pricing_confirmation_is_completed_without_listing(self):
        self.smart_confirmation=True;self.page.reload()
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.locator('button[aria-pressed]').get_attribute('aria-pressed'),'false')
        self.assertEqual(self.page.evaluate('posts'),0)

    def test_configured_saved_address_is_selected_without_adding_an_address(self):
        self.address_picker=True;self.page.reload()
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.get_by_test_id('ShipsFrom').inner_text(),'12345')

    def test_two_saved_addresses_with_same_zip_require_review(self):
        self.address_picker=True;self.duplicate_address=True;self.page.reload()
        result=self.fill();self.assertEqual(result['outcome'],'failed',result)
        self.assertEqual(self.page.get_by_test_id('ShipsFrom').inner_text(),'99999')
        self.assertEqual(self.page.evaluate('posts'),0)

    def test_unbranded_accepts_sanitized_copy_only_after_explicit_approval(self):
        item={'brand':'Unbranded','title':'Heroes & Villains shirt','description':'Black cotton graphic shirt.'}
        with self.assertRaisesRegex(ValueError,'approve its No brand'):
            set_brand(self.page,item,{})
        self.assertEqual(set_brand(self.page,item,{'unlistedBrands':['Unbranded']}),{'fallback':True,'value':'Unbranded'})
        self.assertTrue(self.page.get_by_role('checkbox',name='No brand / Not sure',exact=True).is_checked())

    def test_brand_menu_is_closed_without_losing_the_selected_brand(self):
        self.page.set_content('''<input id="sellBrandId" oninput="brandMenu.hidden=false"
          onkeydown="if(event.key==='Escape')brandMenu.hidden=true">
          <div id="brandMenu" role="listbox" hidden><button role="option"
            onclick="document.getElementById('sellBrandId').value='Gildan'">Gildan</button></div>
          <button id="condition" onclick="window.conditionClicked=true">Condition</button>''')
        self.assertEqual(set_brand(self.page,{'brand':'Gildan'},{}),{'fallback':False,'value':'Gildan'})
        self.assertFalse(self.page.get_by_role('listbox').is_visible())
        self.assertEqual(self.page.locator('#sellBrandId').input_value(),'Gildan')
        self.page.locator('#condition').click()
        self.assertTrue(self.page.evaluate('window.conditionClicked'))

    def test_unlisted_brand_needs_explicit_approval_and_keeps_true_brand_in_copy(self):
        self.item.update(brand='Wild Oats',title='Wild Oats reviewed shirt',description='Wild Oats shirt with reviewed details and photographs.')
        result=self.fill();self.assertEqual(result['outcome'],'failed',result);self.assertIn('approve',result['reason'])
        self.page.reload();self.options['unlistedBrands']=['Wild Oats']
        result=self.fill();self.assertEqual(result['outcome'],'filled',result)
        self.assertTrue(self.page.get_by_role('checkbox',name='No brand / Not sure',exact=True).is_checked())
        self.assertEqual(self.page.get_by_test_id('Title').input_value(),self.item['title'])

    def test_known_brand_alias_is_selected_without_unbranded_fallback(self):
        for original,native,needs_alias_search in [('abercrombie and fitch','Abercrombie & Fitch',True),('Guess Jeans','Guess',False)]:
            with self.subTest(original=original):
                self.page.set_content('''<input id="sellBrandId"><div id="choices" role="listbox"></div>
                  <input type="checkbox" id="absent" aria-label="No brand / Not sure" checked>''')
                self.page.evaluate('''({original,native,needsAlias})=>{
                  const input=document.querySelector('#sellBrandId'),choices=document.querySelector('#choices');
                  input.oninput=()=>{choices.innerHTML='';const q=input.value;
                    if(q!==native&&(needsAlias||q!==original))return;
                    const button=document.createElement('button');button.setAttribute('role','option');button.textContent=native;
                    button.onclick=()=>{input.value=native;document.querySelector('#absent').checked=false;choices.innerHTML=''};
                    choices.append(button)};
                }''',{'original':original,'native':native,'needsAlias':needs_alias_search})
                item={'brand':original,'title':original+' shirt','description':original+' shirt'}
                self.assertEqual(set_brand(self.page,item,{}),{'fallback':False,'value':native})
                self.assertFalse(self.page.get_by_role('checkbox',name='No brand / Not sure',exact=True).is_checked())
                self.assertEqual(item['brand'],original)

    def test_ambiguous_brand_options_do_not_fall_back_to_no_brand(self):
        self.page.set_content('''<input id="sellBrandId"><div role="listbox">
          <button role="option">Gildan</button><button role="option">Gildan</button></div>
          <input type="checkbox" aria-label="No brand / Not sure">''')
        item={'brand':'Gildan','title':'Gildan shirt','description':'Gildan shirt'}
        with self.assertRaisesRegex(ValueError,'ambiguous'):
            set_brand(self.page,item,{'unlistedBrands':['Gildan']})
        self.assertFalse(self.page.get_by_role('checkbox',name='No brand / Not sure',exact=True).is_checked())

    def test_unlisted_brand_selects_exact_dropdown_option_before_covered_suggestion_chip(self):
        self.page.set_content('''<input id="sellBrandId" oninput="document.querySelector('[role=option]').hidden=this.value!=='No brand'">
          <button role="option" hidden onclick="document.getElementById('sellBrandId').value='No brand / Not sure';document.getElementById('-1').checked=true;this.hidden=true">No brand / Not sure</button>
          <div style="position:relative;width:200px;height:40px">
            <input id="-1" type="checkbox" aria-label="No brand / Not sure">
            <label for="-1" style="position:absolute;inset:0;background:white">No brand / Not sure</label>
          </div>''')
        item={'brand':'Wild Oats','title':'Wild Oats shirt','description':'Wild Oats shirt'}
        for _ in range(2):
            self.assertEqual(set_brand(self.page,item,{'unlistedBrands':['Wild Oats']}),{'fallback':True,'value':'Wild Oats'})
            self.assertTrue(self.page.get_by_role('checkbox',name='No brand / Not sure',exact=True).is_checked())
            self.assertEqual(self.page.locator('#sellBrandId').input_value(),'No brand / Not sure')

    def test_exact_browser_preview_fallback_preserves_dom_and_source(self):
        path=Path(self.folder.name,'textured-source.jpg');picture=Image.new('RGB',(320,480),(65,90,120))
        draw=ImageDraw.Draw(picture);draw.rectangle((85,130,115,150),fill=(235,210,200));draw.line((260,0,235,479),fill=(15,30,45),width=9)
        picture.save(path,'JPEG',quality=95);original=path.read_bytes()
        data=self.page.evaluate('''async source=>{const image=new Image();image.src=source;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=80;canvas.height=120;
          const context=canvas.getContext('2d');context.drawImage(image,0,0,80,120);
          return canvas.toDataURL('image/jpeg').split(',')[1]}''','data:image/jpeg;base64,'+base64.b64encode(original).decode())
        preview=base64.b64decode(data);before=self.page.content()
        wrong=Path(self.folder.name,'wrong.jpg');Image.new('RGB',(320,480),'green').save(wrong)
        with patch('black_cat_worker.mercari_native_form.image_matches',return_value=False):
            self.assertTrue(preview_matches(self.page,path,preview))
            self.assertFalse(preview_matches(self.page,wrong,preview))
            changed=Image.open(io.BytesIO(preview)).copy();ImageDraw.Draw(changed).rectangle((20,32,29,39),fill=(65,90,120))
            encoded=io.BytesIO();changed.save(encoded,'JPEG',quality=92)
            self.assertFalse(preview_matches(self.page,path,encoded.getvalue()))
        self.assertEqual(path.read_bytes(),original)
        self.assertEqual(self.page.content(),before)

    def test_browser_preview_fallback_does_not_accept_an_unmatched_crop(self):
        path=Path(self.folder.name,'portrait.jpg');Image.new('RGB',(320,480),'blue').save(path)
        encoded=io.BytesIO();Image.new('RGB',(80,80),'blue').save(encoded,'JPEG')
        with patch('black_cat_worker.mercari_native_form.image_matches',return_value=False), \
             patch.object(self.page,'evaluate') as rendered:
            self.assertFalse(preview_matches(self.page,path,encoded.getvalue()))
        rendered.assert_not_called()

    def test_matching_preview_does_not_need_browser_reproduction(self):
        with patch('black_cat_worker.mercari_native_form.image_matches',return_value=True), \
             patch.object(self.page,'evaluate') as rendered:
            self.assertTrue(preview_matches(self.page,self.photo,self.image))
        rendered.assert_not_called()

    def test_existing_previews_and_wrong_photo_content_are_rejected(self):
        attach_photos(self.page,[self.photo])
        with self.assertRaisesRegex(ValueError,'already contains'):attach_photos(self.page,[self.photo])
        buffer=io.BytesIO();Image.new('RGB',(80,80),'red').save(buffer,format='JPEG')
        self.assertFalse(image_matches(self.photo,buffer.getvalue()))

    def test_large_batch_sends_distinct_originals_once_in_verified_order(self):
        second=str(Path(self.folder.name,'second.jpg'));Image.new('RGB',(80,80),'red').save(second)
        photos=[self.photo,second];originals=[Path(p).read_bytes() for p in photos]
        send=Locator.set_input_files;selections=[];counts=[]
        def select(locator,files,**kwargs):
            selections.append(files)
            if isinstance(files,list):raise BrowserError('Cannot transfer files larger than 50Mb to a browser not co-located with the server')
            counts.append(self.page.get_by_test_id('PreviewThumbnail').count())
            send(locator,files,**kwargs)
            if files==second:raise BrowserTimeout('Selection still processing')
        with patch.object(Locator,'set_input_files',select):
            hashes=attach_photos(self.page,photos)
        self.assertEqual(selections,[photos,*photos]);self.assertEqual(counts,[0,1])
        self.assertEqual(len(hashes),2);self.assertNotEqual(hashes[0],hashes[1])
        self.assertEqual([Path(p).read_bytes() for p in photos],originals)

    def test_photo_batch_timeout_verifies_without_attaching_again(self):
        send=Locator.set_input_files;calls=[]
        def selected_then_timeout(locator,files,**kwargs):
            calls.append(files);send(locator,files,**kwargs);raise BrowserTimeout('Input timed out')
        with patch.object(Locator,'set_input_files',selected_then_timeout):
            self.assertEqual(len(attach_photos(self.page,[self.photo])),1)
        self.assertEqual(calls,[[self.photo]])

    def test_unrelated_photo_transfer_error_is_not_retried(self):
        with patch.object(Locator,'set_input_files',side_effect=BrowserError('File unreadable')) as send:
            with self.assertRaisesRegex(BrowserError,'File unreadable'):attach_photos(self.page,[self.photo])
        send.assert_called_once()

    def test_large_transfer_retry_requires_gallery_to_remain_empty(self):
        send=Locator.set_input_files;calls=[]
        def changed_gallery(locator,files,**kwargs):
            calls.append(files);send(locator,files,**kwargs)
            self.page.get_by_test_id('PreviewThumbnail').wait_for()
            raise BrowserError('Cannot transfer files larger than 50Mb to a browser not co-located with the server')
        with patch.object(Locator,'set_input_files',changed_gallery):
            with self.assertRaisesRegex(ValueError,'gallery changed'):attach_photos(self.page,[self.photo])
        self.assertEqual(calls,[[self.photo]])

    def test_owner_publication_requires_active_exact_record_price_and_matching_cover(self):
        filled={'title':self.item['title'],'price':self.item['price']}
        with patch('black_cat_worker.mercari_native_form.build_opener',return_value=SimpleNamespace(open=lambda *a,**k:io.BytesIO(self.image))):
            self.assertEqual(verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo),f'https://www.mercari.com/us/item/{ID}/')
            self.wrong_price=True
            with self.assertRaisesRegex(ValueError,'active price differs'):verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo)

    def test_a_published_listing_missing_an_approved_photo_is_not_verified(self):
        filled={'title':self.item['title'],'price':self.item['price'],'photoPaths':[self.photo,self.photo]}
        with patch('black_cat_worker.mercari_native_form.build_opener',return_value=SimpleNamespace(open=lambda *a,**k:io.BytesIO(self.image))):
            with self.assertRaises(AssertionError):verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo)

    def test_product_summary_accepts_only_the_reviewed_brand_suffix(self):
        self.public_brand_summary=True
        filled={'title':self.item['title'],'price':self.item['price'],'size':'M (8-10)','condition':'Good','brand':{'fallback':False,'value':'Gildan'}}
        with patch('black_cat_worker.mercari_native_form.build_opener',return_value=SimpleNamespace(open=lambda *a,**k:io.BytesIO(self.image))):
            self.assertEqual(verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo),f'https://www.mercari.com/us/item/{ID}/')
            filled['brand']['value']='Wrong brand'
            with self.assertRaises(AssertionError):verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo)

    def test_accessory_publication_still_checks_condition_without_a_size_field(self):
        self.public_summary_override='New | Gildan</p><p>New'
        filled={'title':self.item['title'],'price':self.item['price'],'size':None,'condition':'New','brand':{'fallback':False,'value':'Gildan'}}
        with patch('black_cat_worker.mercari_native_form.build_opener',return_value=SimpleNamespace(open=lambda *a,**k:io.BytesIO(self.image))):
            self.assertEqual(verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo),f'https://www.mercari.com/us/item/{ID}/')
            filled['condition']='Good'
            with self.assertRaises(AssertionError):verify_posted(self.page,f'https://www.mercari.com/us/item/{ID}/',filled,self.photo)


if __name__=='__main__':unittest.main()
