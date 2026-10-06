"""Poshmark edits require final review before Not For Sale reaches the server."""
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.end_poshmark import remove_listing

ID='abcdef123456789012345678'
URL=f'https://poshmark.com/listing/Reviewed-shirt-{ID}'


class PoshmarkRemovalDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.saved=0;self.calls=0;self.pause_at_final=False
        self.context=self.browser.new_context();self.context.route('**/*',self.route);self.page=self.context.new_page()

    def tearDown(self):self.context.close()

    def route(self,route):
        if '/fixture-save' in route.request.url:
            self.saved+=1;route.fulfill(body='ok');return
        if '/edit-listing/' in route.request.url:
            html=f'''<main><div data-et-name="listingEditorImageSection" data-et-prop-listing_id="{ID}"></div>
              <div class="dropdown__selector" onclick="document.querySelector('.dropdown__menu').hidden=false">For Sale</div>
              <div class="dropdown__menu" hidden><p onclick="document.querySelector('.dropdown__selector').textContent='Not For Sale';this.parentElement.hidden=true">Not For Sale</p></div>
              <button onclick="document.querySelector('.listing-editor__share--body').hidden=false">Update</button>
              <div class="listing-editor__share--body" hidden><h2>Reviewed shirt</h2>
              <label><input data-test="toggle-input" type="checkbox" checked>Promotion</label>
              <button data-et-prop-listing_id="{ID}" onclick="fetch('/fixture-save',{{method:'POST'}}).then(()=>this.parentElement.hidden=true)">List This Item</button></div></main>'''
        else:
            marker='<p class="ldp-inventory-badge__label">Not For Sale</p>' if self.saved else f'<a data-et-name="edit_listing" href="/edit-listing/{ID}">Edit</a>'
            html=f'<h1 class="listing__title--redesign">Reviewed shirt</h1>{marker}'
        route.fulfill(content_type='text/html',body=html)

    def authorize(self):
        self.calls+=1
        if self.pause_at_final and self.calls==4:raise ValueError('Removal paused before final confirmation')

    def test_update_then_review_then_fresh_listing_proof_are_required(self):
        result=remove_listing(self.page,{'externalListingId':ID,'externalUrl':URL},self.authorize)
        self.assertEqual(result['outcome'],'ended',result)
        self.assertTrue(result['verified']);self.assertEqual(self.saved,1);self.assertEqual(self.calls,4)
        self.assertFalse(self.page.locator('input[data-test="toggle-input"]').is_checked())

    def test_pause_at_final_review_does_not_save_the_availability_change(self):
        self.pause_at_final=True
        result=remove_listing(self.page,{'externalListingId':ID,'externalUrl':URL},self.authorize)
        self.assertFalse(result['verified']);self.assertEqual(self.saved,0)
