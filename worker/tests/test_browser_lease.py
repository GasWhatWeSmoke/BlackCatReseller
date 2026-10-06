import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.browser_lease import BrowserLease


class BrowserLeaseTests(unittest.TestCase):
    def test_competing_owner_waits_or_times_out_and_exception_releases(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, 'browser.lock')
            with self.assertRaisesRegex(ValueError, 'caller failed'):
                with BrowserLease(path):
                    with self.assertRaises(TimeoutError):
                        with BrowserLease(path, timeout=0.02):
                            self.fail('Two owners acquired one browser')
                    raise ValueError('caller failed')
            with BrowserLease(path, timeout=0):
                pass

    def test_process_exit_releases_lock_without_deleting_runtime_file(self):
        with tempfile.TemporaryDirectory() as root:
            path, ready = Path(root, 'browser.lock'), Path(root, 'ready')
            code = '''import sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from black_cat_worker.browser_lease import BrowserLease
with BrowserLease(sys.argv[2]):
 Path(sys.argv[3]).write_text('ready')
 time.sleep(60)
'''
            process = subprocess.Popen([sys.executable, '-c', code, str(Path(__file__).resolve().parents[1]), str(path), str(ready)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), 'Child did not acquire its browser lease')
                with self.assertRaises(TimeoutError):
                    BrowserLease(path, timeout=0).acquire()
                process.terminate()
                process.wait(timeout=5)
                with BrowserLease(path, timeout=1):
                    self.assertTrue(path.exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
