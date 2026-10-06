"""Offline protocol tests for managed re-identification and probe receipts."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock


WORKER = pathlib.Path(__file__).resolve().parents[1]
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from black_cat_worker import reenrich_batch as batch  # noqa: E402
from black_cat_worker import managed_vision as managed  # noqa: E402
from black_cat_worker.managed_vision import (  # noqa: E402
    ManagedVisionCancelled,
    ManagedVisionDeferred,
)


def item(request_id="one", sku="000001"):
    return {
        "requestId": request_id,
        "sku": sku,
        "photos": [{
            "photoId": int(sku) + 1,
            "storedPath": f"C:/{sku}.jpg",
            "isMarker": False,
            "sha256": "a" * 64,
        }],
    }


class ReenrichBatchTests(unittest.TestCase):
    def setUp(self):
        # Protocol fixtures do not initialize a real OCR model.
        reader = mock.patch.object(batch.tag_ocr, "read_tags", return_value=None)
        self.tag_reader = reader.start()
        self.addCleanup(reader.stop)

    def test_enabled_tag_reading_reaches_enrichment_without_marker_photos(self):
        reading = object()
        self.tag_reader.return_value = reading
        spec = item()
        spec["photos"].append({**spec["photos"][0], "photoId": 99, "storedPath": "C:/marker.jpg", "isMarker": True})
        calls = []
        cancel = lambda: None
        @contextlib.contextmanager
        def session(_label):
            yield object()
        class Enricher:
            def __init__(self, *_args, **_kwargs): pass
            def enrich(self, sku, photos, tag_reading=None):
                calls.append(tag_reading)
                return {"fields": {"itemType": "Shirt"}}
        settings = {"visionEnabled": True, "tagOcrEnabled": True, "tagOcrMaxPhotos": 4}
        with mock.patch.object(batch, "_verify_photo_identities"):
            batch.run_batch([spec], settings=settings, cancel_check=cancel, session_factory=session, enricher_factory=Enricher)
        self.tag_reader.assert_called_once_with([spec["photos"][0]["storedPath"]], settings, cancel_check=cancel)
        self.assertEqual(calls, [reading])

    def test_disabled_vision_or_tag_ocr_does_not_initialize_tag_reader(self):
        @contextlib.contextmanager
        def session(_label): yield object()
        class Enricher:
            def __init__(self, *_args, **_kwargs): pass
            def enrich(self, _sku, _photos, tag_reading=None):
                self_readings.append(tag_reading)
                return {"fields": {"itemType": "Shirt"}}
        self_readings = []
        for settings in [{"visionEnabled": True, "tagOcrEnabled": False}, {"visionEnabled": False, "tagOcrEnabled": True}]:
            with mock.patch.object(batch, "_verify_photo_identities"):
                batch.run_batch([item()], settings=settings, cancel_check=lambda: None, session_factory=session, enricher_factory=Enricher)
        self.tag_reader.assert_not_called()
        self.assertEqual(self_readings, [None, None])

    def test_ordinary_ocr_failure_is_soft_but_cancel_and_deferral_unwind(self):
        events = []
        @contextlib.contextmanager
        def session(_label):
            try: yield object()
            finally: events.append("exit")
        class Enricher:
            def __init__(self, *_args, **_kwargs): pass
            def enrich(self, _sku, _photos, tag_reading=None):
                events.append(("ask", tag_reading))
                return {"fields": {"itemType": "Shirt"}}
        self.tag_reader.side_effect = RuntimeError("OCR unavailable")
        with mock.patch.object(batch, "_verify_photo_identities"):
            batch.run_batch([item()], settings={"visionEnabled": True}, cancel_check=lambda: None, session_factory=session, enricher_factory=Enricher)
        self.assertEqual(events, [("ask", None), "exit"])
        for failure in [ManagedVisionCancelled("stop"), ManagedVisionDeferred("busy")]:
            events.clear(); self.tag_reader.side_effect = failure
            with mock.patch.object(batch, "_verify_photo_identities"), self.assertRaises(type(failure)):
                batch.run_batch([item()], settings={"visionEnabled": True}, cancel_check=lambda: None, session_factory=session, enricher_factory=Enricher)
            self.assertEqual(events, ["exit"])

    def test_photo_change_during_ocr_stops_before_model_request(self):
        with tempfile.TemporaryDirectory() as root:
            photo = pathlib.Path(root, "photo.jpg"); photo.write_bytes(b"before")
            spec = item(); spec["photos"][0].update(storedPath=str(photo), sha256=hashlib.sha256(b"before").hexdigest())
            self.tag_reader.side_effect = lambda *_args, **_kwargs: photo.write_bytes(b"after")
            @contextlib.contextmanager
            def session(_label): yield object()
            enricher = mock.Mock()
            with mock.patch.object(batch, "get_exif", return_value=(None, None, 10, 10)), self.assertRaisesRegex(RuntimeError, "changed"):
                batch.run_batch([spec], settings={"visionEnabled": True, "processingPath": root}, cancel_check=lambda: None,
                    session_factory=session, enricher_factory=lambda *_args, **_kwargs: enricher)
            enricher.enrich.assert_not_called()

    def test_strict_spec_rejects_empty_transport_knobs_and_no_listing_photo(self):
        with self.assertRaisesRegex(ValueError, "between 1 and"):
            batch.validate_batch_spec({"items": []})
        forged = item()
        forged["model"] = "caller-selected"
        with self.assertRaisesRegex(ValueError, "only"):
            batch.validate_batch_spec({"items": [forged]})
        marker_only = item()
        marker_only["photos"][0]["isMarker"] = True
        with self.assertRaisesRegex(ValueError, "non-marker"):
            batch.validate_batch_spec({"items": [marker_only]})
        with self.assertRaisesRegex(ValueError, "only items"):
            batch.validate_batch_spec({"items": [item()], "api": "http://secret"})
        relative = item()
        relative["photos"][0]["storedPath"] = "relative/photo.jpg"
        with self.assertRaisesRegex(ValueError, "absolute"):
            batch.validate_batch_spec({"items": [relative]})

    def test_spec_reader_rejects_oversized_file_before_json_decode(self):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            path = pathlib.Path(handle.name)
            handle.truncate(batch._MAX_SPEC_BYTES + 1)
        try:
            with self.assertRaisesRegex(ValueError, "bounded regular file"):
                batch._read_json(str(path))
        finally:
            path.unlink(missing_ok=True)

    def test_one_session_covers_whole_batch_and_returns_after_exit(self):
        events = []

        @contextlib.contextmanager
        def session(label):
            events.append(("enter", label))
            try:
                yield object()
            finally:
                events.append("exit")

        class Enricher:
            def __init__(self, _settings, _client, cancel_check=None):
                self.cancel_check = cancel_check

            def enrich(self, sku, _photos, tag_reading=None):
                events.append(("ask", sku))
                return {"fields": {"itemType": sku}}

        with mock.patch.object(batch, "_verify_photo_identities"):
            result = batch.run_batch(
                [item("a", "000001"), item("b", "000002")],
                settings={"visionEnabled": True},
                cancel_check=lambda: None,
                session_factory=session,
                enricher_factory=Enricher,
            )
        events.append("published")
        self.assertEqual(1, sum(isinstance(value, tuple) and value[0] == "enter" for value in events))
        self.assertLess(events.index("exit"), events.index("published"))
        self.assertEqual(["a", "b"], [row["requestId"] for row in result["items"]])

    def test_restore_failure_produces_no_returnable_batch(self):
        @contextlib.contextmanager
        def session(_label):
            yield object()
            raise RuntimeError("restore failed")

        class Enricher:
            def __init__(self, *_args, **_kwargs):
                pass

            def enrich(self, _sku, _photos, tag_reading=None):
                return {"fields": {"itemType": "Hat"}}

        with mock.patch.object(batch, "_verify_photo_identities"), \
                self.assertRaisesRegex(RuntimeError, "restore failed"):
            batch.run_batch(
                [item()], settings={}, cancel_check=lambda: None,
                session_factory=session, enricher_factory=Enricher,
            )

    def test_changed_photo_bytes_unwind_before_result(self):
        with tempfile.TemporaryDirectory() as directory:
            photo_path = pathlib.Path(directory) / "photo.jpg"
            photo_path.write_bytes(b"before")
            spec_item = item()
            spec_item["photos"][0]["storedPath"] = str(photo_path)
            spec_item["photos"][0]["sha256"] = hashlib.sha256(b"before").hexdigest()
            events = []

            @contextlib.contextmanager
            def session(_label):
                events.append("enter")
                try:
                    yield object()
                finally:
                    events.append("exit")

            class Enricher:
                def __init__(self, *_args, **_kwargs):
                    pass

                def enrich(self, _sku, _photos, tag_reading=None):
                    events.append("ask")
                    photo_path.write_bytes(b"after")
                    return {"fields": {"itemType": "Hat"}}

            with mock.patch.object(batch, "get_exif", return_value=(None, None, 10, 10)), \
                    self.assertRaisesRegex(RuntimeError, "changed"):
                batch.run_batch(
                    [spec_item], settings={"processingPath": directory},
                    cancel_check=lambda: None,
                    session_factory=session, enricher_factory=Enricher,
                )
            self.assertEqual(["enter", "ask", "exit"], events)

    def test_photo_preflight_rejects_outside_link_and_oversized_dimensions(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            inside = pathlib.Path(root, "photo.jpg")
            inside.write_bytes(b"photo")
            spec_item = item()
            spec_item["photos"][0]["storedPath"] = str(inside)
            spec_item["photos"][0]["sha256"] = hashlib.sha256(b"photo").hexdigest()
            with mock.patch.object(batch, "get_exif", return_value=(None, None, 10, 10)):
                batch._verify_photo_identities(
                    [spec_item], lambda: None, {"processingPath": root},
                )

            outside_file = pathlib.Path(outside, "outside.jpg")
            outside_file.write_bytes(b"photo")
            spec_item["photos"][0]["storedPath"] = str(outside_file)
            with self.assertRaisesRegex(RuntimeError, "outside"):
                batch._verify_photo_identities(
                    [spec_item], lambda: None, {"processingPath": root},
                )

            spec_item["photos"][0]["storedPath"] = str(inside)
            with mock.patch.object(
                batch, "get_exif", return_value=(None, None, 20_000, 20_000),
            ), self.assertRaisesRegex(RuntimeError, "dimensions"):
                batch._verify_photo_identities(
                    [spec_item], lambda: None, {"processingPath": root},
                )

    def test_deferred_and_cancelled_are_bounded_typed_terminals(self):
        deferred = ManagedVisionDeferred(
            "busy at http://localhost:1234/private",
            verdict={"status": "ambiguous", "attempts": 3, "elapsed_s": 1.25,
                     "peers": [{"endpoint": "http://secret:8188"}]},
        )
        output = io.StringIO()
        with mock.patch("sys.stdout", output):
            self.assertEqual(75, batch._terminal_error(deferred))
        event = json.loads(output.getvalue())
        self.assertEqual("ambiguous", event["status"])
        self.assertEqual(3, event["attempts"])
        self.assertEqual(1.25, event["elapsedSeconds"])
        self.assertNotIn("localhost", output.getvalue())
        self.assertNotIn("secret", output.getvalue())

        output = io.StringIO()
        with mock.patch("sys.stdout", output):
            self.assertEqual(130, batch._terminal_error(ManagedVisionCancelled("cancel")))
        self.assertEqual("cancelled", json.loads(output.getvalue())["event"])

    def test_probe_is_one_image_ask_and_receipt_follows_exit(self):
        events = []

        class Client:
            def ask(self, messages, **kwargs):
                events.append(("ask", messages, kwargs))
                return "READY", {
                    "model": "blackcat-vision",
                    "response_model": "blackcat-vision",
                    "finish_reason": "stop",
                    "usage": {},
                }

        @contextlib.contextmanager
        def session(_label):
            events.append("enter")
            try:
                yield Client()
            finally:
                events.append("exit")

        receipt = batch.run_probe(
            settings={"visionTimeoutSeconds": 12}, cancel_check=lambda: None,
            session_factory=session,
        )
        events.append("published")
        asks = [event for event in events if isinstance(event, tuple) and event[0] == "ask"]
        self.assertEqual(1, len(asks))
        self.assertTrue(asks[0][1][0]["content"][1]["image_url"]["url"].startswith("data:image/"))
        self.assertEqual({
            "ok": True,
            "model": "blackcat-vision",
            "responseModel": "blackcat-vision",
        }, receipt)
        self.assertLess(events.index("exit"), events.index("published"))

    def test_probe_rejects_truncation_or_identity_mismatch(self):
        class Client:
            def __init__(self, meta):
                self.meta = meta

            def ask(self, *_args, **_kwargs):
                return "READY", self.meta

        for meta in (
            {"model": "m", "response_model": "m", "finish_reason": "length", "usage": {}},
            {"model": "m", "response_model": "other", "finish_reason": "stop", "usage": {}},
        ):
            @contextlib.contextmanager
            def session(_label, meta=meta):
                yield Client(meta)

            with self.assertRaises(RuntimeError):
                batch.run_probe(settings={}, cancel_check=lambda: None, session_factory=session)

    def test_real_local_http_probe_sends_tiny_image_and_exact_alias(self):
        requests = []
        authorizations = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                length = int(self.headers["Content-Length"])
                payload = json.loads(self.rfile.read(length))
                requests.append(payload)
                authorizations.append(self.headers.get("Authorization"))
                body = json.dumps({
                    "model": managed.VISION_MODEL_ALIAS,
                    "choices": [{
                        "message": {"role": "assistant", "content": "READY"},
                        "finish_reason": "stop",
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td, mock.patch.object(
                managed, "VISION_API_URL",
                f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
            ), mock.patch.object(
                managed, "_SESSION_LOCK_PATH", pathlib.Path(td) / "session.lock",
            ), mock.patch.object(
                managed.vision, "_read_local_vision_api_key", return_value="a" * 64,
            ):
                receipt = batch.run_probe(
                    settings={"visionTimeoutSeconds": 12}, cancel_check=lambda: None,
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual({
            "ok": True,
            "model": managed.VISION_MODEL_ALIAS,
            "responseModel": managed.VISION_MODEL_ALIAS,
        }, receipt)
        self.assertEqual(1, len(requests))
        self.assertEqual([f"Bearer {'a' * 64}"], authorizations)
        self.assertEqual(managed.VISION_MODEL_ALIAS, requests[0]["model"])
        content = requests[0]["messages"][0]["content"]
        images = [part for part in content if part.get("type") == "image_url"]
        self.assertEqual(1, len(images))
        self.assertTrue(images[0]["image_url"]["url"].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
