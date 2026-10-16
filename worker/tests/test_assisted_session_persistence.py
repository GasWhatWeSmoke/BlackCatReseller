"""Real beta8 target-only cleanup using an isolated synthetic Chrome profile."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import AssistedSession,find_real_chrome
from black_cat_worker.browser_lease import BrowserLease


class AssistedSessionPersistenceTests(unittest.TestCase):
    def test_owned_target_closes_other_window_survives_and_profile_state_persists(self):
        with tempfile.TemporaryDirectory(prefix='blackcat-profile-close-') as folder,sync_playwright() as pw:
            profile=Path(folder).resolve()
            browser_path=find_real_chrome() or pw.chromium.executable_path
            lock_path=profile/'.fixture-browser.lock'
            for round_number in range(2):
                port_file=profile/'DevToolsActivePort';port_file.unlink(missing_ok=True)
                process=subprocess.Popen([browser_path,'--headless=new',f'--user-data-dir={profile}',
                    '--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],
                    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                connection=None;lease=BrowserLease(lock_path,timeout=0).acquire()
                try:
                    deadline=time.monotonic()+20
                    while not port_file.exists() and time.monotonic()<deadline:
                        self.assertIsNone(process.poll(),'Fixture Chrome exited before attachment');time.sleep(.05)
                    port,route=port_file.read_text().splitlines()[:2]
                    endpoint=f'ws://127.0.0.1:{port}{route}'
                    connection=pw.chromium.connect_over_cdp(endpoint)
                    context=connection.contexts[0]
                    context.route('**/*',lambda request:request.fulfill(content_type='text/html',body='<h1>Local fixture</h1>'))
                    unrelated=context.new_page();unrelated.goto('https://fixture.invalid/unrelated')
                    page=context.new_page();page.goto('https://fixture.invalid/state')
                    identity=context.new_cdp_session(page)
                    target=identity.send('Target.getTargetInfo')['targetInfo']['targetId'];identity.detach()
                    if round_number==0:page.evaluate("localStorage.setItem('synthetic-state','preserve-me')")
                    else:self.assertEqual(page.evaluate("localStorage.getItem('synthetic-state')"),'preserve-me')
                    session=AssistedSession.__new__(AssistedSession)
                    session._proc,session._browser,session._ctx,session.page,session._lease=process,connection,context,page,lease
                    session._endpoint,session._target_id=endpoint,target
                    process.terminate=MagicMock(wraps=process.terminate);process.kill=MagicMock(wraps=process.kill)
                    session.close()
                    self.assertIsNone(process.poll(),'Closing one work target must preserve the browser process')
                    process.terminate.assert_not_called();process.kill.assert_not_called()
                    with BrowserLease(lock_path,timeout=0):pass
                    connection=pw.chromium.connect_over_cdp(endpoint)
                    cdp=connection.new_browser_cdp_session()
                    targets=cdp.send('Target.getTargets')['targetInfos']
                    self.assertFalse(any(value['targetId']==target for value in targets))
                    self.assertTrue(any(value.get('url')=='https://fixture.invalid/unrelated' for value in targets))
                    # The TEST owns every remaining fixture window. Shut down
                    # explicitly to test storage flush; production close never does.
                    cdp.send('Browser.close');process.wait(timeout=8)
                    preferences=json.loads((profile/'Default/Preferences').read_text())
                    self.assertEqual(preferences['profile']['exit_type'],'Normal')
                finally:
                    if process.poll() is None:process.kill();process.wait(timeout=8)
                    if connection is not None:connection.close()
                    lease.release()


if __name__=='__main__':unittest.main()
