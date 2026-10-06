"""End-marker groups must not be split by the file stability window."""
import contextlib
import io
import math
import os
import sqlite3
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import process
from black_cat_worker.decode import DecodeOutcome
from black_cat_worker.managed_vision import ManagedVisionCancelled


class Clock:
    def __init__(self):
        self.epoch = time.time()
        self.elapsed = 0
        self.on_sleep = lambda: None

    def now(self): return self.epoch + self.elapsed
    def monotonic(self): return self.elapsed
    def sleep(self, seconds):
        self.elapsed += seconds
        self.on_sleep()


class Decoder:
    def __init__(self, _settings): pass
    def engine_status(self):
        return {"qr_opencv": True, "qr_pyzbar": True, "ocr_paddle": True}
    def decode(self, filename):
        return (DecodeOutcome("000001", "000001", "qr-opencv", True)
                if Path(filename).name == "002.jpg" else DecodeOutcome(None, None, None))


class IntakeStabilityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="blackcat-intake-settle-")
        self.root = Path(self.directory.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("blackcat-intake-settle-"))
        self.addCleanup(self.directory.cleanup)
        self.settings = {key: str(self.root / name) for key, name in [
            ("incomingPath", "incoming"), ("processingPath", "processing"),
            ("needsReviewPath", "review"), ("archivePath", "archive"),
            ("readyPath", "ready"), ("exportsPath", "exports"),
            ("logsPath", "logs"), ("backupsPath", "backups")]}
        self.settings.update(visionEnabled=False, fileStabilitySeconds=2)
        self.incoming = Path(self.settings["incomingPath"])
        self.incoming.mkdir()
        self.clock = Clock()
        self.photo = self.make_photo("001.jpg", self.clock.epoch - 10)
        self.marker = self.make_photo("002.jpg", self.clock.epoch)

    def make_photo(self, name, modified):
        filename = self.incoming / name
        Image.new("RGB", (40, 50), "blue" if name == "001.jpg" else "white").save(filename)
        os.utime(filename, (modified, modified))
        return filename

    @contextlib.contextmanager
    def runtime(self):
        with contextlib.ExitStack() as stack:
            # Settling tests use a valid empty inventory; unavailability is tested
            # separately because real intake must now reject it before mutation.
            database = sqlite3.connect(":memory:")
            database.executescript("CREATE TABLE Item(sku TEXT); CREATE TABLE FileHash(sha256 TEXT);")
            stack.callback(database.close)
            stack.enter_context(patch.object(process.dbmod, "connect", return_value=database))
            stack.enter_context(patch.object(process.config, "load_settings", return_value=self.settings))
            stack.enter_context(patch.object(process, "Decoder", Decoder))
            stack.enter_context(patch.object(process.time, "time", self.clock.now))
            stack.enter_context(patch.object(process.time, "monotonic", self.clock.monotonic))
            stack.enter_context(patch.object(process.time, "sleep", self.clock.sleep))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield

    def run_worker(self, cancel=lambda: None, dry=False):
        return process.run(SimpleNamespace(incoming=None, dry_run=dry), cancel_check=cancel)

    def test_young_marker_waits_then_closes_the_older_product_photo(self):
        with self.runtime(): result = self.run_worker()
        self.assertGreaterEqual(self.clock.elapsed, 2)
        self.assertEqual(["000001"], [item["sku"] for item in result["items"]])
        self.assertFalse(result["items"][0]["placeholder"])
        self.assertEqual(2, result["counts"]["photosProcessed"])
        self.assertEqual([False, True], [photo["isMarker"] for photo in result["items"][0]["photos"]])
        self.assertTrue(self.photo.exists() and self.marker.exists())

    def test_new_files_arriving_during_settling_are_included(self):
        def arrive():
            if not (self.incoming / "003.jpg").exists(): self.make_photo("003.jpg", self.clock.now())
        self.clock.on_sleep = arrive
        with self.runtime():
            files, _ = process._settled_incoming(str(self.incoming), 2, lambda: None)
        self.assertEqual({"001.jpg", "002.jpg", "003.jpg"}, {Path(value).name for value in files})
        self.assertGreaterEqual(self.clock.elapsed, 2.25)

    def test_continuously_changing_input_times_out_without_mutation(self):
        before = {file.name: file.read_bytes() for file in self.incoming.iterdir()}
        with self.runtime(), patch.object(process, "MAX_INCOMING_SETTLE_SECONDS", 1), \
                patch.object(process.fileops, "is_stable", return_value=False), \
                patch.object(process.config, "ensure_dirs") as mutation:
            with self.assertRaisesRegex(RuntimeError, "still being copied"):
                self.run_worker()
        mutation.assert_not_called()
        self.assertEqual(1, self.clock.elapsed)
        self.assertEqual(before, {file.name: file.read_bytes() for file in self.incoming.iterdir()})

    def test_cancellation_remains_observable_while_waiting(self):
        def cancel():
            if self.clock.elapsed: raise ManagedVisionCancelled("cancelled during settling")
        with self.runtime(), patch.object(process.config, "ensure_dirs") as mutation:
            with self.assertRaises(ManagedVisionCancelled): self.run_worker(cancel)
        mutation.assert_not_called()
        self.assertTrue(self.photo.exists() and self.marker.exists())

    def test_unreadable_photo_names_the_file_and_preserves_the_complete_input(self):
        before = {file.name: file.read_bytes() for file in self.incoming.iterdir()}
        with self.runtime(), patch.object(process, 'get_exif', return_value=(None, None, None, None)), \
                patch.object(process.config, 'ensure_dirs') as mutation:
            with self.assertRaisesRegex(RuntimeError, r'001\.jpg.*dimensions could not be verified'):
                self.run_worker()
        mutation.assert_not_called()
        self.assertEqual(before, {file.name: file.read_bytes() for file in self.incoming.iterdir()})

    def test_input_added_after_analysis_stops_before_any_copy(self):
        def enrich(items, *_args, **_kwargs):
            self.make_photo("003.jpg", self.clock.now())
            return {id(item): {} for item in items}
        with self.runtime(), patch.object(process, "_precompute_enrichments", side_effect=enrich), \
                patch.object(process.config, "ensure_dirs") as mutation:
            with self.assertRaisesRegex(RuntimeError, "Incoming files changed"):
                self.run_worker()
        mutation.assert_not_called()
        self.assertFalse(Path(self.settings["processingPath"]).exists())
        self.assertTrue(self.photo.exists() and self.marker.exists())

    def test_dry_run_includes_young_files_without_waiting_or_writing(self):
        with self.runtime(): result = self.run_worker(dry=True)
        self.assertEqual(0, self.clock.elapsed)
        self.assertEqual("000001", result["items"][0]["sku"])
        self.assertFalse(Path(self.settings["processingPath"]).exists())

    def test_invalid_stability_values_fail_before_mutation(self):
        for value in [-1, math.inf, math.nan]:
            with self.subTest(value=value), self.runtime(), self.assertRaisesRegex(RuntimeError, "File stability"):
                process._settled_incoming(str(self.incoming), value, lambda: None)


if __name__ == "__main__": unittest.main()
