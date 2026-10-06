"""Delayed native inventory hydration must not hide an older active listing."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.end_depop import find_active_row, inspect_availability, ACTIVE_URL


class DepopInventoryDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.pw.stop()

    def setUp(self): self.page = self.browser.new_page()
    def tearDown(self): self.page.close()

    def test_header_can_precede_inventory_rows_and_load_more(self):
        html='''<main><h1>Active items (2)</h1><ul></ul></main><script>
          function row(id){return '<li><a href="/products/'+id+'/manage/">Item</a><a href="/products/edit/'+id+'/">Edit</a><button aria-label="Manage listings">Manage</button></li>'}
          setTimeout(()=>{
            document.querySelector('ul').innerHTML=row('seller-newer');
            const more=document.createElement('button');more.textContent='Load more';document.querySelector('main').append(more);
            more.onclick=()=>{more.disabled=true;setTimeout(()=>{document.querySelector('ul').insertAdjacentHTML('beforeend',row('seller-older'));more.remove()},100)};
          },100);
        </script>'''
        self.page.route('**/*', lambda route: route.fulfill(content_type='text/html', body=html))
        row=find_active_row(self.page,'seller-older')
        self.assertEqual(row.locator('a').first.get_attribute('href'),'/products/seller-older/manage/')

    def test_verified_empty_inventory_does_not_wait_for_a_nonexistent_row(self):
        self.page.route('**/*', lambda route: route.fulfill(content_type='text/html',body='<main><h1>Active items (0)</h1></main>'))
        with self.assertRaisesRegex(ValueError,'not found in active listings'):
            find_active_row(self.page,'seller-older')

    def inspect_bag(self, scenario='active'):
        url='https://www.depop.com/products/seller-bag/'
        loads=[]
        def route(request):
            target=request.request.url;loads.append(target)
            if target==ACTIVE_URL:
                html='<main><h1>Active items (0)</h1></main>' if scenario=='absent' else '''<main><h1>Active items (1)</h1><ul><li>
                  <a href="/products/seller-bag/manage/">Bag</a><a href="/products/edit/seller-bag/">Edit</a>
                  <button aria-label="Manage listings" onclick="throw Error('Must not click')">Manage</button></li></ul></main>'''
            elif scenario=='missing':
                request.fulfill(status=404,content_type='text/html',body='Not found');return
            elif scenario=='sold_after_inventory' and loads.count(url)>1:
                html='<main><h1 aria-describedby="sold">Bag</h1><p id="sold">This product has been sold</p></main>'
            else:
                html='<main><p>$49.99</p><p>Bag description</p><a href="/products/edit/seller-bag/">Edit listing</a><p>65 sold</p></main>'
            request.fulfill(content_type='text/html',body=html)
        self.page.route('**/*',route)
        request={'externalUrl':url,'externalListingId':'seller-bag'}
        if scenario=='redirect':
            # HTTP redirect chains can escape Playwright's initial route handler.
            # Simulate the final navigation through our local fixture instead.
            navigate=self.page.goto
            with patch.object(self.page,'goto',side_effect=lambda target,**kwargs:navigate(
                    'https://www.depop.com/products/seller-other/',**kwargs)):
                result=inspect_availability(self.page,request)
        else:
            result=inspect_availability(self.page,request)
        return result,loads

    def test_bag_without_heading_requires_active_identity_and_restores_product(self):
        result,loads=self.inspect_bag()
        self.assertEqual(result['state'],'editable')
        self.assertEqual(loads,[result['url'],ACTIVE_URL,result['url']])
        self.assertEqual(self.page.url,result['url'])
        self.assertEqual(self.page.locator('main p').first.inner_text(),'$49.99')

    def test_no_heading_and_absent_active_identity_is_not_removal_proof(self):
        with self.assertRaisesRegex(ValueError,'not found in active listings'):
            self.inspect_bag('absent')

    def test_sale_during_inventory_check_is_verified_on_restored_product(self):
        result,loads=self.inspect_bag('sold_after_inventory')
        self.assertEqual(result['state'],'unavailable')
        self.assertEqual(loads,[result['url'],ACTIVE_URL,result['url']])

    def test_missing_product_is_not_removal_proof(self):
        with self.assertRaisesRegex(ValueError,'missing page is not removal proof'):
            self.inspect_bag('missing')

    def test_product_redirect_cannot_certify_another_identity(self):
        with self.assertRaisesRegex(ValueError,'different product'):
            self.inspect_bag('redirect')
