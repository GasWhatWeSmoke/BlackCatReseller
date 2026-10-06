import sys
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.chrome_editor import existing_chrome_editor, new_chrome_editor


class ChromeEditorTests(unittest.TestCase):
    def setUp(self):
        # These transport fixtures exercise capability variants without a live screen.
        display = patch('black_cat_worker.chrome_editor.work_window_bounds', return_value=None)
        display.start(); self.addCleanup(display.stop)

    url = "https://www.etsy.com/your/shops/me/listing-editor/create"

    def fixture(self, pages):
        browser = Mock()
        browser.contexts = [SimpleNamespace(pages=pages)]
        playwright = Mock()
        playwright.chromium.connect_over_cdp.return_value = browser
        return browser, playwright

    def test_native_editor_holds_shared_lease_and_releases_it_after_caller_failure(self):
        from black_cat_worker.browser_lease import BrowserLease
        page = SimpleNamespace(url=self.url, goto=Mock(), bring_to_front=Mock())
        browser, playwright = self.fixture([page])
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'BLACKCAT_DATA_ROOT': root}), \
             patch('black_cat_worker.chrome_editor.session_endpoint', return_value='ws://127.0.0.1:12345/private-token'):
            path = Path(root, '.blackcat-browser.lock')
            with self.assertRaisesRegex(ValueError, 'caller stopped'):
                with new_chrome_editor(playwright, self.url):
                    with self.assertRaises(TimeoutError):
                        BrowserLease(path, timeout=0).acquire()
                    raise ValueError('caller stopped')
            with BrowserLease(path, timeout=0):
                pass
        browser.close.assert_called_once()

    def test_borrows_editor_with_section_fragment_and_cleans_up_after_caller_error(self):
        page = SimpleNamespace(url=self.url + "#shipping")
        browser, playwright = self.fixture([page])
        with patch("black_cat_worker.chrome_editor.session_endpoint", return_value="ws://127.0.0.1:12345/private-token"):
            with self.assertRaisesRegex(ValueError, "caller stopped"):
                with existing_chrome_editor(playwright, self.url) as actual:
                    self.assertIs(actual, page)
                    raise ValueError("caller stopped")
        browser.close.assert_called_once()

    def test_ambiguous_editors_are_not_given_to_the_crawler(self):
        page = SimpleNamespace(url=self.url)
        browser, playwright = self.fixture([page, page])
        with patch("black_cat_worker.chrome_editor.session_endpoint", return_value="ws://127.0.0.1:12345/private-token"):
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                with existing_chrome_editor(playwright, self.url):
                    self.fail("ambiguous editor was yielded")
        browser.close.assert_called_once()

    def test_connection_failure_does_not_expose_private_endpoint_or_restart_session(self):
        _, playwright = self.fixture([])
        playwright.chromium.connect_over_cdp.side_effect = RuntimeError("failed ws://127.0.0.1:12345/private-token")
        with patch("black_cat_worker.chrome_editor.session_endpoint", return_value="ws://127.0.0.1:12345/private-token") as acquire:
            with self.assertRaisesRegex(RuntimeError, "^Native Chrome connection did not complete$"):
                with existing_chrome_editor(playwright, self.url):
                    self.fail("connection failed")
        acquire.assert_called_once()

    def test_new_editor_requires_helper_capability_and_releases_on_caller_failure(self):
        page = SimpleNamespace(url=self.url, goto=Mock(), bring_to_front=Mock())
        browser, playwright = self.fixture([page])
        with patch("black_cat_worker.chrome_editor.session_endpoint", return_value="ws://127.0.0.1:12345/private-token") as acquire:
            with self.assertRaisesRegex(ValueError, "stop"):
                with new_chrome_editor(playwright, self.url) as actual:
                    self.assertIs(actual, page)
                    raise ValueError("stop")
        acquire.assert_called_once_with("new-editor-v1")
        page.goto.assert_called_once_with(self.url, wait_until="domcontentloaded", timeout=30000)
        page.bring_to_front.assert_called_once()
        self.assertIn("create=1", playwright.chromium.connect_over_cdp.call_args.args[0])
        browser.close.assert_called_once()

    def test_ebay_requires_its_updated_gateway_capability(self):
        page = SimpleNamespace(url="about:blank", goto=Mock(), bring_to_front=Mock())
        browser, playwright = self.fixture([page])
        with patch("black_cat_worker.chrome_editor.session_endpoint", return_value="ws://127.0.0.1:12345/private-token") as acquire:
            with new_chrome_editor(playwright, "https://www.ebay.com/sl/sell"):
                pass
        acquire.assert_called_once_with("ebay-editor-v1")

    def test_seller_tools_require_updated_capability_without_reconnecting_chrome(self):
        for url in ('https://www.ebay.com/sh/lst/active','https://www.etsy.com/your/orders/sold'):
            page = SimpleNamespace(url='about:blank', goto=Mock(), bring_to_front=Mock())
            browser, playwright = self.fixture([page])
            with patch('black_cat_worker.chrome_editor.session_endpoint', return_value='ws://127.0.0.1:12345/private-token') as acquire:
                with new_chrome_editor(playwright, url): pass
            acquire.assert_called_once_with('seller-tools-v1')
            browser.close.assert_called_once()

    def test_mercari_uses_its_capability_on_the_existing_session(self):
        page = SimpleNamespace(url='about:blank', goto=Mock(), bring_to_front=Mock())
        browser, playwright = self.fixture([page])
        with patch('black_cat_worker.chrome_editor.session_endpoint', return_value='ws://127.0.0.1:12345/private-token') as acquire:
            with new_chrome_editor(playwright, 'https://www.mercari.com/sell/'): pass
        acquire.assert_called_once_with('mercari-tools-v1')
        browser.close.assert_called_once()

    def test_failed_foreground_activation_releases_owned_tab_before_caller_runs(self):
        page = SimpleNamespace(url='about:blank', goto=Mock(), bring_to_front=Mock(side_effect=RuntimeError('Tab unavailable')))
        browser, playwright = self.fixture([page])
        with patch('black_cat_worker.chrome_editor.session_endpoint', return_value='ws://127.0.0.1:12345/private-token'):
            with self.assertRaisesRegex(RuntimeError, 'Tab unavailable'):
                with new_chrome_editor(playwright, self.url):
                    self.fail('A background tab was given to the worker')
        browser.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
