"""Browser fixtures only: every network request is fulfilled locally."""
from contextlib import ExitStack
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import post_etsy as post
from black_cat_worker.assisted_browser import find_real_chrome
from playwright.sync_api import sync_playwright, Locator, Error as BrowserError
from PIL import Image


class EtsyPublicationDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        chrome = find_real_chrome()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True, **({"executable_path": chrome} if chrome else {}))
        except Exception:
            cls.playwright.stop()
            raise
        image = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(image, format="PNG")
        cls.image = image.getvalue()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.scenario = "success"
        self.calls = 0
        self.inventory_loads = 0
        self.context.route("**/*", self.route)

    def tearDown(self): self.context.close()

    def test_large_transfer_uses_photo_control_when_video_accepts_images_too(self):
        from black_cat_worker.etsy_form import attach_photos
        self.page.set_content('<div id="field-listingImages"><input id="initial" type="file" multiple></div><script>window.selected=[]</script>')
        def select(locator,files,**kwargs):
            if isinstance(files,list):
                raise BrowserError('Cannot transfer files larger than 50Mb to a browser not co-located with the server')
            identifier=locator.get_attribute('id')
            self.page.evaluate('(value)=>window.selected.push(value)',{'control':identifier,'file':Path(files).name})
            if identifier=='initial':
                self.page.locator('#field-listingImages').evaluate('''e=>e.innerHTML=`
                  <div data-testid="empty-video-thumbnail"><input id="video" type="file" accept="video/mp4,image/jpeg"><label><span>Add videos</span><span>Add videos</span>2 remaining</label></div>
                  <div data-testid="empty-photo-thumbnail"><input id="photo" type="file" accept="video/mp4,image/jpeg"><label><span>Add photos</span><span>Add photos</span>19 remaining</label></div>`''')
        def verified(page,count):
            self.assertEqual(page.evaluate('window.selected.length'),count)
            return count
        with tempfile.TemporaryDirectory() as directory:
            photos=[str(Path(directory,name)) for name in ['first.jpg','second.jpg']]
            for photo in photos:Path(photo).write_bytes(self.image)
            with patch.object(Locator,'set_input_files',select), \
                 patch('black_cat_worker.etsy_form.photo_snapshot',return_value=[]), \
                 patch('black_cat_worker.etsy_form.verify_photos',side_effect=verified):
                self.assertEqual(attach_photos(self.page,photos),2)
        self.assertEqual(self.page.evaluate('window.selected'),[
            {'control':'initial','file':'first.jpg'},{'control':'photo','file':'second.jpg'}])

    def route(self, route):
        asset = "https://i.etsystatic.com/1/r/il/a/123456/il_fullxfull.123456_a.jpg"
        url = route.request.url
        if "i.etsystatic.com" in url:
            route.fulfill(content_type="image/png", body=self.image)
            return
        if "/listing/" in url:
            cart_id = "99999" if self.scenario == "wrong_cart" else "12345"
            html = f'''<h1>Reviewed shirt</h1><img class="carousel-image" src="{asset}">
                <form class="add-to-cart-form"><input type="hidden" name="listing_id" value="{cart_id}">
                <button type="button">Add to cart</button></form>'''
        elif "/tools/listings" in url:
            self.inventory_loads += 1
            checked = "" if self.scenario == "draft" else "checked"
            html = f'''<main><input type="radio" name="item_status" value="active" {checked}>
                <input placeholder="Search by title, tag, or SKU">
                <a href="/your/shops/me/listing-editor/edit/12345"><p>Reviewed shirt</p><img src="{asset}"></a></main>'''
            if self.scenario == 'unindexed':
                html+="<script>document.querySelector('input[placeholder]').oninput=e=>document.querySelector('main a').hidden=!!e.target.value;</script>"
            if self.scenario == 'missing' or self.scenario == 'stale_inventory' and self.inventory_loads <= 2:
                html+="<script>document.querySelector('main a').remove()</script>"
        elif "/listing-editor/edit/" in url:
            sku = "000002" if self.scenario == "wrong_sku" else "000001"
            html = f'<input id="listing-sku-input" value="{sku}">'
        else:
            html = f'''<main><textarea id="listing-title-input"></textarea>
                <div id="field-listingImages"><img src="{asset}"></div>
                <button onclick="localStorage.setItem('clicks','1');document.querySelector('.wt-overlay__modal').style.display='block'">Publish</button></main>
                <div id="wt-portals"><div class="wt-overlay__modal" style="display:none">
                <h2>You are about to publish a new listing</h2><p>$0.20 USD</p>
                <button onclick="localStorage.setItem('clicks','2');location.href='https://www.etsy.com/your/shops/me/tools/listings'">Publish</button></div></div>'''
        route.fulfill(content_type="text/html", body=html)

    def authorize(self):
        self.calls += 1
        if self.scenario == "paused" and self.calls == 3:
            raise ValueError("Run paused before final confirmation")

    def run_publication(self):
        self.page.goto(post.CREATE_URL)
        item = {"itemId": 1, "sku": "000001", "title": "Reviewed shirt", "description": "Reviewed details",
                "price": 25, "quantity": 1, "trueVintage": True, "whenMade": "1990s (Vintage)"}
        with ExitStack() as stack:
            for name in ["fill_category", "fill_size", "fill_reviewed_core", "fill_shipping_profile", "fill_package", "set_renewal", "verify_filled_listing"]:
                stack.enter_context(patch.object(post, name))
            stack.enter_context(patch.object(post, "attach_photos", return_value=1))
            return post.run_on_page(self.page, item, ["fixture"], {"shippingProfileName": "clothes", "autoRenew": False}, "post",
                                    self.authorize, lambda *args: post.verify_live_listing(self.page, *args, sku=item["sku"], timeout=500))

    def test_both_confirmation_clicks_and_all_marketplace_views_are_required(self):
        report = self.run_publication()
        self.assertEqual(report["outcome"], "posted", report)
        self.assertEqual(self.calls, 3)
        self.assertEqual(self.page.evaluate("localStorage.getItem('clicks')"), "2")

    def test_draft_or_wrong_sku_or_wrong_product_form_never_reports_success(self):
        for scenario in ["draft", "wrong_sku", "wrong_cart"]:
            with self.subTest(scenario=scenario):
                self.scenario = scenario
                self.calls = 0
                report = self.run_publication()
                self.assertEqual(report["outcome"], "failed")
                self.assertTrue(report["submissionStarted"])

    def test_new_listing_does_not_require_sku_search_indexing(self):
        self.scenario='unindexed'
        report=self.run_publication()
        self.assertEqual(report['outcome'],'posted',report)

    def test_stale_inventory_gets_one_read_refresh_without_republishing(self):
        self.scenario='stale_inventory'
        report=self.run_publication()
        self.assertEqual(report['outcome'],'posted',report)
        self.assertEqual(self.inventory_loads,3)
        self.assertEqual(self.page.evaluate("localStorage.getItem('clicks')"),'2')
        self.assertEqual(self.calls,3)

    def test_missing_listing_remains_uncertain_after_bounded_refresh(self):
        self.scenario='missing'
        report=self.run_publication()
        self.assertEqual(report['outcome'],'failed',report)
        self.assertTrue(report['submissionStarted'])
        self.assertEqual(self.inventory_loads,3)
        self.assertEqual(self.page.evaluate("localStorage.getItem('clicks')"),'2')

    def test_pause_after_confirmation_opens_prevents_the_final_publish_click(self):
        self.scenario = "paused"
        report = self.run_publication()
        self.assertEqual(report["outcome"], "failed")
        self.assertEqual(self.page.evaluate("localStorage.getItem('clicks')"), "1")
