import os
import sys
import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import assisted_browser as browser


class AssistedSessionTests(unittest.TestCase):
    def setUp(self):
        bounds = {'left':167,'top':-1244,'width':1600,'height':1000}
        for module in ['assisted_browser', 'work_browser']:
            mock = patch('black_cat_worker.'+module+'.work_window_bounds', return_value=bounds)
            mock.start(); self.addCleanup(mock.stop)

    def test_different_marketplace_profiles_share_one_work_screen_lease(self):
        from black_cat_worker.browser_lease import BrowserLease
        pw = MagicMock()
        context = MagicMock();context.pages = [MagicMock()]
        pw.chromium.executable_path = 'bundled.exe'
        pw.chromium.connect_over_cdp.return_value.contexts = [context]
        original = BrowserLease.acquire
        def immediate(lease):
            lease.timeout = 0
            return original(lease)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'BLACKCAT_DATA_ROOT':root}), \
             patch.object(browser, 'find_real_chrome', return_value=None), patch.object(BrowserLease, 'acquire', immediate), \
             patch.object(browser, '_wait_for_devtools', return_value='http://127.0.0.1:9333'), \
             patch.object(browser.subprocess, 'Popen', return_value=MagicMock()) as launch:
            first = browser.AssistedSession(pw, os.path.join(root, 'depop-profile'))
            try:
                with self.assertRaises(TimeoutError):
                    browser.AssistedSession(pw, os.path.join(root, 'poshmark-profile'))
                launch.assert_called_once()
            finally:first.close()
            second = browser.AssistedSession(pw, os.path.join(root, 'poshmark-profile'))
            second.close()
            self.assertEqual(launch.call_count,2)

    def test_failed_browser_start_releases_the_profile_for_the_next_process(self):
        from black_cat_worker.browser_lease import BrowserLease
        pw = MagicMock()
        pw.chromium.executable_path = 'bundled.exe'
        with tempfile.TemporaryDirectory() as root, patch.object(browser, 'find_real_chrome', return_value=None), \
             patch.object(browser.subprocess, 'Popen', side_effect=RuntimeError('startup failed')):
            with self.assertRaisesRegex(RuntimeError, 'Could not attach'):
                browser.AssistedSession(pw, root)
            with BrowserLease(Path(root, '.blackcat-browser.lock'), timeout=0):
                pass

    def test_marketplace_profile_launch_keeps_login_profile_and_uses_nonactivating_screen_bounds(self):
        pw, process, page = MagicMock(), MagicMock(), MagicMock()
        context = MagicMock();context.pages = [page]
        context.expect_page.return_value.__enter__.return_value.value = page
        pw.chromium.connect_over_cdp.return_value.contexts = [context]
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'BLACKCAT_DATA_ROOT': root}), \
             patch.object(browser, 'find_real_chrome', return_value='chrome.exe'), \
             patch.object(browser, '_free_port', return_value=9333), \
             patch.object(browser, '_wait_for_devtools', return_value='http://127.0.0.1:9333'), \
             patch.object(browser, 'configure_work_page') as configure, \
             patch.object(browser.subprocess, 'Popen', return_value=process) as launch:
            bounds={'left':167,'top':-1244,'width':1600,'height':1000}
            Path(root,'crawler-display.json').write_text(json.dumps({'version':1,'secondary':True,'bounds':bounds}),encoding='utf-8')
            profile=os.path.join(root,'depop-profile')
            session=browser.AssistedSession(pw,profile)
            args=launch.call_args.args[0]
            self.assertIn('--user-data-dir='+profile,args)
            self.assertIn('--no-startup-window',args)
            self.assertNotIn('--new-window',args)
            self.assertEqual(pw.chromium.connect_over_cdp.return_value.new_browser_cdp_session.return_value.send.call_args.args, ('Target.createTarget', {'url':'about:blank','newWindow':True,'background':True,'focus':False,**bounds}))
            self.assertNotIn('--start-maximized',args)
            if os.name=='nt':self.assertEqual(launch.call_args.kwargs['startupinfo'].wShowWindow,4)
            configure.assert_called_once_with(page,bounds)
            session.close()

    def test_failed_installed_chrome_attachment_never_reopens_profile_in_bundled_browser(self):
        pw, process = MagicMock(), MagicMock()
        with tempfile.TemporaryDirectory() as root, \
             patch.object(browser, "find_real_chrome", return_value="chrome.exe"), \
             patch.object(browser, "_free_port", return_value=9333), \
             patch.object(browser, "_wait_for_devtools", return_value=None), \
             patch.object(browser.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "Could not attach"):
                browser.AssistedSession(pw, root)
        pw.chromium.launch_persistent_context.assert_not_called()
        process.terminate.assert_called_once()

    def test_no_installed_chrome_retains_the_existing_bundled_fallback(self):
        pw = MagicMock()
        context, page = MagicMock(), MagicMock()
        context.pages = [page]
        context.expect_page.return_value.__enter__.return_value.value = page
        pw.chromium.executable_path = 'bundled.exe'
        pw.chromium.connect_over_cdp.return_value.contexts = [context]
        with tempfile.TemporaryDirectory() as root, patch.object(browser, "find_real_chrome", return_value=None), \
             patch.object(browser, '_wait_for_devtools', return_value='http://127.0.0.1:9333'), \
             patch.object(browser.subprocess, 'Popen', return_value=MagicMock()) as launch:
            session = browser.AssistedSession(pw, root)
            self.assertFalse(session.real)
            self.assertIs(session.page, page)
            session.close()
            pw.chromium.connect_over_cdp.return_value.close.assert_called_once()
            self.assertEqual(launch.call_args.args[0][0], 'bundled.exe')
            self.assertIn('--no-startup-window', launch.call_args.args[0])

    def closing_session(self):
        session = browser.AssistedSession.__new__(browser.AssistedSession)
        session._proc = MagicMock()
        session._proc.poll.return_value = None
        session._browser = MagicMock()
        session._ctx = MagicMock()
        session.page = MagicMock()
        session._lease = MagicMock()
        return session

    def test_owned_chrome_exits_before_disconnect_and_lease_release_without_termination(self):
        session = self.closing_session()
        process, connection, lease = session._proc, session._browser, session._lease
        events = []
        connection.new_browser_cdp_session.return_value.send.side_effect = lambda command: events.append(command)
        process.wait.side_effect = lambda **kwargs: events.append('process-exited')
        connection.close.side_effect = lambda: events.append('disconnect')
        lease.release.side_effect = lambda: events.append('release')
        session.close(); session.close()
        self.assertEqual(events, ['Browser.close', 'process-exited', 'disconnect', 'release'])
        process.wait.assert_called_once_with(timeout=8)
        process.terminate.assert_not_called(); process.kill.assert_not_called()
        self.assertIsNone(session.page)

    def test_exit_before_close_acknowledgement_does_not_force_terminate(self):
        session = self.closing_session(); process = session._proc
        session._browser.new_browser_cdp_session.return_value.send.side_effect = RuntimeError('connection closed')
        session.close()
        process.wait.assert_called_once_with(timeout=8)
        process.terminate.assert_not_called()

    def test_close_command_watchdog_targets_only_the_captured_owned_process(self):
        session = self.closing_session(); process = session._proc
        timer = MagicMock()
        def watchdog(seconds, callback):
            self.assertEqual(seconds, 8)
            timer.start.side_effect = callback
            return timer
        with patch.object(browser.threading, 'Timer', side_effect=watchdog):
            session.close()
        process.kill.assert_called_once()
        process.terminate.assert_not_called()
        timer.cancel.assert_called_once(); timer.join.assert_called_once_with(timeout=1)

    def test_unresponsive_owned_process_uses_bounded_fallback_and_waits_after_kill(self):
        session = self.closing_session()
        process, lease = session._proc, session._lease
        process.wait.side_effect = [browser.subprocess.TimeoutExpired('chrome', 8), browser.subprocess.TimeoutExpired('chrome', 8), 1]
        session.close()
        process.terminate.assert_called_once(); process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 3)
        self.assertTrue(all(call.kwargs == {'timeout': 8} for call in process.wait.call_args_list))
        lease.release.assert_called_once()

    def test_disconnection_without_an_owned_process_never_closes_the_browser(self):
        session = self.closing_session(); connection = session._browser
        session._proc = None
        session.close()
        connection.new_browser_cdp_session.assert_not_called()
        connection.close.assert_called_once()

    def test_already_exited_process_is_not_signalled_again_and_cleanup_errors_release_lease(self):
        session = self.closing_session()
        process, connection, lease = session._proc, session._browser, session._lease
        process.poll.return_value = 0
        connection.close.side_effect = RuntimeError('already disconnected')
        session.close()
        connection.new_browser_cdp_session.assert_not_called()
        process.terminate.assert_not_called(); process.wait.assert_not_called()
        lease.release.assert_called_once()


if __name__ == "__main__": unittest.main()
