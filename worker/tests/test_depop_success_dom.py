"""A successful post can land on a confirmation page before its product page."""
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.post_depop import submitted_listing_url


class DepopSuccessDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls): cls.browser.close();cls.pw.stop()

    def setUp(self): self.page=self.browser.new_page()
    def tearDown(self): self.page.close()

    def test_confirmation_follows_view_listing_without_posting_again(self):
        def route(request):
            body='''<h1>Nice! It's listed</h1><a href="/products/seller-reviewed-shirt/manage/">View listing</a>
              <button onclick="throw Error('Do not publish again')">Post</button>'''
            if '/products/seller-reviewed-shirt/' in request.request.url: body='<h1>Reviewed shirt</h1>'
            request.fulfill(content_type='text/html',body=body)
        self.page.route('**/*',route)
        self.page.goto('https://www.depop.com/products/create/success/?productId=12345')
        self.assertEqual(submitted_listing_url(self.page),'https://www.depop.com/products/seller-reviewed-shirt/')

    def test_editor_and_other_origins_are_not_publication_proof(self):
        self.page.route('**/*',lambda route:route.fulfill(content_type='text/html',body='<h1>Not a listing</h1>'))
        for url in ['https://www.depop.com/products/create/','https://example.com/products/seller-shirt/']:
            self.page.goto(url)
            self.assertIsNone(submitted_listing_url(self.page))
