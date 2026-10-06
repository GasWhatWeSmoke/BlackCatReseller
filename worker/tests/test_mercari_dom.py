"""Mercari browser fixtures. All requests are fulfilled locally."""
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker import post_mercari as post
from black_cat_worker import mercari_form as form

IDENTIFIER='m12345678901'
HTML='''<main>
<section aria-label="Photos"><input type="file" accept="image/jpeg" onchange="addPhoto()"><div id="photos"></div></section>
<label>Title<input id="title" maxlength="80"></label><label>Description<textarea id="description"></textarea></label>
<button aria-label="Category" id="category" onclick="crumbs=[];document.querySelector('#categories').showModal()">Category</button>
<dialog id="categories"><div onclick="if(event.target.tagName==='BUTTON')crumbs.push(event.target.innerText)">
<button>Men</button><button>Women</button><button>Tops</button><button>Tops &amp; blouses</button><button>T-shirts</button><button>Tank tops</button></div>
<button onclick="document.querySelector('#category').innerText=crumbs.join(' > ');if(crumbs[0]==='Women')document.querySelector('#size').innerHTML='<option>L (12-14)</option><option>M (8-10)</option>';this.closest('dialog').close()">Done</button></dialog>
<label>Brand<select aria-label="Brand"><option>Fixture</option><option>Other</option></select></label>
<label>Size<select id="size" aria-label="Size"><option>L (42-44)</option><option>M (38-40)</option></select></label>
<label>Condition<select aria-label="Condition"><option>New</option><option>Like new</option><option>Good</option><option>Fair</option></select></label>
<label>Color<select aria-label="Color"><option>Blue</option><option>Black</option></select></label>
<label>SKU<input></label><label>Quantity<input type="number" value="2"></label>
<label>Price<input id="price" type="number" min="1" max="2000" step=".01"></label>
<label><input type="checkbox" checked>Smart Pricing</label><label><input type="checkbox" checked>Smart Offers</label>
<section aria-label="Shipping"><label>ZIP code<input></label>
<label><input type="radio" name="payer">Buyer</label><label><input type="radio" name="payer" checked>Seller</label>
<label><input type="radio" name="method">Ship on your own</label>
<label>Pounds<input type="number" min="0"></label><label>Ounces<input type="number" min="0" max="15"></label>
<label>Length<input type="number" min="1"></label><label>Width<input type="number" min="1"></label><label>Height<input type="number" min="1"></label>
<button onclick="document.querySelector('#shipping').showModal()">Choose shipping</button><div role="status" id="shippingSummary"></div></section>
<dialog id="shipping">
<label><input type="radio" name="quote">USPS Media Mail Up to 1 lb $2.00</label>
<label><input type="radio" name="quote">USPS Ground Advantage Up to 8 oz $4.00</label>
<label><input type="radio" name="quote">USPS Ground Advantage Up to 1 lb $5.50</label>
<label><input type="radio" name="quote">UPS Ground Up to 2 lb $6.50</label>
<button onclick="document.querySelector('#shippingSummary').innerText=document.querySelector('[name=quote]:checked').parentElement.innerText;this.closest('dialog').close();if(window.wrongDepartment)document.querySelector('#category').innerText='Women > Tops > T-shirts'">Apply</button></dialog>
<button onclick="window.posts++;history.pushState({},'', '/us/item/m12345678901/');document.body.innerHTML='<h1>Listed</h1>'">List</button>
</main><script>window.posts=0;window.photoCount=0;window.crumbs=[];function addPhoto(){photoCount++;document.querySelector('#photos').insertAdjacentHTML('beforeend','<img src="https://u-mercari-images.mercdn.net/photos/m12345678901_'+photoCount+'.jpg">')}</script>'''


class MercariDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())
        buffer=io.BytesIO();Image.new('RGB',(10,10),'blue').save(buffer,format='PNG');cls.image=buffer.getvalue()

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.photos=[]
        for index in (1,2):
            path=Path(self.directory.name,f'000001_{index:02}.jpg');path.write_bytes(self.image);self.photos.append(str(path))
        self.item={'itemId':1,'sku':'000001','title':'Reviewed Fixture Shirt','description':'Reviewed description.','brand':'Fixture','size':'M',
                   'itemType':'T-Shirt','department':'Unisex Adults','condition':'Good','color':'Blue','price':24.99,'quantity':1,'weightOz':9,
                   'packageDims':{'length':10,'width':8,'height':1}}
        self.options={'unisexDepartment':'Men','shippingMode':'buyer_label'}
        self.page=self.browser.new_page();self.page.set_default_timeout(1000)
        self.wrong_photo=False;self.public_price='24.99';self.sold=False;self.calls=0;self.pause_at=0
        self.page.route('**/*',self.route)
        self.page.goto(form.CREATE_URL)

    def tearDown(self):self.page.close();self.directory.cleanup()

    def route(self,route):
        url=route.request.url
        if '.mercdn.net/' in url:route.fulfill(status=200,content_type='image/png',body=self.image);return
        if '/us/item/' in url:
            filename='other_1.jpg' if self.wrong_photo else IDENTIFIER+'_1.jpg'
            buy='<button>Item sold</button>' if self.sold else '<button>Buy now</button>'
            html=f'<main><h1>{self.item["title"]}</h1><img src="https://u-mercari-images.mercdn.net/photos/{filename}"><span data-testid="item-price">${self.public_price}</span>{buy}</main>'
        else:html=HTML
        route.fulfill(status=200,content_type='text/html',body=html)

    def authorize(self):
        self.calls+=1
        if self.calls==self.pause_at:raise ValueError('Run was paused')

    def run_post(self,mode='post'):
        return post.run_on_page(self.page,self.item,self.photos,self.options,{'zip':'12345'},mode,self.authorize)

    def test_fill_keeps_price_size_photo_order_and_eligible_shipping_without_publishing(self):
        result=self.run_post('fill');self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.evaluate('posts'),0)
        self.assertEqual(self.page.get_by_label('Price',exact=True).input_value(),'24.99')
        self.assertEqual(self.page.get_by_label('Size',exact=True).input_value(),'M (38-40)')
        self.assertEqual(self.page.get_by_label('Quantity',exact=True).input_value(),'1')
        self.assertFalse(self.page.get_by_label('Smart Pricing',exact=True).is_checked())
        self.assertEqual(form.photo_keys(self.page),[f'/photos/{IDENTIFIER}_1.jpg',f'/photos/{IDENTIFIER}_2.jpg'])
        self.assertEqual(self.page.locator('#shippingSummary').inner_text(),'USPS Ground Advantage Up to 1 lb $5.50')

    def test_publish_requires_exact_public_identity_price_cover_and_purchase_control(self):
        result=self.run_post();self.assertEqual(result['outcome'],'posted',result)
        self.assertEqual(result['url'],f'https://www.mercari.com/us/item/{IDENTIFIER}/');self.assertEqual(self.calls,2)

    def test_new_confirmation_route_identifies_the_published_item_without_a_view_link(self):
        self.page.goto(f'https://www.mercari.com/sell/confirmation/{IDENTIFIER}/')
        self.page.set_content('<main><h1>Listing completed</h1><p>Your listing is live.</p></main>')
        self.assertEqual(post.submitted_url(self.page),f'https://www.mercari.com/us/item/{IDENTIFIER}/')

    def test_visible_account_limit_stops_before_upload_and_publication(self):
        self.page.locator('main').evaluate("e=>e.insertAdjacentHTML('beforeend','<p>Currently you are limited to 100 listings. This will be increased as you complete more sales.</p>')")
        result=self.run_post()
        self.assertFalse(result['submissionStarted']);self.assertIn('account listing limit reached',result['reason'])
        self.assertEqual(self.page.evaluate('photoCount'),0);self.assertEqual(self.page.evaluate('posts'),0)

    def test_limit_reported_after_click_keeps_submission_uncertain_without_reclicking(self):
        self.page.get_by_role('button',name='List',exact=True).evaluate("e=>e.onclick=()=>{posts++;document.querySelector('main').insertAdjacentHTML('beforeend','<p>Currently you are limited to 100 listings. This will be increased as you complete more sales.</p>')}")
        result=self.run_post()
        self.assertEqual(result['outcome'],'failed');self.assertTrue(result['submissionStarted'])
        self.assertIn('account listing limit reached',result['reason']);self.assertNotIn('url',result)
        self.assertEqual(self.page.evaluate('posts'),1)

    def test_hidden_limit_notice_does_not_block_publication(self):
        self.page.locator('main').evaluate("e=>e.insertAdjacentHTML('beforeend','<p hidden>Currently you are limited to 100 listings. This will be increased as you complete more sales.</p>')")
        self.assertEqual(self.run_post()['outcome'],'posted')

    def test_user_chosen_women_department_uses_its_own_size_options(self):
        self.options['unisexDepartment']='Women';result=self.run_post('fill')
        self.assertEqual(result['outcome'],'filled',result)
        self.assertEqual(self.page.get_by_label('Size',exact=True).input_value(),'M (8-10)')
        self.assertEqual(self.page.locator('#category').inner_text(),'Women > Tops & blouses > T-shirts')

    def test_changed_department_stops_before_submission(self):
        self.page.evaluate('window.wrongDepartment=true')
        result=self.run_post();self.assertEqual(result['outcome'],'failed',result)
        self.assertFalse(result['submissionStarted']);self.assertEqual(self.page.evaluate('posts'),0)

    def test_pause_before_final_click_leaves_the_item_unposted(self):
        self.pause_at=2;result=self.run_post()
        self.assertFalse(result['submissionStarted']);self.assertEqual(self.page.evaluate('posts'),0)

    def test_wrong_public_cover_cannot_certify_a_post(self):
        self.wrong_photo=True;result=self.run_post()
        self.assertEqual(result['outcome'],'failed');self.assertTrue(result['submissionStarted']);self.assertIn('url',result)

    def test_public_price_change_cannot_certify_a_post(self):
        self.public_price='1.00';result=self.run_post()
        self.assertEqual(result['outcome'],'failed');self.assertTrue(result['submissionStarted'])

    def test_ship_on_own_selects_seller_postage(self):
        self.options['shippingMode']='ship_on_own';result=self.run_post('fill')
        self.assertEqual(result['outcome'],'filled',result)
        self.assertTrue(self.page.get_by_role('radio',name='Seller',exact=True).is_checked())

    def test_preexisting_photos_are_not_added_again(self):
        self.page.evaluate('addPhoto()');self.page.locator('#photos img').wait_for()
        self.page.wait_for_function('document.querySelector("#photos img").complete')
        result=self.run_post();self.assertFalse(result['submissionStarted']);self.assertIn('already contains',result['reason'])

    def test_restored_draft_is_not_overwritten(self):
        self.page.get_by_label('Title',exact=True).fill('Existing draft')
        result=self.run_post();self.assertFalse(result['submissionStarted']);self.assertIn('existing draft',result['reason'])
        self.assertEqual(self.page.get_by_label('Title',exact=True).input_value(),'Existing draft')
        self.assertEqual(self.page.evaluate('photoCount'),0)


if __name__=='__main__':unittest.main()
