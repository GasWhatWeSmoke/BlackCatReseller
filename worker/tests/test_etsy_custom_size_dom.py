"""Local-only fixtures for one exact custom size with shared stock and pricing."""
from pathlib import Path
import io
import sys
import unittest
from playwright.sync_api import sync_playwright
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.etsy_custom_size import custom_size_value, custom_size_in_use, fill_custom_size, verify_custom_size
from black_cat_worker.etsy_form import fill_size, verify_native_size
from black_cat_worker.post_etsy import verify_live_listing


HTML = '''<main>
<input id="listing-price-input" value="59.99"><input id="listing-quantity-input" value="1"><input id="listing-sku-input" value="000122">
<select id="attributes-5-scale-select"><option value="-1">Choose a scale</option><option value="49">US letter</option></select>
<span id="addEntry" role="button" aria-label="Add variation"><button onclick="document.querySelector('#choose').showModal()">Add variation</button></span>
<button id="manageEntry" hidden onclick="openManager()">Manage variations</button><div id="table"></div>
</main>
<dialog id="choose" aria-label="Add variations"><button onclick="this.closest('dialog').close();document.querySelector('#edit').showModal()">Create your own</button></dialog>
<dialog id="edit" aria-label="Edit variations"><h1>Custom variation</h1>
<label>Name<input id="variationName"></label>
<label><input type="checkbox">Link photos to this variation</label>
<h2 id="optionCount">Options 0</h2><label>Add option<input id="optionValue"></label>
<button onclick="window.option=document.querySelector('#optionValue').value;document.querySelector('#optionCount').textContent='Options 1'">Add</button>
<button onclick="this.closest('dialog').close();openManager()">Done</button></dialog>
<dialog id="manager" aria-label="Manage variations"><h2>Manage variations</h2><div id="groups"></div>
<label><input id="pricesVary" type="checkbox">Prices vary</label>
<label><input type="checkbox">Processing profiles vary</label>
<label><input id="quantitiesVary" type="checkbox">Quantities vary</label>
<label><input type="checkbox">SKUs vary</label>
<button onclick="this.closest('dialog').close()">Cancel</button>
<button onclick="window.applies++;render();this.closest('dialog').close()">Apply</button></dialog>
<script>
window.option='';window.applies=0;
function openManager(){document.querySelector('#groups').innerHTML='<div role="group" aria-label="Size 1 option">Size 1 option <span>'+window.option+'</span><button aria-label="Edit"></button><button aria-label="Remove"></button></div>';document.querySelector('#manager').showModal()}
function render(){document.querySelector('#addEntry').hidden=true;document.querySelector('#manageEntry').hidden=false;
document.querySelector('#table').innerHTML='<table><thead><tr><th>Size</th><th>Visible</th></tr></thead><tbody><tr><th scope="row">'+window.option+'</th><td><input type="checkbox" checked disabled aria-label="Enabled status for variation row number: 1"></td></tr></tbody></table>'}
</script>'''


class EtsyCustomSizeDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_content(HTML)
        self.item = {'department':'Unisex Adults','itemType':'Jeans','size':'29','quantity':1,'price':59.99,'sku':'000122'}

    def tearDown(self):
        self.page.close()

    def test_only_reviewed_numeric_gender_neutral_jeans_use_this_mapping(self):
        self.assertEqual(custom_size_value(self.item), '29')
        for patch in [{'department':'Women'}, {'itemType':'T-shirt'}, {'size':'M'}, {'size':''}, {'size':'29.5'}]:
            self.assertIsNone(custom_size_value({**self.item, **patch}))

    def womens_pants_fixture(self, size='27'):
        self.item.update(department='Women',itemType='Pants',size=size)
        self.page.set_content(HTML)
        self.page.evaluate('''()=>{
          const scale=document.querySelector('select');scale.id='attributes-1-scale-select';
          const labels=['Choose a scale',"US women's numeric","US women's letter","UK women's","FR women's","DE women's","AU women's","JP women's","IN women's letter"];
          scale.innerHTML=labels.map((label,i)=>'<option value="'+(i===0?'-1':String(i))+'">'+label+'</option>').join('');
          document.querySelector('main').insertAdjacentHTML('beforeend',`<label>Size<input id="nativeSize" readonly onclick="sizes.hidden=false" onkeydown="if(event.key==='Escape')sizes.hidden=true"></label>
            <div id="sizes" hidden><button role="menuitemradio" onclick="nativeSize.value='26';sizes.hidden=true">26</button><button role="menuitemradio" onclick="nativeSize.value='28';sizes.hidden=true">28</button></div>`);
        }''')

    def test_missing_womens_pants_number_keeps_exact_custom_label_and_shared_inventory(self):
        self.womens_pants_fixture()
        self.assertEqual(custom_size_value(self.item),'27')
        self.assertFalse(custom_size_in_use(self.page,self.item))
        self.assertEqual(fill_size(self.page,self.item),'27')
        self.assertTrue(custom_size_in_use(self.page,self.item))
        verify_custom_size(self.page,self.item)
        self.assertEqual(fill_size(self.page,self.item),'27')
        self.assertEqual(self.page.evaluate('window.applies'),1)
        self.assertEqual(self.page.get_by_role('rowheader').all_inner_texts(),['27'])
        self.assertEqual(self.page.locator('#attributes-1-scale-select').input_value(),'-1')

    def test_existing_native_womens_pants_size_does_not_create_a_variation(self):
        self.womens_pants_fixture('26')
        self.assertEqual(fill_size(self.page,self.item),'26')
        self.assertFalse(custom_size_in_use(self.page,self.item))
        self.assertEqual(self.page.evaluate('window.applies'),0)
        verify_native_size(self.page,self.item)
        self.page.locator('#nativeSize').evaluate("e=>e.value='28'")
        with self.assertRaises(AssertionError):verify_native_size(self.page,self.item)

    def test_custom_fallback_still_rejects_changed_category_scales(self):
        self.womens_pants_fixture()
        self.page.locator('select').evaluate('''e=>e.insertAdjacentHTML('beforeend',"<option value='unexpected'>US men's numeric</option>")''')
        with self.assertRaisesRegex(ValueError,'different native scales'):
            fill_custom_size(self.page,self.item)
        self.assertEqual(self.page.evaluate('window.applies'),0)

    def test_womens_custom_size_must_survive_publication_reload(self):
        self.womens_pants_fixture();base=self.page.content()
        asset='https://i.etsystatic.com/1/r/il/a/123456/il_fullxfull.123456_a.jpg'
        image=io.BytesIO();Image.new('RGB',(8,8),'white').save(image,format='PNG')
        for persisted in [True,False]:
            def route(request):
                url=request.request.url
                if url.startswith('https://i.etsystatic.com/'):
                    request.fulfill(content_type='image/png',body=image.getvalue());return
                if '/tools/listings' in url:
                    html=f'''<main><input type="radio" name="item_status" value="active" checked><input placeholder="Search by title, tag, or SKU">
                      <a href="/your/shops/me/listing-editor/edit/12345"><p>Reviewed pants</p><img src="{asset}"></a></main>'''
                elif '/listing-editor/edit/' in url:
                    html=base+("<script>window.option='27';render()</script>" if persisted else '')
                else:
                    html=f'''<h1>Reviewed pants</h1><img class="carousel-image" src="{asset}"><form class="add-to-cart-form"><input type="hidden" name="listing_id" value="12345"><button type="button">Add to cart</button></form>'''
                request.fulfill(content_type='text/html',body=html)
            self.page.unroute_all();self.page.route('**/*',route)
            if persisted:
                self.assertEqual(verify_live_listing(self.page,'https://www.etsy.com/listing/12345','Reviewed pants','123456',sku=self.item['sku'],item=self.item,timeout=1000),'https://www.etsy.com/listing/12345')
            else:
                with self.assertRaises(AssertionError):
                    verify_live_listing(self.page,'https://www.etsy.com/listing/12345','Reviewed pants','123456',sku=self.item['sku'],item=self.item,timeout=1000)

    def test_exact_size_retains_shared_values_and_repeated_fill_adds_nothing(self):
        self.page.locator('#attributes-5-scale-select').select_option('49')
        self.assertEqual(fill_custom_size(self.page, self.item), '29')
        verify_custom_size(self.page, self.item)
        self.assertEqual(fill_custom_size(self.page, self.item), '29')
        self.assertEqual(self.page.evaluate('window.applies'), 1)
        self.assertEqual(self.page.get_by_role('rowheader').all_inner_texts(), ['29'])
        self.assertEqual(self.page.locator('#listing-price-input').input_value(), '59.99')
        self.assertEqual(self.page.locator('#listing-quantity-input').input_value(), '1')
        self.assertEqual(self.page.locator('#listing-sku-input').input_value(), '000122')
        self.assertEqual(self.page.locator('#attributes-5-scale-select').input_value(), '-1')

    def test_multiple_units_are_rejected_before_creating_variations(self):
        with self.assertRaisesRegex(ValueError, 'one item'):
            fill_custom_size(self.page, {**self.item, 'quantity':2})
        self.assertEqual(self.page.evaluate('window.applies'), 0)

    def test_changed_size_or_extra_row_cannot_pass_verification(self):
        for mutation in ["document.querySelector('tbody th').textContent='30'",
                         "document.querySelector('tbody').insertAdjacentHTML('beforeend','<tr><th scope=row>30</th><td></td></tr>')"]:
            self.page.set_content(HTML); fill_custom_size(self.page, self.item)
            self.page.evaluate(mutation)
            with self.assertRaises(AssertionError): verify_custom_size(self.page, self.item)

    def test_varying_inventory_or_changed_shared_values_are_rejected(self):
        for mutation in ["document.querySelector('#quantitiesVary').checked=true",
                         "document.querySelector('#listing-price-input').value='1.00'",
                         "document.querySelector('#listing-sku-input').value='000999'"]:
            self.page.set_content(HTML); fill_custom_size(self.page, self.item)
            self.page.evaluate(mutation)
            with self.assertRaises(AssertionError): verify_custom_size(self.page, self.item)

    def test_publication_reloads_and_verifies_persisted_custom_size(self):
        asset='https://i.etsystatic.com/1/r/il/a/123456/il_fullxfull.123456_a.jpg'
        image=io.BytesIO();Image.new('RGB',(8,8),'white').save(image,format='PNG')
        for stored_size in ['29','30']:
            visits=[]
            def route(request):
                url=request.request.url;visits.append(url)
                if url.startswith('https://i.etsystatic.com/'):
                    request.fulfill(content_type='image/png',body=image.getvalue());return
                if '/tools/listings' in url:
                    html=f'''<main><input type="radio" name="item_status" value="active" checked>
                      <input placeholder="Search by title, tag, or SKU">
                      <a href="/your/shops/me/listing-editor/edit/12345"><p>Reviewed jeans</p><img src="{asset}"></a></main>'''
                elif '/listing-editor/edit/' in url:
                    html=HTML+f"<script>window.option='{stored_size}';render()</script>"
                else:
                    html=f'''<h1>Reviewed jeans</h1><img class="carousel-image" src="{asset}">
                      <form class="add-to-cart-form"><input type="hidden" name="listing_id" value="12345">
                      <button type="button">Add to cart</button></form>'''
                request.fulfill(content_type='text/html',body=html)
            self.page.unroute_all()
            self.page.route('**/*',route)
            if stored_size=='29':
                result=verify_live_listing(self.page,'https://www.etsy.com/listing/12345','Reviewed jeans','123456',sku='000122',item=self.item,timeout=1000)
                self.assertEqual(result,'https://www.etsy.com/listing/12345')
            else:
                with self.assertRaises(AssertionError):
                    verify_live_listing(self.page,'https://www.etsy.com/listing/12345','Reviewed jeans','123456',sku='000122',item=self.item,timeout=1000)
            self.assertIn('https://www.etsy.com/your/shops/me/listing-editor/edit/12345',visits)
