from pathlib import Path
import sys
import unittest
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.end_depop import remove_listing

REQUEST = {'externalListingId':'seller-shirt','externalUrl':'https://www.depop.com/products/seller-shirt/'}


class DepopRemovalDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width':1100,'height':720})
        self.page.set_default_timeout(1500)
        self.sold = False
        self.confirmations = 0
        self.product_edit = True
        self.inventory_id = 'seller-shirt'
        self.page.route('**/*', self.route)

    def tearDown(self): self.page.close()

    def route(self, route):
        path = urlsplit(route.request.url).path
        if path == '/fixture-confirm':
            self.sold = True; self.confirmations += 1
            return route.fulfill(status=200, body='ok')
        if path == '/products/seller-shirt/':
            html = '<main><h1 aria-describedby="sold">Shirt</h1><p id="sold">This product has been sold</p></main>' if self.sold else \
                '<main><h1>Shirt</h1><a href="/products/edit/seller-shirt/">Edit</a></main>'
            if not self.product_edit:
                html = html.replace('<a href="/products/edit/seller-shirt/">Edit</a>', '')
        else:
            html = '''<main><h1>Active items (1)</h1><div style="height:3000px"></div>
              <ul><li><a href="/products/seller-shirt/manage/">Shirt</a><a href="/products/edit/seller-shirt/">Edit</a>
              <button id="manage">Manage listings</button></li></ul><div style="height:900px"></div></main>
              <script>
              // Depop dismisses the dropdown on scrolling. If its anchor is at
              // the bottom, Playwright scrolling to the action loses the menu.
              addEventListener('scroll',()=>document.querySelector('[role=menu]')?.remove());
              document.querySelector('#manage').onclick=e=>{
                const menu=document.createElement('div');menu.role='menu';
                menu.style.cssText='position:absolute;left:30px;width:180px;background:white;padding-top:50px;top:'+(scrollY+e.target.getBoundingClientRect().bottom)+'px';
                menu.innerHTML='<button role="menuitem" style="height:40px">Mark as sold</button>';
                menu.querySelector('button').onclick=()=>{
                  menu.remove();const dialog=document.createElement('div');dialog.role='dialog';
                  dialog.style.cssText='position:fixed;top:100px;left:200px;background:white;';
                  dialog.innerHTML='<p>This will mark your listing as sold.</p><button>Confirm</button>';
                  dialog.querySelector('button').onclick=()=>fetch('/fixture-confirm',{method:'POST'}).then(()=>dialog.remove());
                  document.body.append(dialog);
                };document.body.append(menu);
              };
              </script>'''
            html = html.replace('seller-shirt', self.inventory_id)
        route.fulfill(status=200, content_type='text/html', body=html)

    def test_deep_listing_menu_stays_in_view_and_confirms_only_the_verified_item_once(self):
        authorizations = []
        result = remove_listing(self.page, REQUEST, lambda: authorizations.append(True))
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertTrue(result['verified'])
        self.assertEqual(self.confirmations, 1)
        self.assertEqual(len(authorizations), 3)
        self.assertEqual(self.page.url, REQUEST['externalUrl'])

    def test_already_unavailable_product_does_not_submit_again(self):
        self.sold = True
        result = remove_listing(self.page, REQUEST, lambda: None)
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertFalse(result['submissionStarted'])
        self.assertEqual(self.confirmations, 0)

    def test_product_without_edit_link_uses_exact_owned_inventory_row(self):
        self.product_edit = False
        result = remove_listing(self.page, REQUEST, lambda: None)
        self.assertEqual(result['outcome'], 'ended', result)
        self.assertTrue(result['verified'])
        self.assertEqual(self.confirmations, 1)

    def test_missing_product_edit_and_unrelated_inventory_never_submit(self):
        self.product_edit = False
        self.inventory_id = 'other-shirt'
        result = remove_listing(self.page, REQUEST, lambda: None)
        self.assertEqual(result['outcome'], 'failed', result)
        self.assertFalse(result['submissionStarted'])
        self.assertEqual(self.confirmations, 0)


if __name__ == '__main__': unittest.main()
