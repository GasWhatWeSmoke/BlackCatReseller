import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.chrome_session import session_endpoint, _read_receipt, _check, _startup_lock


class ChromeSessionTests(unittest.TestCase):
    def receipt(self, directory, owner=321):
        endpoint = "ws://127.0.0.1:12345/fixture-session"
        Path(directory, "native-chrome-session.json").write_text(json.dumps({
            "version": 1, "ownerPid": owner, "pid": 654, "endpoint": endpoint}))
        return endpoint

    def test_orphan_empty_lock_allows_exactly_one_start_and_then_reuses_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory, "native-chrome-session-start.lock")
            lock.touch()
            def start(*args, **kwargs):
                intent = json.loads(Path(directory, "native-chrome-session-start.json").read_text())
                self.assertEqual(intent, {"version": 1, "ownerPid": 321})
                self.receipt(directory)
                return MagicMock(pid=654)
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session._check", return_value="fixture") as check, \
                    patch("black_cat_worker.chrome_session.subprocess.Popen", side_effect=start) as launch:
                for _ in range(3):
                    self.assertEqual(session_endpoint("work-window-v1"), "fixture")
                self.assertEqual(launch.call_count, 1)
                self.assertEqual(check.call_count, 3)
                self.assertEqual(check.call_args.args[2], "work-window-v1")
            self.assertTrue(lock.exists())
            with _startup_lock(lock):
                pass

    def test_live_startup_lock_blocks_another_process_and_process_death_releases_it(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory, "start.lock")
            ready = Path(directory, "ready")
            worker = str(Path(__file__).resolve().parents[1])
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            script = """import os,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from black_cat_worker.chrome_session import _startup_lock
with _startup_lock(Path(sys.argv[2])):
    Path(sys.argv[3]).write_text(str(os.getpid()))
    time.sleep(60)
"""
            # A Windows venv python.exe is a launcher with a separate child.
            # Kill the actual lock owner, not that wrapper, to model process death.
            child = subprocess.Popen([sys._base_executable, "-c", script, worker, str(lock), str(ready)],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, creationflags=flags)
            try:
                deadline = time.monotonic() + 10
                while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "Fixture lock owner did not start")
                self.assertEqual(int(ready.read_text()), child.pid)
                for _ in range(3):
                    with self.assertRaisesRegex(RuntimeError, "already starting"):
                        with _startup_lock(lock):
                            self.fail("Two processes acquired the same startup lock")
                child.kill()
                child.wait(timeout=5)
                for _ in range(3):
                    with _startup_lock(lock):
                        self.assertTrue(lock.exists())
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)

    def test_exception_releases_lock_without_replacing_its_file(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory, "start.lock")
            with self.assertRaisesRegex(ValueError, "fixture failure"):
                with _startup_lock(lock):
                    identity = lock.stat().st_ino
                    raise ValueError("fixture failure")
            with _startup_lock(lock):
                self.assertEqual(lock.stat().st_ino, identity)

    def test_timeout_retains_start_intent_and_retries_never_spawn_again(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen", return_value=MagicMock(pid=654)) as launch, \
                    patch("black_cat_worker.chrome_session._check") as check:
                with patch("black_cat_worker.chrome_session.time.monotonic", side_effect=[0, 9]):
                    with self.assertRaisesRegex(RuntimeError, "Could not start"):
                        session_endpoint()
                for _ in range(3):
                    with patch("black_cat_worker.chrome_session.time.monotonic", side_effect=[0, 9]):
                        with self.assertRaisesRegex(RuntimeError, "retry to wait for the same helper"):
                            session_endpoint()
                self.assertEqual(launch.call_count, 1)
                check.assert_not_called()
                self.assertTrue(Path(directory, "native-chrome-session-start.json").exists())

    def test_interrupted_caller_waits_for_the_same_late_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "native-chrome-session-start.json").write_text(json.dumps({"version": 1, "ownerPid": 321}))
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen") as launch, \
                    patch("black_cat_worker.chrome_session.time.monotonic", side_effect=[0, 0, 0]), \
                    patch("black_cat_worker.chrome_session.time.sleep", side_effect=lambda _: self.receipt(directory)), \
                    patch("black_cat_worker.chrome_session._check", return_value="same-helper") as check:
                self.assertEqual(session_endpoint(), "same-helper")
                launch.assert_not_called()
                self.assertEqual(check.call_count, 1)

    def test_known_spawn_failure_clears_intent_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen", side_effect=OSError("fixture launch failed")) as launch:
                for _ in range(2):
                    with self.assertRaisesRegex(OSError, "fixture launch failed"):
                        session_endpoint()
                    self.assertFalse(Path(directory, "native-chrome-session-start.json").exists())
                self.assertEqual(launch.call_count, 2)

    def test_verified_exited_child_without_receipt_allows_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            child = MagicMock(pid=654)
            child.poll.return_value = 1
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen", return_value=child) as launch:
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, "Could not start"):
                        session_endpoint()
                    self.assertFalse(Path(directory, "native-chrome-session-start.json").exists())
                self.assertEqual(launch.call_count, 2)

    def test_app_restart_can_replace_previous_owners_unconfirmed_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "native-chrome-session-start.json").write_text(json.dumps({"version": 1, "ownerPid": 123}))
            def start(*args, **kwargs):
                self.receipt(directory)
                return MagicMock(pid=654)
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen", side_effect=start) as launch, \
                    patch("black_cat_worker.chrome_session._check", return_value="fixture"):
                self.assertEqual(session_endpoint(), "fixture")
                self.assertEqual(launch.call_count, 1)
                self.assertEqual(json.loads(Path(directory, "native-chrome-session-start.json").read_text())["ownerPid"], 321)

    def test_unreadable_start_record_or_failed_intent_write_prevents_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            attempt = Path(directory, "native-chrome-session-start.json")
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen") as launch:
                for value in ["{", "null", "[]", '{"version":1,"ownerPid":true}', '{"version":2,"ownerPid":321}']:
                    attempt.write_text(value)
                    with self.assertRaisesRegex(RuntimeError, "startup record could not be verified"):
                        session_endpoint()
                    self.assertEqual(attempt.read_text(), value)
                attempt.unlink()
                with patch("black_cat_worker.chrome_session.os.replace", side_effect=OSError("fixture disk failed")):
                    with self.assertRaisesRegex(OSError, "fixture disk failed"):
                        session_endpoint()
                self.assertFalse(attempt.exists())
                self.assertEqual(list(Path(directory).glob("*.tmp")), [])
                launch.assert_not_called()

    def test_cleanup_wait_and_transient_health_error_poll_the_same_helper(self):
        receipt = {"pid": 654, "endpoint": "ws://127.0.0.1:12345/private-token"}
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = [json.dumps({"pid": 654, "ownerPid": 321, "busy": True}).encode(),
                                    json.dumps({"pid": 654, "ownerPid": 321, "busy": False}).encode()]
        opener = MagicMock()
        opener.open.side_effect = [TimeoutError(), response, response]
        with patch("black_cat_worker.chrome_session.build_opener", return_value=opener), patch("black_cat_worker.chrome_session.time.sleep"):
            self.assertEqual(_check(receipt, 321), receipt["endpoint"])
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(len({call.args[0] for call in opener.open.call_args_list}), 1)

    def test_repeated_workers_reuse_same_owner_receipt_without_spawning(self):
        with tempfile.TemporaryDirectory() as directory:
            endpoint = "ws://127.0.0.1:12345/private-token"
            Path(directory, "native-chrome-session.json").write_text(json.dumps({"version": 1, "ownerPid": 321, "pid": 654, "endpoint": endpoint}))
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session._check", return_value=endpoint), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen") as launch:
                for _ in range(5): self.assertEqual(session_endpoint(), endpoint)
                launch.assert_not_called()

    def test_failed_same_owner_session_never_relaunches_and_reprompts(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "native-chrome-session.json").write_text(json.dumps({"version": 1, "ownerPid": 321, "pid": 654, "endpoint": "ws://127.0.0.1:12345/private-token"}))
            with patch.dict(os.environ, {"BLACKCAT_DATA_ROOT": directory, "BLACKCAT_CHROME_OWNER_PID": "321"}), \
                    patch("black_cat_worker.chrome_session._check", side_effect=RuntimeError("session ended")), \
                    patch("black_cat_worker.chrome_session.subprocess.Popen") as launch:
                with self.assertRaisesRegex(RuntimeError, "session ended"): session_endpoint()
                launch.assert_not_called()

    def test_receipt_cannot_redirect_worker_to_external_debugging_server(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "receipt.json")
            for endpoint in ["ws://example.com:12345/private-token", "ws://user:secret@127.0.0.1:12345/token", "https://127.0.0.1:12345/token"]:
                path.write_text(json.dumps({"version": 1, "endpoint": endpoint}))
                with self.assertRaises(RuntimeError): _read_receipt(path)


if __name__ == "__main__": unittest.main()
