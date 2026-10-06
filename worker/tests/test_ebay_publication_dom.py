"""eBay browser fixtures: no request reaches a marketplace."""
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright, Locator, TimeoutError as BrowserTimeout
from PIL import Image
from black_cat_worker import post_ebay as post
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.ebay_form import control, fill_description, fill_policy, fill_category, open_form, set_field, size_and_type, category_for


class EbayPublicationDomTests(unittest.TestCase):
    def test_boys_jeans_use_the_child_category_without_routing_unknown_children_to_men(self):
        from black_cat_worker.ebay_form import listing_department
        item={'department':'Boys','itemType':'Jeans','size':'8'}
        self.assertEqual(category_for(item),['Clothing, Shoes & Accessories','Kids','Boys',"Boys' Clothing (Sizes 4 & Up)",'Jeans'])
        self.assertEqual(listing_department(item),'Boys')
        for change in [{'size':'3T'},{'size':'2'},{'department':'Kids'},{'itemType':'Shirt'}]:
            with self.assertRaises(ValueError):category_for({**item,**change})

    def test_reviewed_juniors_title_selects_its_size_scale_without_converting_size(self):
        category=['Clothing, Shoes & Accessories','Women',"Women's Clothing",'Jeans']
        item={'size':'3','title':'L.e.i Ashley Womens Juniors Jeans Size 3','fit':'Regular'}
        self.assertEqual(size_and_type(item,category),('3','Juniors'))
        self.assertEqual(size_and_type({**item,'title':'Womens Jeans Size 3'},category),('3','Regular'))
        self.assertEqual(size_and_type(item,['Men',"Men's Clothing",'Jeans']),('3','Regular'))
        self.assertEqual(size_and_type({**item,'size':'6P'},category),('6','Petites'))

    def test_unisex_board_shorts_use_the_native_mens_swimwear_department(self):
        from black_cat_worker.ebay_form import listing_department
        item={'department':'Unisex','itemType':'Shorts','style':'Board Shorts'}
        self.assertEqual(listing_department(item),'Men')
        self.assertEqual(listing_department({**item,'department':'Women'}),'Women')
        self.assertEqual(listing_department({**item,'style':'Cargo'}),'Unisex Adults')

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        chrome = find_real_chrome()
        cls.browser = cls.pw.chromium.launch(headless=True, **({'executable_path':chrome} if chrome else {}))
        data=io.BytesIO();Image.new('RGB',(8,8),'blue').save(data,format='PNG');cls.image=data.getvalue()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.photos=[]
        for index in (1,2):
            photo=Path(self.directory.name,f'000001_0{index}.png');photo.write_bytes(self.image)
            self.photos.append(str(photo))
        self.context=self.browser.new_context();self.page=self.context.new_page()
        self.context.route('**/*',self.route)
        self.scenario='success';self.authorizations=0
        self.item={'sku':'000001','title':'Reviewed Brand Unisex Blue T-Shirt Size L','description':'Reviewed condition and measurements.',
                   'department':'Unisex Adults','itemType':'T-shirt','brand':'Brand','size':'L','color':'Blue','condition':'Good',
                   'quantity':1,'price':24.99,'weightOz':18,'packageDims':{'length':12,'width':9,'height':2}}

    def tearDown(self):
        self.context.close();self.directory.cleanup()

    def route(self,route):
        if 'i.ebayimg.com' in route.request.url:
            route.fulfill(content_type='image/png',body=self.image);return
        if '/itm/' in route.request.url:
            disabled='aria-disabled="true"' if self.scenario=='ended' else ''
            html=f'''<h1>{self.item['title']}</h1><div class="ux-image-carousel"><img src="https://i.ebayimg.com/images/g/PHOTO0/s-l1600.jpg"></div>
                <a href="#buy" {disabled}>Buy it now</a>'''
            second = 'WRONG' if self.scenario == 'wrong_photo' else 'PHOTO1'
            html=html.replace('</div>', f'<img data-zoom-src="https://i.ebayimg.com/images/g/{second}/s-l1600.webp"></div>', 1)
            price = 29.99 if self.scenario == 'wrong_price' else self.item['price']
            html+=f'<div class="x-price-primary">US ${price:.2f}</div>'
            if self.scenario in {'owner','wrong_owner'}:
                identifier = '999999999999' if self.scenario == 'wrong_owner' else '123456789012'
                html=html.replace('<a href="#buy" >Buy it now</a>',f'<div class="vim d-top-panel-message"><p>Your item is for sale</p></div><a href="https://www.ebay.com/sl/list?itemId={identifier}&amp;mode=ReviseItem">Revise listing</a>')
            html+='<nav aria-label="Breadcrumb"><a href="/b/Men">Men</a><a href="/b/T-Shirts">T-Shirts</a></nav>'
            html+='<section><h2>Item specifics</h2>'+''.join(f'<dl><dt>{label}</dt><dd>{value}</dd></dl>' for label,value in
                [('Brand','Brand'),('Department','Women' if self.scenario=='wrong_public_department' else 'Unisex Adults'),('Size','L'),('Color','Blue')])+'</section>'
            if self.scenario in {'public_inseam','wrong_public_inseam'}:
                inseam='32 in' if self.scenario=='wrong_public_inseam' else '31 in'
                html=html.replace('</section>',f'<dl><dt>Inseam</dt><dd>{inseam}</dd></dl></section>')
            if self.scenario in {'public_shell','wrong_public_shell'}:
                material='Polyester' if self.scenario=='wrong_public_shell' else 'Cotton'
                html=html.replace('</section>',f'<dl><dt>Outer Shell Material</dt><dd>{material}</dd></dl></section>')
            if self.scenario in {'public_style','wrong_public_style'}:
                style='Puffer Jacket' if self.scenario=='wrong_public_style' else 'Tapestry'
                html=html.replace('</section>',f'<dl><dt>Style</dt><dd>{style}</dd></dl></section>')
            if self.scenario == 'owner':
                html=html.replace('<section><h2>Item specifics</h2>', '<div class="ux-layout-section-module-evo"><h2>Item specifics</h2><dl>')
                html=html.replace('<dl><dt>', '<div><dt>').replace('</dd></dl>', '</dd></div>').replace('</section>', '</dl></div>')
        else:
            def field(label,identifier,value=''):
                return f'<label for="{identifier}">{label}</label><input id="{identifier}" value="{value}">'
            def select(label,identifier,values):
                return f'<label for="{identifier}">{label}</label><select id="{identifier}">'+''.join(f'<option>{value}</option>' for value in values)+'</select>'
            html='<main><section><h2>Title</h2>'+field('Title','title')+field('Custom label (SKU)','sku')+'</section>'
            html+='''<section><h2>Category</h2><p id="category-summary">Women > Tops</p><button aria-label="Edit category" onclick="showCategory()">Edit</button></section>
                <div role="dialog" style="display:none" id="category-dialog"></div>
                <section><h2>Photos &amp; video</h2><input id="photos" type="file" multiple><div id="gallery"></div></section>'''
            for label,identifier,values in [('Brand','brand',['Other','Brand']),('Department','department',['Women','Men','Unisex Adults']),
                    ('Size','size',['S','M','L']),('Color','color',['Red','Blue']),('Condition','condition',['New with tags','Pre-owned - Good']),
                    ('Format','format',['Auction','Fixed price']),('Shipping policy','shipping',['Standard shipping']),('Return policy','returns',['Standard returns'])]:
                html+=select(label,identifier,values)
            html+='<label for="description">Description</label><textarea id="description">Old description</textarea>'
            for label,identifier,value in [('Price','price','1'),('Quantity','quantity','3'),('Pounds','lbs','0'),('Ounces','oz','0'),
                                          ('Package length','length','0'),('Package width','width','0'),('Package height','height','0')]:
                html+=field(label,identifier,value)
            html+='''<label><input type="checkbox" id="promotion" checked>Promote your listing</label>
                <button onclick="localStorage.setItem('listed','yes');location.href='https://www.ebay.com/itm/123456789012'">List it</button></main>
                <script>
                const parts=['Clothing, Shoes & Accessories','Men',"Men's Clothing",'Shirts','T-Shirts'];let index=0;
                function showCategory(){index=0;document.querySelector('#category-dialog').style.display='block';nextCategory();}
                function nextCategory(){const d=document.querySelector('#category-dialog');d.innerHTML='';
                  const b=document.createElement('button');b.textContent=parts[index];d.append(b);b.onclick=()=>{
                    index++;if(index===parts.length){document.querySelector('#category-summary').textContent=parts.join(' > ');d.style.display='none';}
                    else nextCategory();};}
                document.querySelector('#photos').onchange=e=>{const g=document.querySelector('#gallery');
                  [...e.target.files].forEach(()=>{const i=g.children.length;const img=document.createElement('img');img.src='https://i.ebayimg.com/images/g/PHOTO'+i+'/s-l225.jpg';g.append(img);});};
                </script>'''
            if self.scenario=='changed_department':
                html+="<script>document.querySelector('#quantity').oninput=()=>document.querySelector('#department').value='Women';</script>"
            if self.scenario=='auction':
                html+="<script>document.querySelector('#quantity').oninput=()=>document.querySelector('#format').value='Auction';</script>"
        route.fulfill(content_type='text/html',body=html)

    def authorize(self): self.authorizations+=1

    def run_listing(self,mode='post'):
        self.page.goto(post.CREATE_URL)
        return post.run_on_page(self.page,self.item,self.photos,{},mode,self.authorize,
                                lambda *args:post.verify_listing(*args,timeout=500))

    def test_full_form_and_public_identity_are_verified(self):
        report=self.run_listing()
        self.assertEqual(report['outcome'],'posted',report)
        self.assertEqual(report['publishedPrice'],24.99)
        self.assertEqual(self.authorizations,2)

    def test_fill_check_sets_one_fixed_price_item_and_does_not_publish(self):
        report=self.run_listing('fill')
        self.assertEqual(report['outcome'],'filled',report)
        self.assertEqual(self.page.locator('#department').input_value(),'Unisex Adults')
        self.assertEqual(self.page.locator('#format').input_value(),'Fixed price')
        self.assertEqual(self.page.locator('#quantity').input_value(),'1')
        self.assertEqual(self.page.locator('#lbs').input_value(),'1')
        self.assertEqual(self.page.locator('#oz').input_value(),'2')
        self.assertFalse(self.page.locator('#promotion').is_checked())
        self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_plain_size_with_native_attribute_name_is_not_a_combined_size_type_menu(self):
        self.page.goto(post.CREATE_URL)
        self.page.get_by_label('Size',exact=True).evaluate("e=>e.setAttribute('name','attributes.Size')")
        report=post.run_on_page(self.page,self.item,self.photos,{},'fill',self.authorize)
        self.assertEqual(report['outcome'],'filled',report)
        self.assertEqual(self.authorizations,0)

    def test_package_pounds_only_preserves_the_entire_reviewed_weight(self):
        for weight, pounds in [(24, '1.5'), (18.5, '1.15625'), (0.5, '0.03125')]:
            with self.subTest(weight=weight):
                self.item['weightOz'] = weight
                self.page.goto(post.CREATE_URL)
                self.page.locator('#oz').evaluate('e=>e.remove()')
                report = post.run_on_page(self.page, self.item, self.photos, {}, 'fill', self.authorize)
                self.assertEqual(report['outcome'], 'filled', report)
                self.assertEqual(self.page.locator('#lbs').input_value(), pounds)
                self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_ounces_only_and_split_controls_preserve_fractional_ounces(self):
        for remove_pounds in [True, False]:
            with self.subTest(remove_pounds=remove_pounds):
                self.item['weightOz'] = 18.5
                self.page.goto(post.CREATE_URL)
                if remove_pounds: self.page.locator('#lbs').evaluate('e=>e.remove()')
                report = post.run_on_page(self.page, self.item, self.photos, {}, 'fill', self.authorize)
                self.assertEqual(report['outcome'], 'filled', report)
                self.assertEqual(self.page.locator('#oz').input_value(), '18.5' if remove_pounds else '2.5')
                if not remove_pounds: self.assertEqual(self.page.locator('#lbs').input_value(), '1')

    def test_package_policy_without_weight_or_dimension_controls_still_fills(self):
        self.page.goto(post.CREATE_URL)
        self.page.locator('#lbs, #oz, #length, #width, #height').evaluate_all('els=>els.forEach(e=>e.remove())')
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'fill', self.authorize)
        self.assertEqual(report['outcome'], 'filled', report)

    def test_package_pounds_control_that_rounds_the_weight_cannot_publish(self):
        self.item['weightOz'] = 24
        self.page.goto(post.CREATE_URL)
        self.page.locator('#oz').evaluate('e=>e.remove()')
        self.page.locator('#lbs').evaluate("e=>e.addEventListener('input',()=>{e.value=String(Math.floor(Number(e.value)))})")
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'post', self.authorize)
        self.assertEqual(report['outcome'], 'failed', report)
        self.assertFalse(report['submissionStarted'])
        self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_weight_changed_by_later_form_controls_cannot_publish(self):
        self.page.goto(post.CREATE_URL)
        self.page.locator('#promotion').evaluate("e=>e.addEventListener('change',()=>{document.querySelector('#lbs').value='0'})")
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'post', self.authorize)
        self.assertEqual(report['outcome'], 'failed', report)
        self.assertFalse(report['submissionStarted'])
        self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_dimensions_changed_by_later_form_controls_cannot_publish(self):
        for identifier in ['length', 'width', 'height']:
            with self.subTest(dimension=identifier):
                self.page.goto(post.CREATE_URL)
                self.page.evaluate('localStorage.clear()')
                self.page.locator('#promotion').evaluate("(e,id)=>e.addEventListener('change',()=>{document.getElementById(id).value='1'})", identifier)
                report = post.run_on_page(self.page, self.item, self.photos, {}, 'post', self.authorize)
                self.assertEqual(report['outcome'], 'failed', report)
                self.assertFalse(report['submissionStarted'])
                self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_controls_disappearing_after_fill_cannot_publish(self):
        self.page.goto(post.CREATE_URL)
        self.page.locator('#promotion').evaluate("e=>e.addEventListener('change',()=>{document.querySelector('#oz').remove()})")
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'post', self.authorize)
        self.assertEqual(report['outcome'], 'failed', report)
        self.assertFalse(report['submissionStarted'])
        self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_equivalent_numeric_formatting_after_fill_is_preserved(self):
        self.page.goto(post.CREATE_URL)
        self.page.locator('#promotion').evaluate("e=>e.addEventListener('change',()=>{document.querySelector('#lbs').value='1.0';document.querySelector('#length').value='12.00'})")
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'fill', self.authorize)
        self.assertEqual(report['outcome'], 'filled', report)

    def test_package_pounds_control_rejecting_fractions_cannot_publish(self):
        self.item['weightOz'] = 24
        self.page.goto(post.CREATE_URL)
        self.page.locator('#oz').evaluate('e=>e.remove()')
        self.page.locator('#lbs').evaluate("e=>{e.type='number';e.step='1'}")
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'post', self.authorize)
        self.assertEqual(report['outcome'], 'failed', report)
        self.assertFalse(report['submissionStarted'])
        self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_dimension_error_cannot_publish_even_if_its_value_matches(self):
        self.page.goto(post.CREATE_URL)
        self.page.locator('#promotion').evaluate("e=>e.addEventListener('change',()=>{document.querySelector('#length').setCustomValidity('Package is not supported')})")
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'post', self.authorize)
        self.assertEqual(report['outcome'], 'failed', report)
        self.assertFalse(report['submissionStarted'])
        self.assertIsNone(self.page.evaluate("localStorage.getItem('listed')"))

    def test_package_dimensions_revealed_by_weight_entry_are_filled_and_verified(self):
        self.page.goto(post.CREATE_URL)
        self.page.evaluate('''()=>{
          for(const id of ['length','width','height']) {
            document.querySelector('label[for="'+id+'"]').remove();document.getElementById(id).remove();
          }
          document.querySelector('#oz').addEventListener('input',()=>{
            for(const id of ['length','width','height']) document.querySelector('main').insertAdjacentHTML('beforeend',
              '<label for="'+id+'">Package '+id+'</label><input id="'+id+'" value="0">');
          },{once:true});
        }''')
        report = post.run_on_page(self.page, self.item, self.photos, {}, 'fill', self.authorize)
        self.assertEqual(report['outcome'], 'filled', report)
        for key, value in self.item['packageDims'].items():
            self.assertEqual(self.page.locator('#' + key).input_value(), str(value))
        self.assertFalse(report['submissionStarted'])

    def test_separate_size_type_retains_petites_despite_regular_garment_fit(self):
        self.item.update(department='Women',itemType='Shorts',size='6P',fit='Regular')
        self.page.goto(post.CREATE_URL)
        self.page.evaluate('''()=>{
          parts.splice(0,parts.length,'Clothing, Shoes & Accessories','Women',"Women's Clothing",'Shorts');
          document.querySelector('#size').innerHTML='<option>6</option>';
          document.querySelector('main').insertAdjacentHTML('beforeend','<label for="size-type">Size Type</label><select id="size-type"><option>Regular</option><option>Petites</option></select>');
        }''')
        report=post.run_on_page(self.page,self.item,self.photos,{},'fill',self.authorize)
        self.assertEqual(report['outcome'],'filled',report)
        self.assertEqual(self.page.get_by_label('Size',exact=True).input_value(),'6')
        self.assertEqual(self.page.get_by_label('Size Type',exact=True).input_value(),'Petites')
        self.assertFalse(report['submissionStarted'])

    def test_skirt_length_is_required_in_preflight_and_explicit_mini_copy_fills_short(self):
        for description,expected in [('A ruffled skirt.','failed'),('A geometric mini skirt.','filled')]:
            self.item.update(department='Women',itemType='Skirt',description=description)
            self.page.goto(post.CREATE_URL)
            self.page.evaluate('''()=>{
              parts.splice(0,parts.length,'Clothing, Shoes & Accessories','Women',"Women's Clothing",'Skirts');
              document.querySelector('main').insertAdjacentHTML('beforeend','<label for="skirt-length">Skirt Length</label><select id="skirt-length"><option></option><option>Short</option><option>Midi</option><option>Long</option></select>');
            }''')
            report=post.run_on_page(self.page,self.item,self.photos,{},'fill',self.authorize)
            self.assertEqual(report['outcome'],expected,report)
            self.assertFalse(report['submissionStarted'])
            if expected=='filled':self.assertEqual(self.page.get_by_label('Skirt Length',exact=True).input_value(),'Short')
            else:self.assertIn('Skirt Length',report['reason'])

    def test_reviewed_skirt_length_waits_for_the_late_native_control(self):
        self.item.update(department='Women',itemType='Skirt',description='A geometric mini skirt.')
        self.page.goto(post.CREATE_URL)
        self.page.evaluate('''()=>{
          parts.splice(0,parts.length,'Clothing, Shoes & Accessories','Women',"Women's Clothing",'Skirts');
          document.querySelector('#color').onchange=()=>setTimeout(()=>{
            document.querySelector('main').insertAdjacentHTML('beforeend','<label for="skirt-length">Skirt Length</label><select id="skirt-length"><option></option><option>Short</option><option>Midi</option></select>');
          },500);
        }''')
        report=post.run_on_page(self.page,self.item,self.photos,{},'fill',self.authorize)
        self.assertEqual(report['outcome'],'filled',report)
        self.assertEqual(self.page.get_by_label('Skirt Length',exact=True).input_value(),'Short')
        self.assertFalse(report['submissionStarted'])

    def test_changed_department_or_auction_never_reaches_list_it(self):
        for scenario in ['changed_department','auction']:
            self.scenario=scenario
            report=self.run_listing()
            self.assertEqual(report['outcome'],'failed')
            self.assertFalse(report['submissionStarted'])

    def test_unavailable_public_listing_stays_uncertain(self):
        self.scenario='ended'
        report=self.run_listing()
        self.assertEqual(report['outcome'],'failed')
        self.assertTrue(report['submissionStarted'])

    def test_wrong_published_specifics_are_not_reported_as_success(self):
        self.scenario='wrong_public_department'
        report=self.run_listing()
        self.assertEqual(report['outcome'],'failed')
        self.assertTrue(report['submissionStarted'])

    def test_public_skirt_length_must_match_the_verified_form(self):
        filled={'title':'Reviewed blue skirt','price':24.99,'category':['Clothing, Shoes & Accessories','Women',"Women's Clothing",'Skirts'],
                'specifics':{'Skirt Length':'Short'},'photoKeys':['PHOTO0']}
        for actual in ['Long','Short']:
            html=f'''<h1>Reviewed blue skirt</h1><div class="ux-image-carousel"><img src="https://i.ebayimg.com/images/g/PHOTO0/s-l1600.jpg"></div>
              <div class="x-price-primary">US $24.99</div><section><h2>Item specifics</h2><dl><dt>Skirt Length</dt><dd>{actual}</dd></dl></section>
              <nav aria-label="Breadcrumb"><a>Women</a><a>Skirts</a></nav><a href="#buy">Buy it now</a>'''
            self.page.route('**/itm/123456789012',lambda route:route.fulfill(content_type='text/html',body=html))
            if actual=='Long':
                with self.assertRaisesRegex(ValueError,'Skirt Length'):
                    post.verify_listing(self.page,'https://www.ebay.com/itm/123456789012',filled,'PHOTO0',timeout=1000)
            else:self.assertEqual(post.verify_listing(self.page,'https://www.ebay.com/itm/123456789012',filled,'PHOTO0',timeout=1000),'https://www.ebay.com/itm/123456789012')

    def test_dress_length_is_filled_from_reviewed_copy_or_held_before_publishing(self):
        for description,expected in [('A zebra print dress.','failed'),('A zebra print mini dress.','filled')]:
            self.item.update(department='Women',itemType='Dress',description=description)
            self.page.goto(post.CREATE_URL)
            self.page.evaluate('''()=>{
              parts.splice(0,parts.length,'Clothing, Shoes & Accessories','Women',"Women's Clothing",'Dresses');
              document.querySelector('main').insertAdjacentHTML('beforeend','<label for="dress-length">Dress Length</label><select id="dress-length"><option></option><option>Short</option><option>Midi</option><option>Long</option></select>');
            }''')
            report=post.run_on_page(self.page,self.item,self.photos,{},'fill',self.authorize)
            self.assertEqual(report['outcome'],expected,report)
            self.assertFalse(report['submissionStarted'])
            if expected=='filled':self.assertEqual(self.page.locator('#dress-length').input_value(),'Short')
            else:self.assertIn('Dress Length',report['reason'])

    def test_public_dress_length_must_match_the_verified_form(self):
        filled={'title':'Reviewed mini dress','price':24.99,'category':['Clothing, Shoes & Accessories','Women',"Women's Clothing",'Dresses'],
                'specifics':{'Dress Length':'Short'},'photoKeys':['PHOTO0']}
        for actual in ['Long','Short']:
            html=f'''<h1>Reviewed mini dress</h1><div class="ux-image-carousel"><img src="https://i.ebayimg.com/images/g/PHOTO0/s-l1600.jpg"></div>
              <div class="x-price-primary">US $24.99</div><section><h2>Item specifics</h2><dl><dt>Dress Length</dt><dd>{actual}</dd></dl></section>
              <nav aria-label="Breadcrumb"><a>Women</a><a>Dresses</a></nav><a href="#buy">Buy it now</a>'''
            self.page.route('**/itm/123456789012',lambda route:route.fulfill(content_type='text/html',body=html))
            if actual=='Long':
                with self.assertRaisesRegex(ValueError,'Dress Length'):
                    post.verify_listing(self.page,'https://www.ebay.com/itm/123456789012',filled,'PHOTO0',timeout=1000)
            else:self.assertEqual(post.verify_listing(self.page,'https://www.ebay.com/itm/123456789012',filled,'PHOTO0',timeout=1000),'https://www.ebay.com/itm/123456789012')

    def test_seller_owner_panel_proves_the_exact_listing_without_buy_button(self):
        self.scenario='owner'
        report=self.run_listing()
        self.assertEqual(report['outcome'],'posted',report)

    def test_boys_public_category_omits_editor_kids_level_but_still_requires_boys_and_jeans(self):
        filled={'title':'Reviewed Boys Jeans Size 8','price':24.99,
                'category':['Clothing, Shoes & Accessories','Kids','Boys',"Boys' Clothing (Sizes 4 & Up)",'Jeans'],
                'specifics':{'Department':'Boys','Size':'8'},'photoKeys':['PHOTO0']}
        for branch,leaf,valid in [('Boys','Jeans',True),('Girls','Jeans',False),('Men','Jeans',False),('Kids','Jeans',False),('Boys','Shorts',False)]:
            with self.subTest(branch=branch,leaf=leaf):
                html=f'''<h1>Reviewed Boys Jeans Size 8</h1><div class="ux-image-carousel"><img src="https://i.ebayimg.com/images/g/PHOTO0/s-l1600.jpg"></div>
                  <div class="x-price-primary">US $24.99</div><section><h2>Item specifics</h2><dl><dt>Department</dt><dd>Boys</dd><dt>Size</dt><dd>8</dd></dl></section>
                  <nav aria-label="Breadcrumb"><a>{branch}</a><a>{leaf}</a></nav><a href="#buy">Buy it now</a>'''
                self.page.route('**/itm/123456789012',lambda route:route.fulfill(content_type='text/html',body=html))
                if valid:
                    self.assertEqual(post.verify_listing(self.page,'https://www.ebay.com/itm/123456789012',filled,'PHOTO0',timeout=1000),'https://www.ebay.com/itm/123456789012')
                else:
                    with self.assertRaisesRegex(ValueError,'published category'):
                        post.verify_listing(self.page,'https://www.ebay.com/itm/123456789012',filled,'PHOTO0',timeout=1000)

    def test_confirmation_without_a_product_link_uses_exact_active_inventory(self):
        title=self.item['title']
        html=f'''<main><label>Search by title, SKU, or item number<input></label><table><tr>
            <td><a href="https://www.ebay.com/itm/123456789012">{title}</a></td></tr></table></main>'''
        self.context.route('**/sh/lst/active',lambda route:route.fulfill(content_type='text/html',body=html))
        self.page.set_content('<h2>Your listing is complete</h2>')
        self.assertEqual(post.submitted_url(self.page,title,timeout=20),'https://www.ebay.com/itm/123456789012')

    def test_transient_inventory_failure_retries_the_read_without_republishing(self):
        title=self.item['title'];reads=[]
        html=f'''<main><label>Search by title, SKU, or item number<input></label><table>
          <tr><td><img src="https://i.ebayimg.com/images/g/OLD/s-l140.jpg"><a href="https://www.ebay.com/itm/999999999999">{title}</a></td></tr>
          <tr><td><img src="https://i.ebayimg.com/images/g/NEW/s-l140.jpg"><a href="https://www.ebay.com/itm/123456789012">{title}</a></td></tr></table></main>'''
        def inventory(route):
            reads.append(route.request.url)
            route.fulfill(status=503 if len(reads)==1 else 200,content_type='text/html',body='Temporarily unavailable' if len(reads)==1 else html)
        self.context.route('**/sh/lst/active',inventory)
        self.page.goto(post.CREATE_URL)
        self.page.set_content('''<button onclick="localStorage.setItem('publishCount',String(Number(localStorage.getItem('publishCount')||0)+1));this.remove()">List it</button>''')
        self.page.get_by_role('button',name='List it',exact=True).click()
        self.assertEqual(post.submitted_url(self.page,title,timeout=20,cover='NEW'),'https://www.ebay.com/itm/123456789012')
        self.assertEqual(len(reads),2)
        self.assertEqual(self.page.evaluate("localStorage.getItem('publishCount')"),'1')

    def test_persistent_inventory_failure_stops_after_two_reads(self):
        reads=[]
        def inventory(route):
            reads.append(route.request.url);route.fulfill(status=503,content_type='text/html',body='Temporarily unavailable')
        self.context.route('**/sh/lst/active',inventory)
        self.page.goto(post.CREATE_URL)
        with self.assertRaisesRegex(ValueError,'remained unavailable'):
            post.submitted_url(self.page,self.item['title'],timeout=20)
        self.assertEqual(len(reads),2)
        self.assertEqual(self.authorizations,0)

    def test_inventory_verification_does_not_repeat_a_signin_or_challenge_redirect(self):
        for target in ['https://signin.ebay.com/','https://www.ebay.com/splashui/captcha']:
            with self.subTest(target=target):
                self.page.goto(post.CREATE_URL)
                def unavailable(page,marketplace):
                    page.goto(target)
                    raise ValueError('Seller inventory did not load; sign in to the selling account')
                with patch('black_cat_worker.seller_removal.open_inventory',side_effect=unavailable) as opened:
                    with self.assertRaisesRegex(ValueError,'sign in'):
                        post.submitted_url(self.page,self.item['title'],timeout=20)
                self.assertEqual(opened.call_count,1)
                self.assertEqual(self.authorizations,0)

    def test_inventory_search_omits_percent_but_requires_the_exact_published_title(self):
        title='Ocean Pacific Mens 100% Polyester Shorts Size L'
        html='''<main><label>Search by title, SKU, or item number<input
            onkeydown="if(event.key==='Enter' && this.value==='Ocean Pacific Mens 100 Polyester Shorts Size L')document.querySelector('tbody').hidden=false"></label>
            <table><tbody hidden><tr><td><a href="https://www.ebay.com/itm/999999999999">Ocean Pacific Mens 100% Polyester Shorts Size M</a></td></tr>
            <tr><td><a href="https://www.ebay.com/itm/123456789012">Ocean Pacific Mens 100% Polyester Shorts Size L</a></td></tr></tbody></table></main>'''
        self.context.route('**/sh/lst/active',lambda route:route.fulfill(content_type='text/html',body=html))
        self.page.set_content('<h2>Your listing is complete</h2>')
        self.assertEqual(post.submitted_url(self.page,title,timeout=20),'https://www.ebay.com/itm/123456789012')
        self.assertEqual(self.page.get_by_role('textbox').input_value(),title.replace('%',''))

    def test_identical_inventory_titles_bind_to_the_new_uploaded_cover(self):
        title=self.item['title']
        html=f'''<main><label>Search by title, SKU, or item number<input></label><table>
          <tr><td><img src="https://i.ebayimg.com/images/g/OLD/s-l140.jpg"><a href="https://www.ebay.com/itm/999999999999">{title}</a></td></tr>
          <tr><td><img src="https://i.ebayimg.com/images/g/NEW/s-l140.jpg"><a href="https://www.ebay.com/itm/123456789012">{title}</a></td></tr>
          </table></main>'''
        self.context.route('**/sh/lst/active',lambda route:route.fulfill(content_type='text/html',body=html))
        self.page.set_content('<h2>Your listing is complete</h2>')
        self.assertEqual(post.submitted_url(self.page,title,timeout=20,cover='NEW'),'https://www.ebay.com/itm/123456789012')

    def test_identical_title_and_cover_rows_remain_ambiguous(self):
        title=self.item['title']
        rows=''.join(f'<tr><td><img src="https://i.ebayimg.com/images/g/SAME/s-l140.jpg"><a href="https://www.ebay.com/itm/{identifier}">{title}</a></td></tr>' for identifier in ['123456789012','999999999999'])
        html=f'<main><label>Search by title, SKU, or item number<input></label><table>{rows}</table></main>'
        self.context.route('**/sh/lst/active',lambda route:route.fulfill(content_type='text/html',body=html))
        self.page.set_content('<h2>Your listing is complete</h2>')
        with self.assertRaisesRegex(ValueError,'multiple matching title and cover'):
            post.submitted_url(self.page,title,timeout=20,cover='SAME')

    def test_ended_owner_page_has_no_product_h1_and_must_identify_the_same_item(self):
        self.page.goto('https://www.ebay.com/itm/123456789012')
        self.page.set_content('''<div class="ux-layout-section__textual-display--statusMessage">
            You ended this listing on September 11 because there was an error in the listing.
            <a href="https://www.ebay.com/sl/list?itemId=123456789012&amp;mode=RelistItem">Relist</a></div>
            <h2>Similar items</h2>''')
        self.assertEqual(post.listing_availability(self.page,'123456789012')[0],'unavailable')
        self.page.locator('a').evaluate("e=>e.href='https://www.ebay.com/sl/list?itemId=999999999999&mode=RelistItem'")
        with self.assertRaisesRegex(ValueError,'different listing'):
            post.listing_availability(self.page,'123456789012')

    def test_wrong_price_photo_or_owner_identity_is_not_reported_as_success(self):
        for scenario in ['wrong_price','wrong_photo','wrong_owner']:
            with self.subTest(scenario=scenario):
                self.scenario=scenario
                report=self.run_listing()
                self.assertEqual(report['outcome'],'failed',report)
                self.assertTrue(report['submissionStarted'])

    def test_description_uses_the_rich_text_frame_without_inserting_html(self):
        self.page.set_content('''<iframe title="Description" aria-label="Description"
            srcdoc="<div contenteditable='true'>Old description</div>"></iframe>''')
        text = 'Reviewed details\nSize < 30 inches'
        fill_description(self.page, text)
        self.assertEqual(self.page.frame_locator('iframe').locator('[contenteditable]').inner_text(), text)

    def test_guided_start_uses_no_catalog_match_and_reviewed_condition(self):
        self.page.set_content('''
          <div id="start"><label>What are you selling?<input id="query"></label>
            <button onclick="window.queryUsed=document.querySelector('#query').value;start.hidden=true;match.hidden=false">Get started</button></div>
          <div id="match" hidden><button onclick="match.hidden=true;condition.hidden=false">Continue without match</button></div>
          <div id="condition" hidden><h2>Condition</h2>
            <button onclick="window.chosenCondition='Good'">Pre-owned - Good</button>
            <button onclick="condition.hidden=true;editor.hidden=false">Continue</button></div>
          <div id="editor" hidden><label>Title<input></label></div>''')
        open_form(self.page,self.item)
        self.assertEqual(self.page.evaluate('window.queryUsed'),self.item['title'])
        self.assertEqual(self.page.evaluate('window.chosenCondition'),'Good')

    def test_prelisting_category_is_chosen_before_disabled_continue_without_match(self):
        self.page.set_content('''<div id="category" role="dialog"><h2>Category</h2>
          <input placeholder="Enter a category value">
          <button onclick="window.branch='Men'">Clothing, Shoes &amp; Accessories &gt; Men &gt; Men's Clothing &gt; Shirts &gt; T-Shirts</button>
          <button onclick="window.branch='Women'">Clothing, Shoes &amp; Accessories &gt; Women &gt; Women's Clothing &gt; Tops</button>
          <button onclick="category.hidden=true;document.querySelector('#next').disabled=false">Done</button></div>
          <button id="next" disabled onclick="this.hidden=true;editor.hidden=false">Continue without match</button>
          <div id="editor" hidden><label>Title<input></label></div>''')
        item={**self.item,'department':'Women','itemType':'T-shirt'}
        open_form(self.page,item)
        self.assertEqual(self.page.evaluate('window.branch'),'Women')
        self.assertTrue(self.page.get_by_label('Title',exact=True).is_visible())
        self.assertEqual(self.authorizations,0)

    def test_category_dialog_arriving_after_disabled_continue_is_rechecked(self):
        self.page.set_content('''<div id="category" role="dialog" hidden><h2>Category</h2>
          <input placeholder="Enter a category value">
          <button onclick="window.branch='Women'">Clothing, Shoes &amp; Accessories &gt; Women &gt; Women's Clothing &gt; Tops</button>
          <button onclick="category.hidden=true;document.querySelector('#next').disabled=false">Done</button></div>
          <button id="next" disabled onclick="this.hidden=true;editor.hidden=false">Continue without match</button>
          <div id="editor" hidden><label>Title<input></label></div>
          <script>setTimeout(()=>category.hidden=false,500)</script>''')
        item={**self.item,'department':'Women','itemType':'T-shirt'}
        open_form(self.page,item)
        self.assertEqual(self.page.evaluate('window.branch'),'Women')
        self.assertTrue(self.page.get_by_label('Title',exact=True).is_visible())

    def test_category_branch_keeps_its_scope_after_search_input_disappears(self):
        from black_cat_worker.ebay_form import prelisting_category
        self.page.set_content('''<button onclick="window.unrelated=true">Men</button>
          <div role="dialog" id="category"><input placeholder="Enter a category value"></div><script>
          const path=['Clothing, Shoes & Accessories','Men',"Men's Clothing",'Shirts','T-Shirts'];
          window.chosen=[];let index=0;
          function choices(){const button=document.createElement('button');button.textContent=path[index];category.append(button);
            button.onclick=()=>{chosen.push(path[index++]);category.innerHTML='';if(index<path.length)choices();else{
              const done=document.createElement('button');done.textContent='Done';done.onclick=()=>category.hidden=true;category.append(done)}}}
          choices();</script>''')
        self.assertTrue(prelisting_category(self.page,self.item))
        self.assertEqual(self.page.evaluate('window.chosen'),category_for(self.item))
        self.assertIsNone(self.page.evaluate('window.unrelated'))

    def test_native_specifics_expansion_exposes_fields_without_other_show_more_controls(self):
        from black_cat_worker.ebay_form import expand_specifics
        self.page.set_content('''<button onclick="window.unrelated=true">Show more</button>
          <div class="summary__attributes--container"><div id="fields" hidden><label>Brand<input></label></div>
          <button aria-expanded="false" onclick="fields.hidden=false;this.setAttribute('aria-expanded','true');this.textContent='Show less';window.expansions=(window.expansions||0)+1">Show more</button></div>''')
        expand_specifics(self.page)
        self.assertTrue(self.page.get_by_label('Brand',exact=True).is_visible())
        expand_specifics(self.page)
        self.assertEqual(self.page.evaluate('window.expansions'),1)
        self.assertIsNone(self.page.evaluate('window.unrelated'))

    def test_existing_category_breadcrumb_returns_to_root_before_selecting_a_new_path(self):
        self.page.set_content('''<section><h2>Category</h2><p id="summary">Clothing, Shoes &amp; Accessories &gt; Men &gt; Men's Clothing &gt; Shorts</p>
          <button onclick="dialog.hidden=false">Edit category</button></section>
          <div id="dialog" role="dialog" hidden>
            <div id="primary"><button onclick="primary.hidden=true;selected.hidden=false">First category Shorts</button></div>
            <div id="selected" hidden><span>Selected</span><button onclick="selected.hidden=true;root.hidden=false">Clothing, Shoes &amp; Accessories</button></div>
            <div id="root" hidden><button onclick="window.rootChosen=true;root.hidden=true;categoryChoices.hidden=false">Clothing, Shoes &amp; Accessories</button></div>
            <div id="categoryChoices" hidden><button>Men</button><button>Men's Clothing</button>
              <button onclick="summary.textContent='Men Swimwear'">Swimwear</button></div>
            <button onclick="dialog.hidden=true">Done</button></div>''')
        item={**self.item,'department':'Men','itemType':'Shorts','style':'Board Shorts'}
        self.assertEqual(fill_category(self.page,item)[-1],'Swimwear')
        self.assertTrue(self.page.evaluate('window.rootChosen'))
        self.assertEqual(self.authorizations,0)

    def test_category_breadcrumb_is_scoped_when_root_choice_is_also_visible(self):
        self.page.set_content('''<section><h2>Category</h2><p id="summary">Men T-Shirts</p>
          <button onclick="dialog.hidden=false">Edit category</button></section>
          <div id="dialog" role="dialog" hidden>
            <div class="category-picker__selected-nodes" id="selected"><span>Selected</span>
              <button onclick="window.returnedToRoot=true;selected.hidden=true">Clothing, Shoes &amp; Accessories</button></div>
            <button onclick="if(!window.returnedToRoot)window.wrongRoot=true;window.rootChosen=true">Clothing, Shoes &amp; Accessories</button>
            <button>Women</button><button>Women's Clothing</button>
            <button onclick="summary.textContent=&quot;Women Tops&quot;">Tops</button>
            <button onclick="dialog.hidden=true">Done</button></div>''')
        item={**self.item,'department':'Women','itemType':'Long Sleeve T-shirt'}
        self.assertEqual(fill_category(self.page,item)[-1],'Tops')
        self.assertTrue(self.page.evaluate('window.returnedToRoot'))
        self.assertTrue(self.page.evaluate('window.rootChosen'))
        self.assertIsNone(self.page.evaluate('window.wrongRoot'))
        self.assertEqual(self.authorizations,0)

    def test_jeans_without_reviewed_inseam_stop_before_opening_or_uploading(self):
        item={**self.item,'itemType':'Jeans','size':'29','inseam':''}
        with patch.object(post,'open_form') as opened, patch.object(post,'attach_photos') as attached:
            result=post.run_on_page(self.page,item,self.photos,{},'post',self.authorize)
        self.assertEqual(result['outcome'],'failed')
        self.assertFalse(result['submissionStarted'])
        self.assertIn('reviewed inseam',result['reason'])
        opened.assert_not_called();attached.assert_not_called()
        self.assertEqual(self.authorizations,0)

    def test_outerwear_without_reviewed_material_stops_before_opening_or_uploading(self):
        item={**self.item,'itemType':'Jacket','material':None}
        with patch.object(post,'open_form') as opened, patch.object(post,'attach_photos') as attached:
            result=post.run_on_page(self.page,item,self.photos,{},'post',self.authorize)
        self.assertEqual(result['outcome'],'failed');self.assertFalse(result['submissionStarted'])
        self.assertIn('outer shell material',result['reason'])
        opened.assert_not_called();attached.assert_not_called();self.assertEqual(self.authorizations,0)

    def test_native_outer_shell_material_is_filled_in_its_own_control(self):
        from black_cat_worker.ebay_form import fill_listing_fields,verify_listing_fields
        self.page.goto(post.CREATE_URL)
        self.page.evaluate('''()=>document.querySelector('main').insertAdjacentHTML('beforeend',
          '<label for="shell">Outer Shell Material</label><select id="shell"><option value="">Select</option><option>Cotton</option><option>Polyester</option></select>')''')
        item={**self.item,'itemType':'Jacket','material':'Cotton'}
        with patch('black_cat_worker.ebay_form.fill_category',return_value=category_for(item)):
            filled=fill_listing_fields(self.page,item,{})
        self.assertEqual(filled['specifics']['Outer Shell Material'],'Cotton')
        self.assertEqual(self.page.get_by_label('Outer Shell Material').input_value(),'Cotton')
        self.page.get_by_label('Outer Shell Material').select_option('')
        with self.assertRaisesRegex(ValueError,'outer shell material changed'):
            verify_listing_fields(self.page,item,filled)
        self.assertEqual(self.authorizations,0)

    def test_published_outer_shell_material_must_match_the_reviewed_value(self):
        filled={'title':self.item['title'],'price':self.item['price'],'category':category_for(self.item),
                'specifics':{'Outer Shell Material':'Cotton'},'photoKeys':['PHOTO0','PHOTO1']}
        url='https://www.ebay.com/itm/123456789012'
        self.scenario='wrong_public_shell'
        with self.assertRaisesRegex(ValueError,'published Outer Shell Material'):
            post.verify_listing(self.page,url,filled,'PHOTO0')
        self.scenario='public_shell'
        self.assertEqual(post.verify_listing(self.page,url,filled,'PHOTO0'),url)

    def test_native_jeans_inseam_is_filled_with_its_reviewed_units(self):
        from black_cat_worker.ebay_form import fill_listing_fields
        self.page.goto(post.CREATE_URL)
        self.page.get_by_label('Size',exact=True).evaluate("e=>e.add(new Option('29','29'))")
        self.page.evaluate('''()=>document.querySelector('main').insertAdjacentHTML('beforeend',
          '<label for="inseam">Inseam</label><select id="inseam"><option value="">Select</option><option>31 in</option><option>32 in</option></select>')''')
        item={**self.item,'itemType':'Jeans','size':'29','inseam':'31'}
        with patch('black_cat_worker.ebay_form.fill_category',return_value=category_for(item)):
            filled=fill_listing_fields(self.page,item,{})
        self.assertEqual(filled['specifics']['Inseam'],'31 in')
        self.assertEqual(self.page.get_by_label('Inseam',exact=True).input_value(),'31 in')
        self.assertEqual(self.authorizations,0)

    def test_boys_native_size_button_does_not_require_an_adult_regular_group(self):
        from black_cat_worker.ebay_form import fill_listing_fields
        self.page.goto(post.CREATE_URL)
        self.page.get_by_label('Department',exact=True).evaluate("e=>e.add(new Option('Boys','Boys'))")
        self.page.get_by_label('Size',exact=True).evaluate('''e=>e.outerHTML=`
          <button id="size" name="attributes.Size" aria-label="Size" aria-controls="kidsizes" onclick="kidsizes.hidden=false">Select</button>
          <div id="kidsizes" role="listbox" hidden><button role="option" onclick="document.querySelector('#size').textContent='8';kidsizes.hidden=true">8</button></div>`''')
        self.page.evaluate('''()=>document.querySelector('main').insertAdjacentHTML('beforeend',
          '<label>Inseam<input value=""></label>')''')
        item={**self.item,'department':'Boys','itemType':'Jeans','size':'8','inseam':'23.5'}
        with patch('black_cat_worker.ebay_form.fill_category',return_value=category_for(item)):
            filled=fill_listing_fields(self.page,item,{})
        self.assertEqual(filled['specifics']['Department'],'Boys')
        self.assertEqual(filled['specifics']['Size'],'8');self.assertFalse(filled['combinedSize'])
        self.assertNotIn('Size Type',filled['specifics']);self.assertEqual(self.authorizations,0)

    def test_empty_button_inseam_cannot_pass_final_jeans_verification(self):
        from black_cat_worker.ebay_form import verify_listing_fields
        self.page.set_content('<button name="attributes.Inseam" aria-label="Inseam"></button>')
        item={**self.item,'itemType':'Jeans','size':'29','inseam':'31'}
        with self.assertRaisesRegex(ValueError,'inseam'):
            verify_listing_fields(self.page,item,{'category':category_for(item)})

    def test_required_native_specifics_stop_on_empty_buttons_but_ignore_optional_fields(self):
        from black_cat_worker.ebay_form import verify_required_specifics
        self.page.set_content('''<fieldset class="summary__attributes--section-container"><legend>Essential</legend>
          <div class="summary__attributes--field"><div class="summary__attributes--label required-field">Style</div>
            <div class="summary__attributes--value"><button name="attributes.Style"></button></div></div>
          <div class="summary__attributes--field"><div class="summary__attributes--label">Chest Size</div>
            <div class="summary__attributes--value"><button name="attributes.Chest Size"></button></div></div></fieldset>''')
        with self.assertRaisesRegex(ValueError,'still requires item specifics: Style'):
            verify_required_specifics(self.page)
        self.page.locator('button[name="attributes.Style"]').evaluate("e=>e.textContent='Tapestry'")
        verify_required_specifics(self.page)

    def test_required_department_accepts_its_linked_native_value_but_not_an_empty_one(self):
        from black_cat_worker.ebay_form import verify_required_specifics
        self.page.set_content('''<div class="summary__attributes--field">
          <div class="summary__attributes--label required-field"><button class="tooltip__host" id="dept-label">Department</button></div>
          <div class="summary__attributes--value"><button aria-describedby="dept-label" disabled>Boys</button></div></div>''')
        verify_required_specifics(self.page)
        self.page.locator('button[aria-describedby]').evaluate("e=>e.textContent=''")
        with self.assertRaisesRegex(ValueError,'still requires item specifics: Department'):
            verify_required_specifics(self.page)

    def test_required_specifics_reject_ambiguous_controls_and_ignore_hidden_rows(self):
        from black_cat_worker.ebay_form import verify_required_specifics
        self.page.set_content('''<div class="summary__attributes--field"><div class="summary__attributes--label required-field">Style</div>
          <div class="summary__attributes--value"><button name="attributes.Style">Tapestry</button><button name="attributes.Style">Other</button></div></div>''')
        with self.assertRaisesRegex(ValueError,'could not be identified: Style'):
            verify_required_specifics(self.page)
        self.page.locator('.summary__attributes--field').evaluate('e=>e.hidden=true')
        verify_required_specifics(self.page)

    def test_published_style_must_match_the_reviewed_value(self):
        filled={'title':self.item['title'],'price':self.item['price'],'category':category_for(self.item),
                'specifics':{'Style':'Tapestry'},'photoKeys':['PHOTO0','PHOTO1']}
        url='https://www.ebay.com/itm/123456789012'
        self.scenario='wrong_public_style'
        with self.assertRaisesRegex(ValueError,'published Style'):
            post.verify_listing(self.page,url,filled,'PHOTO0')
        self.scenario='public_style'
        self.assertEqual(post.verify_listing(self.page,url,filled,'PHOTO0'),url)

    def test_published_inseam_must_match_the_reviewed_measurement(self):
        filled={'title':self.item['title'],'price':self.item['price'],'category':category_for(self.item),
                'specifics':{'Inseam':'31 in'},'photoKeys':['PHOTO0','PHOTO1']}
        url='https://www.ebay.com/itm/123456789012'
        self.scenario='wrong_public_inseam'
        with self.assertRaisesRegex(ValueError,'published Inseam'):
            post.verify_listing(self.page,url,filled,'PHOTO0')
        self.scenario='public_inseam'
        self.assertEqual(post.verify_listing(self.page,url,filled,'PHOTO0'),url)

    def test_sign_in_is_reported_without_entering_listing_data(self):
        self.page.goto('https://signin.ebay.com/')
        with self.assertRaisesRegex(ValueError,'Sign into eBay'):
            open_form(self.page,self.item)

    def test_verification_is_not_classified_as_a_retryable_loading_timeout(self):
        self.page.goto('https://www.ebay.com/splashui/captcha')
        with self.assertRaisesRegex(ValueError,'account verification'):
            open_form(self.page,self.item)
        self.assertEqual(self.authorizations,0)

    def test_loading_deadline_is_a_timeout_before_any_submission(self):
        with patch('black_cat_worker.ebay_form.monotonic',side_effect=[0,91]):
            with self.assertRaisesRegex(BrowserTimeout,'did not finish loading'):
                open_form(self.page,self.item)
        self.assertEqual(self.authorizations,0)

    def test_guided_new_used_dialog_preserves_the_reviewed_grade_for_the_editor(self):
        self.page.set_content('''<div id="condition" role="dialog"><h2>Select the condition of your item</h2>
          <label><input type="radio" name="condition" value="new">New</label>
          <label><input type="radio" name="condition" value="used">Used</label>
          <button onclick="condition.hidden=true;editor.hidden=false">Continue to listing</button></div>
          <div id="editor" hidden><label>Title<input></label></div>''')
        open_form(self.page,self.item)
        self.assertTrue(self.page.locator('input[value=used]').is_checked())
        self.assertEqual(self.item['condition'],'Good')

    def test_seller_hub_create_link_enters_the_current_prelisting_search(self):
        self.page.route('**/sh/lst/active',lambda route:route.fulfill(content_type='text/html',body='''
          <a hidden href="/sl/sell?sr=shListingsTopNav">Create listing</a>
          <a href="/sl/sell?sr=shListingsCTA">Create listing</a>'''))
        self.page.route('**/sl/sell?sr=shListingsCTA',lambda route:route.fulfill(content_type='text/html',body='''
          <form onsubmit="event.preventDefault();window.submittedTitle=document.querySelector('input').value;this.hidden=true;document.querySelector('#editor').hidden=false">
          <input aria-label="Enter brand, model, description, etc."><button>Search</button></form>
          <div id="editor" hidden><label>Title<input></label></div>'''))
        self.page.goto('https://www.ebay.com/sh/lst/active')
        open_form(self.page,self.item)
        self.assertEqual(self.page.evaluate('window.submittedTitle'),self.item['title'])
        self.assertEqual(self.authorizations,0)

    def test_initial_search_transition_does_not_require_pressing_enter_on_a_removed_input(self):
        self.page.set_content('''<div id="start"><input aria-label="Enter brand, model, description, etc."
          oninput="start.hidden=true;editor.hidden=false"></div>
          <div id="editor" hidden><label>Title<input></label></div>''')
        open_form(self.page,self.item)
        self.assertTrue(self.page.get_by_label('Title',exact=True).is_visible())
        self.assertEqual(self.authorizations,0)

    def test_search_navigation_during_fill_continues_to_the_new_editor(self):
        self.page.set_content('''<div id="start"><input aria-label="Enter brand, model, description, etc."></div>
          <div id="editor" hidden><label>Title<input></label></div>''')
        original = Locator.fill
        def navigated(locator, value, **kwargs):
            self.page.evaluate('start.hidden=true;editor.hidden=false')
            return original(locator, value, timeout=100)
        with patch.object(Locator,'fill',navigated):
            open_form(self.page,self.item)
        self.assertTrue(self.page.get_by_label('Title',exact=True).is_visible())
        self.assertEqual(self.authorizations,0)

    def test_seller_hub_does_not_follow_a_create_link_to_another_site(self):
        self.page.route('**/sh/lst/active',lambda route:route.fulfill(content_type='text/html',body='<a href="https://example.test/sl/sell">Create listing</a>'))
        self.page.goto('https://www.ebay.com/sh/lst/active')
        with self.assertRaisesRegex(ValueError,'expected selling entry'):open_form(self.page,self.item)

    def test_essential_specific_uses_described_value_button_not_tooltip(self):
        self.page.set_content('''<div class="summary__attributes--label">
            <button id="department-label" class="tooltip__host"><span>Department</span></button></div>
            <button id="department-value" aria-describedby="hint department-label"
              onclick="document.querySelector('#choices').hidden=false">Men</button>
            <div id="choices" role="listbox" hidden><button role="option"
              onclick="document.querySelector('#department-value').textContent='Unisex Adults';this.parentElement.hidden=true">Unisex Adults</button></div>''')
        self.assertEqual(control(self.page,['Department']).get_attribute('id'),'department-value')
        self.assertEqual(set_field(self.page,['Department'],'Unisex Adults'),'Unisex Adults')
        self.assertTrue(self.page.locator('#choices').is_hidden())

    def test_already_reviewed_combined_size_does_not_reopen_a_rebuilding_menu(self):
        self.page.set_content('''<button name="attributes.Size" onclick="throw Error('must retain the verified size')">Regular - M</button>''')
        self.assertEqual(set_field(self.page,['Size'],'M',group='Regular'),'M')

    def test_duplicate_described_controls_stop_before_changing_anything(self):
        self.page.set_content('''<div class="summary__attributes--label">
            <button id="size-label" class="tooltip__host">Size</button></div>
            <button aria-describedby="size-label">M</button><button aria-describedby="size-label">L</button>''')
        with self.assertRaisesRegex(ValueError,'multiple visible Size'):
            set_field(self.page,['Size'],'L')

    def test_transient_duplicate_color_options_are_never_selected_until_unique(self):
        self.page.set_content('''<button id="color" name="attributes.Color" aria-controls="colors"
          onclick="colors.hidden=false" onkeydown="if(event.key==='Escape'){document.querySelector('#duplicate')?.remove();colors.hidden=true}"></button>
          <div id="colors" role="listbox" hidden><button role="option" onclick="window.choices=(window.choices||0)+1;color.textContent='Black';colors.hidden=true">Black</button>
          <button id="duplicate" role="option" onclick="window.wrong=true">Black</button></div>''')
        self.assertEqual(set_field(self.page,['Color'],'Black'),'Black')
        self.assertEqual(self.page.evaluate('window.choices'),1)
        self.assertIsNone(self.page.evaluate('window.wrong'))

    def test_delayed_brand_commit_is_retained_without_uploading_or_selecting_again(self):
        self.page.set_content('''<button id="brand" name="attributes.Brand" aria-controls="brands" onclick="brands.hidden=false"></button>
          <div id="brands" role="listbox" hidden><button role="option" onclick="window.choices=(window.choices||0)+1;brands.hidden=true;setTimeout(()=>brand.textContent='LandLubber',150)">LandLubber</button></div>''')
        self.assertEqual(set_field(self.page,['Brand'],'LandLubber'),'LandLubber')
        self.assertEqual(self.page.evaluate('window.choices'),1)

    def test_petite_title_selects_the_petites_group_when_regular_six_is_also_offered(self):
        item={'department':'Women','itemType':'Shorts','size':'6P','fit':'Regular'}
        size,group=size_and_type(item,category_for(item))
        self.page.set_content('''<button name="attributes.Size" aria-controls="sizes"
            onclick="document.querySelector('#sizes').hidden=false"></button>
            <div id="sizes" hidden><details open><summary>Regular</summary><button onclick="chooseSize('Regular - 6')">6</button></details>
            <details open><summary>Petites</summary><button onclick="chooseSize('Petites - 6')">6</button></details></div>
            <script>function chooseSize(value){document.querySelector('[name="attributes.Size"]').textContent=value;document.querySelector('#sizes').hidden=true}</script>''')
        self.assertEqual(set_field(self.page,['Size'],size,group=group),'6')
        self.assertEqual(control(self.page,['Size']).inner_text(),'Petites - 6')

    def test_petite_medium_uses_native_pm_without_selecting_regular_medium(self):
        self.item.update(department='Women',itemType='Sweater',size='M',fit='Petite')
        self.page.goto(post.CREATE_URL)
        self.page.evaluate('''()=>{
          parts.splice(0,parts.length,'Clothing, Shoes & Accessories','Women',"Women's Clothing",'Sweaters');
          document.querySelector('#size').outerHTML=`<button name="attributes.Size" aria-controls="sizes" onclick="document.querySelector('#sizes').hidden=false"></button>
            <div id="sizes" hidden><details open><summary>Regular</summary><button onclick="chooseSize('Regular - M')">M</button></details>
            <details open><summary>Petites</summary><button onclick="chooseSize('Petites - PM')">PM</button><button onclick="chooseSize('Petites - PL')">PL</button></details></div>`;
          window.chooseSize=value=>{document.querySelector('[name="attributes.Size"]').textContent=value;document.querySelector('#sizes').hidden=true};
        }''')
        filled=post.fill_listing_fields(self.page,self.item,{})
        self.assertEqual(filled['specifics']['Size'],'PM')
        self.assertEqual(filled['specifics']['Size Type'],'Petites')
        self.assertEqual(self.item['size'],'M')
        post.verify_listing_fields(self.page,self.item,filled)
        self.page.locator('[name="attributes.Size"]').evaluate("e=>e.textContent='Regular - M'")
        with self.assertRaisesRegex(ValueError,'size or size type'):
            post.verify_listing_fields(self.page,self.item,filled)

    def test_compound_size_selects_reviewed_group_when_sizes_repeat(self):
        self.page.set_content('''<button name="attributes.Size" aria-controls="sizes"
            onclick="document.querySelector('#sizes').hidden=false"></button>
            <div id="sizes" hidden><input aria-label="Search. Results appear below">
            <details open><summary>Regular</summary><button onclick="chooseSize('Regular - L')">L</button></details>
            <details open><summary>Big &amp; Tall</summary><button onclick="chooseSize('Big &amp; Tall - L')">L</button></details></div>
            <script>function chooseSize(value){document.querySelector('[name="attributes.Size"]').textContent=value;document.querySelector('#sizes').hidden=true}</script>''')
        self.assertEqual(set_field(self.page,['Size'],'L',group='Regular'),'L')
        self.assertEqual(control(self.page,['Size']).inner_text(),'Regular - L')

    def test_size_group_can_load_after_the_popup_becomes_visible(self):
        self.page.set_content('''<button name="attributes.Size" aria-controls="sizes" onclick="openSizes()"></button>
            <div id="sizes" hidden></div><script>
            function openSizes(){const popup=document.querySelector('#sizes');popup.hidden=false;
              setTimeout(()=>{popup.innerHTML='<details open><summary>Regular</summary><button>L</button></details>';
                popup.querySelector('button').onclick=()=>{document.querySelector('[name="attributes.Size"]').textContent='Regular - L';popup.hidden=true}},150)}
            </script>''')
        self.assertEqual(set_field(self.page,['Size'],'L',group='Regular'),'L')

    def test_photo_suggestions_can_rebuild_and_close_the_open_size_menu(self):
        self.page.set_content('''<div class="fake-menu-button"><button name="attributes.Size" aria-expanded="false" aria-controls="old-size" onclick="openSizes(this)"></button>
            <div id="old-size" class="fake-menu-button__menu" hidden></div></div><script>
            let rebuilt=false;
            function openSizes(button){const popup=button.nextElementSibling;button.setAttribute('aria-expanded','true');popup.hidden=false;
              if(!rebuilt){rebuilt=true;setTimeout(()=>{popup.id='new-size';button.setAttribute('aria-controls','new-size');button.setAttribute('aria-expanded','false');popup.hidden=true;
                popup.innerHTML='<details open><summary>Regular</summary><button>L</button></details>';
                popup.querySelector('button').onclick=()=>{button.textContent='Regular - L';button.setAttribute('aria-expanded','false');popup.hidden=true}},100)}
            }</script>''')
        self.assertEqual(set_field(self.page,['Size'],'L',group='Regular'),'L')

    def test_material_replaces_photo_suggestions_before_filtering_options(self):
        self.page.set_content('''<div class="fake-menu-button">
            <button name="attributes.Material" aria-controls="materials" aria-expanded="false"
              onclick="this.setAttribute('aria-expanded','true');materials.hidden=false"
              onkeydown="if(event.key==='Escape'){this.setAttribute('aria-expanded','false');materials.hidden=true}">100% Polyester (+1)</button>
            <div id="materials" class="fake-menu-button__menu" hidden>
              <input aria-label="Search or enter your own" oninput="document.querySelectorAll('[role=menuitemcheckbox]').forEach(e=>e.hidden=!e.textContent.includes(this.value))">
              <div role="menuitemcheckbox" aria-checked="true" onclick="choose(this)">100% Polyester</div>
              <div role="menuitemcheckbox" aria-checked="true" onclick="choose(this)">Cotton</div>
              <div role="menuitemcheckbox" aria-checked="false" onclick="choose(this)">Polyester</div>
            </div></div><script>
            function choose(e){e.setAttribute('aria-checked',e.getAttribute('aria-checked')==='true'?'false':'true');
              const checked=[...document.querySelectorAll('[aria-checked=true]')].map(e=>e.textContent);
              document.querySelector('button').textContent=checked.join(' (+1) ')}
            </script>''')
        self.assertEqual(set_field(self.page,['Material'],'Polyester'),'Polyester')
        self.assertEqual(self.page.get_by_role('menuitemcheckbox',checked=True,include_hidden=True).all_inner_texts(),['Polyester'])
        self.assertEqual(set_field(self.page,['Material'],'Polyester'),'Polyester')
        self.assertTrue(self.page.locator('#materials').is_hidden())

    def test_searchable_specific_scopes_choice_to_its_popup(self):
        self.page.set_content('''<button aria-label="Country of Origin" aria-controls="countries"
            onclick="document.querySelector('#countries').hidden=false"></button><p>United States</p>
            <div id="countries" hidden><input aria-label="Search or enter your own. Search results appear below"
              oninput="document.querySelector('#us').hidden=this.value!=='United States'">
            <div role="menuitemradio" id="us" hidden onclick="document.querySelector('button').textContent=this.textContent;this.parentElement.hidden=true">United States</div></div>''')
        self.assertEqual(set_field(self.page,['Country of Origin'],'United States'),'United States')

    def test_native_condition_dialog_requires_done(self):
        self.page.set_content('''<button id="summary-condition-field-value" name="condition"
            aria-labelledby="summary-condition-field-value condition-label" onclick="document.querySelector('dialog').showModal()">Pre-owned - Excellent</button>
            <span id="condition-label">Item condition</span><dialog><label><input type="radio" name="condition-option"
              onclick="window.choice='Pre-owned - Good'">Pre-owned - Good</label><button
              onclick="document.querySelector('[name=condition]').textContent=window.choice;this.closest('dialog').close()">Done</button></dialog>''')
        self.assertEqual(set_field(self.page,['Condition'],'Pre-owned - Good'),'Pre-owned - Good')
        self.assertTrue(self.page.locator('dialog').is_hidden())

    def test_policy_counts_do_not_change_identity_and_ambiguity_requires_review(self):
        self.page.set_content('''<label>Shipping policy<input role="combobox" aria-controls="policies"
            onclick="document.querySelector('#policies').hidden=false"></label><div id="policies" role="listbox" hidden>
            <div role="option" onclick="document.querySelector('input').value=this.textContent;this.parentElement.hidden=true">clothes (112 listings)</div>
            <div role="option" onclick="document.querySelector('input').value=this.textContent;this.parentElement.hidden=true">heavy [4 listings]</div></div>''')
        with self.assertRaisesRegex(ValueError,'Choose an existing eBay shipping policy'):
            fill_policy(self.page,['Shipping policy'])
        self.assertEqual(fill_policy(self.page,['Shipping policy'],'clothes'),'clothes (112 listings)')

    def test_native_layout_portal_photos_and_hidden_returns_fill_without_sku(self):
        self.page.goto(post.CREATE_URL)
        self.page.evaluate('''()=>{
          document.querySelector('label[for=sku]').remove();document.querySelector('#sku').remove();
          for(const section of document.querySelectorAll('section'))section.classList.add('smry');
          const heading=[...document.querySelectorAll('h2')].find(e=>e.textContent==='Category');heading.textContent='Item category';
          document.querySelector('#category-summary').textContent="Clothing, Shoes & Accessories > Men > Men's Clothing > Shirts > T-Shirts";
          const uploader=document.querySelector('#photos');uploader.id='fehelix-uploader';uploader.accept='image/*';document.body.append(uploader);
          uploader.onchange=e=>{const gallery=document.querySelector('#gallery');for(const file of e.target.files){
            const image=document.createElement('button');image.className='uploader-thumbnails-ux__image';
            image.style.backgroundImage='url("https://i.ebayimg.com/00/s/ABC/z/PHOTO'+gallery.children.length+'/$_12.JPG")';gallery.append(image);}};
          document.querySelector('label[for=price]').textContent='Item price';
          const format=document.createElement('button');format.setAttribute('aria-haspopup','listbox');format.textContent='Buy It Now';
          document.querySelector('label[for=format]').remove();document.querySelector('#format').replaceWith(format);
          const dialog=document.createElement('dialog');dialog.innerHTML='<h2>Your settings</h2><button>Done</button>';dialog.querySelector('button').onclick=()=>dialog.close();
          dialog.append(document.querySelector('label[for=returns]'),document.querySelector('#returns'));document.body.append(dialog);
          const edit=document.createElement('button');edit.setAttribute('aria-label','Your settings - edit');edit.onclick=()=>dialog.showModal();document.body.append(edit);
        }''')
        result=post.run_on_page(self.page,self.item,self.photos,{},'fill',self.authorize)
        self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(result['uploadedPhotos'],2)
        self.assertTrue(self.page.locator('dialog').is_hidden())
        self.assertEqual(self.authorizations,0)
