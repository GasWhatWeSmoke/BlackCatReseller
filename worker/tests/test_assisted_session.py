"""Dedicated Chrome ownership regressions matched to the shipped beta8 worker."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import assisted_browser as browser

ENDPOINT = 'ws://127.0.0.1:9333/devtools/browser/fixture-browser'
BOUNDS = {'left':167,'top':-1244,'width':1600,'height':1000}


def connection_fixture():
    pw, process, page = MagicMock(), MagicMock(pid=123), MagicMock()
    context = MagicMock();context.pages = [page]
    context.expect_page.return_value.__enter__.return_value.value = page
    context.new_cdp_session.return_value.send.return_value = {'targetInfo':{'targetId':'fixture-target'}}
    connection = pw.chromium.connect_over_cdp.return_value
    connection.contexts = [context]
    connection.new_browser_cdp_session.return_value.send.return_value = {'targetId':'fixture-target'}
    pw.chromium.executable_path = 'bundled.exe'
    return pw, process, page


class AssistedSessionTests(unittest.TestCase):
    def setUp(self):
        for module in ['assisted_browser', 'work_browser']:
            handle = patch('black_cat_worker.'+module+'.work_window_bounds', return_value=BOUNDS)
            handle.start();self.addCleanup(handle.stop)
        for name,value in [('_saved_browser',None),('_browser_pid',123),('_close_owned_target',True)]:
            handle = patch.object(browser,name,return_value=value)
            handle.start();self.addCleanup(handle.stop)

    def test_different_marketplace_profiles_share_one_work_screen_lease(self):
        from black_cat_worker.browser_lease import BrowserLease
        pw,process,_ = connection_fixture()
        original = BrowserLease.acquire
        def immediate(lease):
            lease.timeout=0
            return original(lease)
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'BLACKCAT_DATA_ROOT':root}), \
             patch.object(browser,'find_real_chrome',return_value=None),patch.object(BrowserLease,'acquire',immediate), \
             patch.object(browser,'_wait_for_devtools',return_value=ENDPOINT),patch.object(browser.subprocess,'Popen',return_value=process) as launch:
            first=browser.AssistedSession(pw,os.path.join(root,'depop-profile'))
            try:
                with self.assertRaises(TimeoutError):browser.AssistedSession(pw,os.path.join(root,'poshmark-profile'))
                launch.assert_called_once()
            finally:first.close()
            second=browser.AssistedSession(pw,os.path.join(root,'poshmark-profile'));second.close()
            self.assertEqual(launch.call_count,2)

    def test_failed_browser_start_releases_the_profile_for_next_process(self):
        from black_cat_worker.browser_lease import BrowserLease
        pw,_,_=connection_fixture()
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'BLACKCAT_DATA_ROOT':root}), \
             patch.object(browser,'find_real_chrome',return_value=None),patch.object(browser.subprocess,'Popen',side_effect=RuntimeError('startup failed')):
            with self.assertRaisesRegex(RuntimeError,'Could not attach'):browser.AssistedSession(pw,root)
            with BrowserLease(Path(root,'.blackcat-browser.lock'),timeout=0):pass

    def test_marketplace_profile_launch_owns_exact_target_and_preserves_display_bounds(self):
        pw,process,page=connection_fixture()
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'BLACKCAT_DATA_ROOT':root}), \
             patch.object(browser,'find_real_chrome',return_value='chrome.exe'),patch.object(browser,'_free_port',return_value=9333), \
             patch.object(browser,'_wait_for_devtools',return_value=ENDPOINT),patch.object(browser,'configure_work_page') as configure, \
             patch.object(browser.subprocess,'Popen',return_value=process) as launch:
            profile=os.path.join(root,'depop-profile')
            session=browser.AssistedSession(pw,profile)
            args=launch.call_args.args[0]
            self.assertIn('--user-data-dir='+profile,args)
            self.assertIn('--no-startup-window',args)
            self.assertIn('--disable-background-mode',args)
            self.assertNotIn('--new-window',args)
            self.assertEqual(session._target_id,'fixture-target')
            self.assertEqual(session._endpoint,ENDPOINT)
            self.assertEqual(pw.chromium.connect_over_cdp.return_value.new_browser_cdp_session.return_value.send.call_args.args,
                ('Target.createTarget',{'url':'about:blank','newWindow':True,'background':True,'focus':False,**BOUNDS}))
            configure.assert_called_once_with(page,BOUNDS)
            self.assertTrue(Path(profile,'.blackcat-browser-owner.json').is_file())
            session.close()
            process.terminate.assert_not_called();process.kill.assert_not_called()

    def test_failed_installed_attachment_never_reopens_profile_or_signals_unverified_browser(self):
        pw,process,_=connection_fixture()
        with tempfile.TemporaryDirectory() as root,patch.object(browser,'find_real_chrome',return_value='chrome.exe'), \
             patch.object(browser,'_free_port',return_value=9333),patch.object(browser,'_wait_for_devtools',return_value=None), \
             patch.object(browser.subprocess,'Popen',return_value=process):
            with self.assertRaisesRegex(RuntimeError,'Could not attach'):browser.AssistedSession(pw,root)
        pw.chromium.launch_persistent_context.assert_not_called()
        process.terminate.assert_not_called();process.kill.assert_not_called()

    def test_no_installed_chrome_retains_the_bundled_fallback(self):
        pw,process,page=connection_fixture()
        with tempfile.TemporaryDirectory() as root,patch.object(browser,'find_real_chrome',return_value=None), \
             patch.object(browser,'_wait_for_devtools',return_value=ENDPOINT),patch.object(browser.subprocess,'Popen',return_value=process) as launch:
            session=browser.AssistedSession(pw,root)
            self.assertFalse(session.real);self.assertIs(session.page,page)
            session.close()
            pw.chromium.connect_over_cdp.return_value.close.assert_called_once()
            self.assertEqual(launch.call_args.args[0][0],'bundled.exe')

    def closing_session(self):
        session=browser.AssistedSession.__new__(browser.AssistedSession)
        session._proc=MagicMock();session._browser=MagicMock();session._ctx=MagicMock()
        session.page=MagicMock();session._lease=MagicMock()
        session._endpoint=ENDPOINT;session._target_id='fixture-target'
        return session

    def test_closes_only_owned_target_before_disconnect_and_lease_release(self):
        session=self.closing_session()
        process,connection,lease=session._proc,session._browser,session._lease
        events=[]
        connection.close.side_effect=lambda:events.append('disconnect')
        lease.release.side_effect=lambda:events.append('release')
        with patch.object(browser,'_close_owned_target',side_effect=lambda endpoint,target:events.append((endpoint,target)) or True):
            session.close();session.close()
        self.assertEqual(events,[(ENDPOINT,'fixture-target'),'disconnect','release'])
        connection.new_browser_cdp_session.assert_not_called()
        process.wait.assert_not_called();process.terminate.assert_not_called();process.kill.assert_not_called()
        self.assertIsNone(session.page)

    def test_cleanup_error_preserves_other_windows_and_releases_lease(self):
        session=self.closing_session();process,lease=session._proc,session._lease
        with patch.object(browser,'_close_owned_target',side_effect=RuntimeError('timeout')):session.close()
        process.terminate.assert_not_called();process.kill.assert_not_called();lease.release.assert_called_once()

    def test_unconfirmed_cleanup_does_not_escalate_to_browser_termination(self):
        session=self.closing_session();process=session._proc
        with patch.object(browser,'_close_owned_target',return_value=False):session.close()
        process.terminate.assert_not_called();process.kill.assert_not_called();process.wait.assert_not_called()

    def test_disconnection_without_owned_target_never_closes_any_target(self):
        session=self.closing_session();connection=session._browser
        session._target_id=None
        with patch.object(browser,'_close_owned_target') as closer:session.close()
        closer.assert_not_called();connection.new_browser_cdp_session.assert_not_called();connection.close.assert_called_once()

    def test_already_disconnected_browser_still_releases_lease(self):
        session=self.closing_session();lease=session._lease
        session._browser.close.side_effect=RuntimeError('disconnected')
        session.close();lease.release.assert_called_once()

    def test_wrong_browser_pid_cannot_be_adopted(self):
        pw,process,_=connection_fixture()
        with tempfile.TemporaryDirectory() as root,patch.object(browser,'find_real_chrome',return_value='chrome.exe'), \
             patch.object(browser,'_wait_for_devtools',return_value=ENDPOINT),patch.object(browser,'_browser_pid',return_value=456), \
             patch.object(browser.subprocess,'Popen',return_value=process):
            with self.assertRaisesRegex(RuntimeError,'Could not attach'):browser.AssistedSession(pw,root)
        process.terminate.assert_not_called();process.kill.assert_not_called()

    def test_endpoint_validation_rejects_external_or_ambiguous_browser_identity(self):
        self.assertEqual(browser._endpoint_port(ENDPOINT),9333)
        for value in ['http://127.0.0.1:9333','ws://example.com:9333/devtools/browser/a','ws://127.0.0.1:9333/devtools/page/a','ws://127.0.0.1:9333/devtools/browser/a?token=x']:
            with self.subTest(value=value),self.assertRaises(ValueError):browser._endpoint_port(value)


if __name__=='__main__':unittest.main()
