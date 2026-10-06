"""Public proof uses the item ID from final review, not a stale closet grid."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.post_poshmark import verify_public_listing


class PoshmarkPublicationDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def test_known_listing_is_verified_without_a_link_in_the_seller_closet(self):
        owner=self.browser.new_context();page=owner.new_page();page.set_content('<h1>Your closet</h1>')
        original=self.browser.new_context
        def public_context():
            context=original()
            context.route('**/*',lambda route:route.fulfill(content_type='text/html',body='<h1>Reviewed shirt</h1>'))
            return context
        try:
            with patch.object(self.browser,'new_context',side_effect=public_context):
                self.assertEqual(verify_public_listing(page,'abcdef123456789012345678','Reviewed shirt'),
                                 'https://poshmark.com/listing/abcdef123456789012345678')
        finally:owner.close()

    def test_optimistic_permalink_waits_for_publication_without_clicking_again(self):
        identifier='abcdef123456789012345678';canonical=f'https://poshmark.com/listing/Reviewed-shirt-{identifier}'
        owner=self.browser.new_context();page=owner.new_page()
        owner.route('**/*',lambda route:route.fulfill(content_type='text/html',body=f'<a href="{canonical}">Reviewed shirt</a><button onclick="window.posts++">List This Item</button><script>window.posts=0</script>'))
        page.goto('https://poshmark.com/create-listing');page.get_by_role('button',name='List This Item').click()
        original=self.browser.new_context;requests=[]
        def public_context():
            context=original()
            def respond(route):
                requests.append(route.request.url)
                route.fulfill(status=404 if len(requests)<3 else 200,content_type='text/html',body='Unavailable' if len(requests)<3 else '<h1>Reviewed shirt</h1>')
            context.route('**/*',respond);return context
        try:
            with patch.object(self.browser,'new_context',side_effect=public_context):
                self.assertEqual(verify_public_listing(page,identifier,'Reviewed shirt',publication_timeout=4000),canonical)
            self.assertEqual(requests,[canonical]*3)
            self.assertEqual(page.evaluate('window.posts'),1)
            self.assertFalse(page.is_closed())
        finally:owner.close()

    def test_unpublished_optimistic_link_remains_unverified_after_bounded_reads(self):
        identifier='abcdef123456789012345678';canonical=f'https://poshmark.com/listing/Reviewed-shirt-{identifier}'
        owner=self.browser.new_context();page=owner.new_page()
        owner.route('**/*',lambda route:route.fulfill(content_type='text/html',body=f'<a href="{canonical}">Reviewed shirt</a>'))
        page.goto('https://poshmark.com/create-listing');original=self.browser.new_context
        def public_context():
            context=original();context.route('**/*',lambda route:route.fulfill(status=404,body='Unavailable'));return context
        try:
            with patch.object(self.browser,'new_context',side_effect=public_context):
                with self.assertRaisesRegex(ValueError,'public listing page did not load'):
                    verify_public_listing(page,identifier,'Reviewed shirt',publication_timeout=100)
            self.assertFalse(page.is_closed())
        finally:owner.close()

    def test_a_missing_public_listing_is_not_reported_as_published(self):
        owner=self.browser.new_context();page=owner.new_page()
        original=self.browser.new_context
        def public_context():
            context=original();context.route('**/*',lambda route:route.fulfill(status=404,body='Unavailable'));return context
        try:
            with patch.object(self.browser,'new_context',side_effect=public_context):
                with self.assertRaisesRegex(ValueError,'public listing page did not load'):
                    verify_public_listing(page,'abcdef123456789012345678','Reviewed shirt')
        finally:owner.close()

    def test_canonical_permalink_is_verified_when_the_bare_item_url_returns_404(self):
        identifier='abcdef123456789012345678'
        canonical=f'https://poshmark.com/listing/Reviewed-shirt-{identifier}'
        owner=self.browser.new_context();page=owner.new_page()
        owner.route('**/*',lambda route:route.fulfill(content_type='text/html',body='<h1>Your closet</h1>'))
        page.goto('https://poshmark.com/closet/seller')
        original=self.browser.new_context;requests=[]
        def public_context():
            context=original()
            def route(request):
                url=request.request.url;requests.append(url)
                if url==canonical:request.fulfill(content_type='text/html',body='<h1>Reviewed shirt</h1>')
                else:
                    page.evaluate('url=>{const a=document.createElement("a");a.href=url;a.textContent="Reviewed shirt";document.body.appendChild(a)}',canonical)
                    request.fulfill(status=404,body='Unavailable')
            context.route('**/*',route);return context
        try:
            with patch.object(self.browser,'new_context',side_effect=public_context):
                self.assertEqual(verify_public_listing(page,identifier,'Reviewed shirt'),canonical)
            self.assertEqual(requests,[f'https://poshmark.com/listing/{identifier}',canonical])
        finally:owner.close()

    def test_verified_title_permalink_does_not_require_a_refreshed_closet(self):
        identifier='abcdef123456789012345678'
        canonical=f'https://poshmark.com/listing/HarleyDavidson-shirt-{identifier}'
        owner=self.browser.new_context();page=owner.new_page()
        owner.route('**/*',lambda route:route.fulfill(content_type='text/html',body='<h1>Your closet</h1>'))
        page.goto('https://poshmark.com/closet/seller')
        original=self.browser.new_context
        def public_context():
            context=original()
            context.route('**/*',lambda route:route.fulfill(status=200 if route.request.url==canonical else 404,
                content_type='text/html',body='<h1>Harley-Davidson shirt</h1>' if route.request.url==canonical else 'Unavailable'))
            return context
        try:
            with patch.object(self.browser,'new_context',side_effect=public_context):
                self.assertEqual(verify_public_listing(page,identifier,'Harley-Davidson shirt'),canonical)
        finally:owner.close()
