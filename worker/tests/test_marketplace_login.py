import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import marketplace_login as login
from black_cat_worker import assisted_browser
from black_cat_worker.assisted_browser import manual_login_args


class MarketplaceLoginTests(unittest.TestCase):
    @patch('black_cat_worker.work_browser.work_window_bounds', return_value={'left':167,'top':-1244,'width':1600,'height':1000})
    def test_manual_sign_in_has_no_default_deadline(self, _display):
        process = MagicMock()
        process.wait.return_value = 0
        with tempfile.TemporaryDirectory() as root, \
             patch.object(assisted_browser, "find_real_chrome", return_value="chrome.exe"), \
             patch.object(assisted_browser.subprocess, "Popen", return_value=process), \
             patch.object(assisted_browser.time, "time", side_effect=[100, 103]):
            assisted_browser.run_manual_login(root, "https://www.etsy.com/signin", platform_name="Etsy")
        process.wait.assert_called_once_with(timeout=None)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    @patch('black_cat_worker.work_browser.work_window_bounds', return_value={'left':167,'top':-1244,'width':1600,'height':1000})
    def test_each_platform_opens_its_own_profile_in_manual_chrome(self, _display):
        with tempfile.TemporaryDirectory() as root:
            for marketplace, (name, url) in login.MARKETPLACES.items():
                with self.subTest(marketplace=marketplace), patch("sys.argv", ["login", "--marketplace", marketplace, "--data-root", root]), \
                     patch.object(login, "run_manual_login") as manual, patch("builtins.print") as report:
                    self.assertEqual(login.main(), 0)
                    manual.assert_called_once_with(os.path.join(root, f"{marketplace}-profile"), url, platform_name=name)
                    report.assert_called_with("MARKETPLACE_LOGIN_DONE window-closed", flush=True)
                    args = manual_login_args("chrome.exe", root, url)
                    self.assertFalse(any("debugging" in arg or "automation" in arg or "headless" in arg for arg in args))

    def test_browser_failure_does_not_emit_a_successful_handoff(self):
        with patch("sys.argv", ["login", "--marketplace", "ebay", "--data-root", "."]), \
             patch.object(login, "run_manual_login", side_effect=RuntimeError("profile already open")), patch("builtins.print") as report:
            self.assertEqual(login.main(), 1)
            self.assertNotIn("MARKETPLACE_LOGIN_DONE", str(report.call_args_list))


if __name__ == "__main__":
    unittest.main()
