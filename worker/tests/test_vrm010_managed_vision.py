"""Focused offline contracts for VRM-010 managed Black Cat vision."""
from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


WORKER = pathlib.Path(__file__).resolve().parents[1]
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from black_cat_worker import config, decode, ocr_engine  # noqa: E402
from black_cat_worker import managed_vision as managed  # noqa: E402
from black_cat_worker import db as worker_db  # noqa: E402
from black_cat_worker import config as worker_config  # noqa: E402
from black_cat_worker import process  # noqa: E402
from black_cat_worker.grouping import (  # noqa: E402
    DecodedPhoto,
    GroupedItem,
)

READ_LOCAL_VISION_API_KEY = managed.vision._read_local_vision_api_key


class FakeResponse:
    def __init__(self, envelope):
        self.body = envelope if isinstance(envelope, bytes) else json.dumps(envelope).encode()
        self.closed = False

    def read(self, maximum=-1):
        return self.body if maximum is None or maximum < 0 else self.body[:maximum]

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.close()

    def close(self):
        self.closed = True


def completion(
    content='{"category":"hat","itemType":"bucket hat"}', *,
    model=managed.VISION_MODEL_ALIAS, finish="stop", reasoning=None,
):
    message = {"role": "assistant", "content": content}
    if reasoning is not None:
        message["reasoning_content"] = reasoning
    return {
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 4, "completion_tokens": 8, "private": 99},
        "timings": {
            "cache_n": 2,
            "prompt_n": 4,
            "prompt_ms": 12.5,
            "prompt_per_second": 320.0,
            "predicted_n": 8,
            "predicted_ms": 20.0,
            "predicted_per_token_ms": 2.5,
            "predicted_per_second": 400.0,
            "draft_n": -1,
            "private_metric": 999,
        },
    }


class RecordingOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, request, *, timeout):
        self.calls.append({
            "url": request.full_url,
            "payload": json.loads(request.data),
            "timeout": timeout,
            "authorization": request.get_header("Authorization"),
        })
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return FakeResponse(response)


class ApiCredentialTests(unittest.TestCase):
    def test_relocated_assets_use_the_same_fixed_credential_and_session_lock(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-vision-runtime-") as td:
            root = pathlib.Path(td) / "persistent vision"
            root.mkdir()
            credential = root / "api-key.txt"
            credential.write_text(f"{'b' * 64}\n", encoding="utf-8", newline="\n")
            with mock.patch.dict(os.environ, {"BLACKCAT_VISION_ROOT": str(root)}):
                self.assertEqual(root.resolve(), managed.vision.local_vision_asset_root())
                self.assertEqual("b" * 64, READ_LOCAL_VISION_API_KEY())
                self.assertEqual(root / "run" / "session.lock", managed._session_lock_path())
                with managed._session_file_lock():
                    self.assertTrue((root / "run" / "session.lock").is_file())
                credential.write_text("invalid", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "invalid"):
                    READ_LOCAL_VISION_API_KEY()

    def test_vision_root_override_must_be_absolute_and_dedicated(self):
        project_root = pathlib.Path(managed.vision.__file__).resolve().parents[2]
        for value in ("../relative", str(project_root), project_root.anchor):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"BLACKCAT_VISION_ROOT": value}):
                with self.assertRaisesRegex(RuntimeError, "absolute|dedicated"):
                    managed.vision.local_vision_asset_root()
                with self.assertRaisesRegex(RuntimeError, "absolute|dedicated"):
                    managed._session_lock_path()
        with mock.patch.dict(os.environ, {"BLACKCAT_VISION_ROOT": ""}):
            self.assertEqual(project_root / ".local" / "vision", managed.vision.local_vision_asset_root())
            self.assertEqual(managed._SESSION_LOCK_PATH, managed._session_lock_path())

    def test_reader_requires_one_exact_lowercase_256_bit_secret(self):
        with tempfile.TemporaryDirectory() as td:
            credential = pathlib.Path(td) / "api-key.txt"
            with mock.patch.object(managed.vision, "_LOCAL_VISION_API_KEY_FILE", credential):
                with self.assertRaisesRegex(RuntimeError, "missing"):
                    READ_LOCAL_VISION_API_KEY()
                credential.write_text(f"{'a' * 64}\n", encoding="utf-8", newline="\n")
                self.assertEqual("a" * 64, READ_LOCAL_VISION_API_KEY())
                credential.write_text(f"{'A' * 64}\n", encoding="utf-8", newline="\n")
                with self.assertRaisesRegex(RuntimeError, "invalid"):
                    READ_LOCAL_VISION_API_KEY()
                credential.write_text(f"{'a' * 64}\n\n", encoding="utf-8", newline="\n")
                with self.assertRaisesRegex(RuntimeError, "invalid"):
                    READ_LOCAL_VISION_API_KEY()


class ManagedAdapterTests(unittest.TestCase):
    def setUp(self):
        self.api_key = "a" * 64
        self.api_key_patch = mock.patch.object(
            managed.vision, "_read_local_vision_api_key", return_value=self.api_key,
        )
        self.api_key_patch.start()

    def tearDown(self):
        managed._ACTIVE_CLIENT.set(None)
        self.api_key_patch.stop()

    def test_client_uses_only_fixed_loopback_url_and_exact_alias(self):
        opener = RecordingOpener(completion())
        client = managed.ManagedVisionClient(opener=opener)
        messages = [{"role": "user", "content": "inspect"}]
        text, meta = client.ask(
            messages, max_tokens=100, temperature=0.1, timeout_s=9,
        )

        self.assertEqual('{"category":"hat","itemType":"bucket hat"}', text)
        self.assertEqual(managed.VISION_API_URL, opener.calls[0]["url"])
        self.assertEqual(managed.VISION_MODEL_ALIAS, opener.calls[0]["payload"]["model"])
        self.assertEqual(messages, opener.calls[0]["payload"]["messages"])
        self.assertEqual(f"Bearer {self.api_key}", opener.calls[0]["authorization"])
        self.assertFalse(opener.calls[0]["payload"]["stream"])
        self.assertEqual({
            "usage": {"prompt_tokens": 4, "completion_tokens": 8},
            "timings": {
                "cache_n": 2,
                "prompt_n": 4,
                "prompt_ms": 12.5,
                "prompt_per_second": 320.0,
                "predicted_n": 8,
                "predicted_ms": 20.0,
                "predicted_per_token_ms": 2.5,
                "predicted_per_second": 400.0,
            },
            "finish_reason": "stop",
            "model": managed.VISION_MODEL_ALIAS,
            "response_model": managed.VISION_MODEL_ALIAS,
            "reasoning_chars": 0,
            "reasoning_chars_capped": False,
        }, meta)
        self.assertFalse(hasattr(client, "api"))
        self.assertFalse(hasattr(client, "model"))

        bounded = managed._bounded_answer_metadata({"timings": {
            "prompt_n": 0,
            "prompt_ms": float("nan"),
            "predicted_ms": float("inf"),
            "draft_n": True,
            "draft_n_accepted": managed._MAX_TIMING_VALUE + 1,
        }})
        self.assertEqual({"timings": {"prompt_n": 0}}, bounded)

    def test_legacy_fixed_local_transport_also_sends_bearer_auth(self):
        opener = RecordingOpener(completion())
        enricher = managed.vision.VisionEnricher({"visionEnabled": True})
        enricher._opener = opener

        text = enricher._call(["aW1n"])

        self.assertIn('"category":"hat"', text)
        self.assertEqual(managed.VISION_API_URL, opener.calls[0]["url"])
        self.assertEqual(f"Bearer {self.api_key}", opener.calls[0]["authorization"])

    def test_default_transport_ignores_proxies_and_rejects_redirects(self):
        with mock.patch.object(
            managed.urllib.request, "getproxies",
            side_effect=AssertionError("environment proxy must not be consulted"),
        ):
            client = managed.ManagedVisionClient()
        director = client._opener.__self__
        proxy_handlers = [
            handler for handler in director.handlers
            if isinstance(handler, managed.urllib.request.ProxyHandler)
        ]
        # build_opener removes its environment-derived default ProxyHandler
        # when an explicit empty handler is supplied; because that handler has
        # no protocol methods, it is intentionally absent from the final list.
        self.assertEqual([], proxy_handlers)
        self.assertTrue(any(
            isinstance(handler, managed.vision._RejectLocalVisionRedirects)
            for handler in director.handlers
        ))

        redirect = managed.vision._RejectLocalVisionRedirects()
        request = managed.urllib.request.Request(managed.VISION_API_URL)
        with self.assertRaisesRegex(managed.urllib.error.HTTPError, "redirects"):
            redirect.redirect_request(
                request, None, 302, "Found", {}, "https://proxy.invalid/photos",
            )

    def test_client_enforces_the_local_output_token_cap_before_http(self):
        opener = RecordingOpener(completion())
        client = managed.ManagedVisionClient(opener=opener)
        client.ask(
            [{"role": "user", "content": "inspect"}],
            max_tokens=managed.MAX_VISION_OUTPUT_TOKENS,
            temperature=0.0,
            timeout_s=10,
        )
        self.assertEqual(1, len(opener.calls))
        with self.assertRaisesRegex(ValueError, "1 to 1800"):
            client.ask(
                [{"role": "user", "content": "inspect"}],
                max_tokens=managed.MAX_VISION_OUTPUT_TOKENS + 1,
                temperature=0.0,
                timeout_s=10,
            )
        self.assertEqual(1, len(opener.calls))

    def test_enricher_requests_deterministic_temperature_and_retains_timings(self):
        opener = RecordingOpener(completion())
        enricher = managed.ManagedVisionEnricher(
            {"visionEnabled": True}, managed.ManagedVisionClient(opener=opener),
        )
        with mock.patch.object(
                managed.ManagedVisionEnricher, "_pick_images", return_value=["one.jpg"],
            ), mock.patch.object(
                managed.ManagedVisionEnricher, "_encode", return_value="aW1n",
            ):
            result = enricher.enrich("000001", [{}])
        self.assertEqual("Hat", result["fields"]["category"])
        self.assertEqual(0.0, opener.calls[0]["payload"]["temperature"])
        self.assertEqual(400.0, enricher.last_meta["timings"]["predicted_per_second"])
        self.assertNotIn("private_metric", enricher.last_meta["timings"])
        self.assertNotIn("draft_n", enricher.last_meta["timings"])

    def test_one_locked_session_is_reused_for_nested_batch_calls(self):
        events = []

        def factory():
            events.append("factory")
            return object()

        with tempfile.TemporaryDirectory() as td:
            lock_path = pathlib.Path(td) / "run" / "session.lock"
            with managed.managed_vision_session(
                "blackcat:test", _client_factory=factory, _lock_path=lock_path,
            ) as client:
                with managed.managed_vision_session("nested") as nested:
                    self.assertIs(client, nested)
                    self.assertTrue(lock_path.is_file())
            self.assertEqual(["factory"], events)

    def test_session_lock_is_cross_process_and_retryable_before_yield(self):
        with tempfile.TemporaryDirectory() as td:
            lock_path = pathlib.Path(td) / "run" / "session.lock"
            script = (
                "import pathlib,sys; "
                f"sys.path.insert(0,{str(WORKER)!r}); "
                "from black_cat_worker import managed_vision as m; "
                "p=pathlib.Path(sys.argv[1]); "
                "cm=m._session_file_lock(p); "
                "\ntry:\n cm.__enter__()\nexcept m.ManagedVisionDeferred:\n raise SystemExit(75)\n"
                "else:\n cm.__exit__(None,None,None)\n raise SystemExit(0)\n"
            )
            with managed._session_file_lock(lock_path):
                blocked = subprocess.run(
                    [sys.executable, "-c", script, str(lock_path)], check=False,
                    capture_output=True, text=True,
                )
            admitted = subprocess.run(
                [sys.executable, "-c", script, str(lock_path)], check=False,
                capture_output=True, text=True,
            )
        self.assertEqual(75, blocked.returncode, blocked.stderr)
        self.assertEqual(0, admitted.returncode, admitted.stderr)

    def test_wrong_model_is_a_hard_failure(self):
        client = managed.ManagedVisionClient(
            opener=RecordingOpener(completion(model="some-other-model")),
        )
        with self.assertRaisesRegex(RuntimeError, "did not match"):
            client.ask([], max_tokens=16, temperature=0.0, timeout_s=10)

    def test_empty_reasoning_only_and_truncated_answers_are_rejected(self):
        cases = [
            (completion(content=""), "no final answer"),
            (completion(content="", reasoning="private chain"), "reasoning without"),
            (completion(content="partial", finish="length"), "truncated"),
        ]
        for envelope, message in cases:
            with self.subTest(message=message):
                client = managed.ManagedVisionClient(opener=RecordingOpener(envelope))
                with self.assertRaisesRegex(managed.ManagedVisionAnswerError, message):
                    client.ask([], max_tokens=16, temperature=0.0, timeout_s=10)

    def test_enricher_reuses_parser_mapper_but_transport_errors_unwind(self):
        class Client:
            def __init__(self):
                self.calls = 0

            def ask(self, messages, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return ('```json\n{"category":"hat","itemType":"bucket hat",'
                            '"primaryColor":"black"}\n```', {"model": "managed"})
                raise RuntimeError("transport failed")

        client = Client()
        enricher = managed.ManagedVisionEnricher(
            {"visionEnabled": True, "visionApiUrl": "http://forged.invalid",
             "visionModel": "forged-model"}, client,
        )
        self.assertFalse(hasattr(enricher, "url"))
        self.assertFalse(hasattr(enricher, "model"))
        self.assertFalse(hasattr(enricher, "_note_endpoint_failure"))
        with mock.patch.object(
                managed.ManagedVisionEnricher, "_pick_images",
                return_value=["one.jpg"],
            ), mock.patch.object(
                managed.ManagedVisionEnricher, "_encode", return_value="aW1n",
            ):
            result = enricher.enrich("000001", [{}])
            self.assertEqual("Hat", result["fields"]["category"])
            self.assertEqual("Bucket Hat", result["fields"]["itemType"])
            with self.assertRaisesRegex(RuntimeError, "transport failed"):
                enricher.enrich("000002", [{}])

    def test_empty_final_is_soft_retried_once(self):
        opener = RecordingOpener(
            completion(content="", reasoning="private chain"),
            completion(content="", reasoning="private chain"),
        )
        client = managed.ManagedVisionClient(opener=opener)
        enricher = managed.ManagedVisionEnricher({"visionEnabled": True}, client)
        with mock.patch.object(
                managed.ManagedVisionEnricher, "_pick_images",
                return_value=["one.jpg"],
            ), mock.patch.object(
                managed.ManagedVisionEnricher, "_encode", return_value="aW1n",
            ):
            result = enricher.enrich("000001", [{}])
        self.assertIn("vision call failed", result["error"])
        self.assertEqual(2, len(opener.calls))

    def test_final_truncation_metadata_survives_the_soft_retry(self):
        opener = RecordingOpener(
            completion(content="partial", finish="length"),
            completion(content="partial", finish="length"),
        )
        enricher = managed.ManagedVisionEnricher(
            {"visionEnabled": True}, managed.ManagedVisionClient(opener=opener),
        )
        with mock.patch.object(
                managed.ManagedVisionEnricher, "_pick_images", return_value=["one.jpg"],
            ), mock.patch.object(
                managed.ManagedVisionEnricher, "_encode", return_value="aW1n",
            ):
            result = enricher.enrich("000001", [{}])
        self.assertIn("truncated", result["error"])
        self.assertEqual("length", enricher.last_meta["finish_reason"])

    def test_malformed_enrichment_is_rejected_before_it_can_reach_ipc(self):
        class Client:
            def __init__(self):
                self.calls = 0

            def ask(self, *_args, **_kwargs):
                self.calls += 1
                return json.dumps({"brand": "X" * 513}), {"finish_reason": "stop"}

        client = Client()
        enricher = managed.ManagedVisionEnricher({"visionEnabled": True}, client)
        with mock.patch.object(
                managed.ManagedVisionEnricher, "_pick_images",
                return_value=["one.jpg"],
            ), mock.patch.object(
                managed.ManagedVisionEnricher, "_encode", return_value="aW1n",
            ):
            result = enricher.enrich("000001", [{}])
        self.assertEqual(2, client.calls)
        self.assertEqual({"error": "vision returned invalid structured output"}, result)

        with self.assertRaises(managed.ManagedVisionAnswerError):
            managed.validate_worker_enrichment({"raw": {"x": [[[[[[[[[1]]]]]]]]]}})
        with self.assertRaises(managed.ManagedVisionAnswerError):
            managed.validate_worker_enrichment({
                "fields": {"brand": "\U0001f408" * 300},
            })

    def test_aggregate_enrichment_budget_is_bounded_below_worker_line_cap(self):
        value = managed.validate_worker_enrichment({
            "raw": {"payload": "x" * 65_520},
        })
        with self.assertRaisesRegex(RuntimeError, "IPC safety limit"):
            managed.assert_enrichment_batch_budget([value] * 129)

    def test_one_photo_limit_selects_first_without_division_by_zero(self):
        enricher = managed.ManagedVisionEnricher(
            {"visionEnabled": True, "visionMaxPhotos": 1}, object(),
        )
        selected = enricher._pick_images([
            {"storedPath": "first.jpg", "isMarker": False},
            {"storedPath": "last.jpg", "isMarker": False},
        ])
        self.assertEqual(["first.jpg"], selected)

    def test_photo_selection_rejects_more_than_four_before_encoding(self):
        enricher = managed.ManagedVisionEnricher(
            {"visionEnabled": True, "visionMaxPhotos": managed.MAX_VISION_PHOTOS + 1},
            object(),
        )
        with self.assertRaisesRegex(ValueError, "between 1 and 4"):
            enricher._pick_images([{"storedPath": "one.jpg", "isMarker": False}])

    def test_cancel_is_checked_around_each_image_encode(self):
        events = []

        class Client:
            def ask(self, *_args, **_kwargs):
                events.append("ask")
                return '{"itemType":"Hat"}', {"finish_reason": "stop"}

        enricher = managed.ManagedVisionEnricher(
            {"visionEnabled": True}, Client(),
            cancel_check=lambda: events.append("cancel"),
        )
        with mock.patch.object(
            managed.ManagedVisionEnricher, "_pick_images",
            return_value=["one.jpg", "two.jpg"],
        ), mock.patch.object(
            managed.ManagedVisionEnricher, "_encode",
            side_effect=lambda path: events.append("encode:" + path) or "aW1n",
        ):
            result = enricher.enrich("000001", [{}])

        self.assertEqual(
            ["cancel", "encode:one.jpg", "cancel", "cancel", "encode:two.jpg", "cancel"],
            events[:6],
        )
        self.assertEqual("Hat", result["fields"]["itemType"])


class CancellationTests(unittest.TestCase):
    def test_mutation_fence_observes_cancel_before_seal_then_finishes_after(self):
        state = {"cancelled": False, "checks": 0}

        def check():
            state["checks"] += 1
            if state["cancelled"]:
                raise managed.ManagedVisionCancelled("cancel")

        fence = process.MutationCancellationFence(check)
        fence()
        fence.seal()
        state["cancelled"] = True
        fence()  # irreversible mutation phase must finish and publish its result
        self.assertEqual(2, state["checks"])

    def test_parent_token_is_bound_once_and_pid_reuse_cancels(self):
        state = {"token": "100"}
        guard = process.CancellationGuard(
            {process.PARENT_PID_ENV: "42"},
            token_fn=lambda _pid: state["token"],
        )
        guard()
        state["token"] = "101"
        with self.assertRaisesRegex(managed.ManagedVisionCancelled, "parent"):
            guard()

    def test_supplied_parent_token_must_match_at_start(self):
        with self.assertRaises(managed.ManagedVisionCancelled):
            process.CancellationGuard(
                {process.PARENT_PID_ENV: "42",
                 process.PARENT_CREATION_TOKEN_ENV: "101"},
                token_fn=lambda _pid: "100",
            )

    def test_absolute_cancel_file_is_checked_each_time(self):
        with tempfile.TemporaryDirectory() as td:
            cancel = str(pathlib.Path(td) / "cancel")
            state = {"exists": False}
            guard = process.CancellationGuard(
                {process.CANCEL_FILE_ENV: cancel},
                exists_fn=lambda _path: state["exists"],
            )
            guard()
            state["exists"] = True
            with self.assertRaisesRegex(managed.ManagedVisionCancelled, "requested"):
                guard()


class ReadOnlyDatabaseTests(unittest.TestCase):
    def test_missing_database_is_not_created_before_admission(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "missing.db"
            self.assertIsNone(worker_db.connect(str(path)))
            self.assertFalse(path.exists())

    def test_existing_database_opens_read_only(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "existing.db"
            writer = sqlite3.connect(path)
            writer.execute("CREATE TABLE Item(sku TEXT)")
            writer.commit()
            writer.close()
            reader = worker_db.connect(str(path))
            self.assertIsNotNone(reader)
            with self.assertRaises(sqlite3.OperationalError):
                reader.execute("INSERT INTO Item(sku) VALUES ('forbidden')")
            reader.close()

    def test_stale_managed_vision_values_are_bounded(self):
        normalized = worker_config._normalize_managed_vision_settings({
            "visionEnabled": "yes",
            "visionMaxPhotos": 0,
            "visionFields": [],
            "visionTimeoutSeconds": 99999,
            "visionMaxTokens": True,
            "visionApiUrl": "http://forged.invalid",
        })
        self.assertIs(normalized["visionEnabled"], False)
        self.assertEqual(4, normalized["visionMaxPhotos"])
        self.assertTrue(normalized["visionFields"])
        self.assertEqual(120, normalized["visionTimeoutSeconds"])
        self.assertEqual(1800, normalized["visionMaxTokens"])
        self.assertNotIn("visionApiUrl", normalized)

        at_cap = worker_config._normalize_managed_vision_settings({
            "visionMaxPhotos": 4,
            "visionMaxTokens": 1800,
        })
        self.assertEqual(4, at_cap["visionMaxPhotos"])
        self.assertEqual(1800, at_cap["visionMaxTokens"])

        above_cap = worker_config._normalize_managed_vision_settings({
            "visionMaxPhotos": 5,
            "visionMaxTokens": 1801,
        })
        self.assertEqual(4, above_cap["visionMaxPhotos"])
        self.assertEqual(1800, above_cap["visionMaxTokens"])


class OfflineDependencyTests(unittest.TestCase):
    def setUp(self):
        # The OCR engine is memoized per process so decode.py and tag_ocr.py
        # share one PP-OCRv5 instead of loading it twice. These tests patch the
        # paddleocr module to observe construction, so each needs the cache
        # cleared or it would assert against the engine the previous test built.
        ocr_engine.reset_shared_engine()
        self.addCleanup(ocr_engine.reset_shared_engine)

    def test_paddle_constructor_is_cpu_pinned_on_every_compatible_shape(self):
        calls = []
        paddle_module = types.ModuleType("paddleocr")

        def paddle_ocr(**kwargs):
            calls.append(kwargs)
            if "use_doc_orientation_classify" in kwargs:
                raise TypeError("older 3.x shape")
            return object()

        paddle_module.PaddleOCR = paddle_ocr
        decoder = decode.Decoder({})
        with mock.patch.dict(sys.modules, {"paddleocr": paddle_module}):
            self.assertIsNot(False, decoder._ensure_paddle())
        self.assertGreaterEqual(len(calls), 2)
        self.assertTrue(all(call.get("device") == "cpu" for call in calls))

    def test_paddle_fails_closed_when_explicit_cpu_is_not_supported(self):
        calls = []
        paddle_module = types.ModuleType("paddleocr")

        def paddle_ocr(**kwargs):
            calls.append(kwargs)
            raise TypeError("device unsupported")

        paddle_module.PaddleOCR = paddle_ocr
        decoder = decode.Decoder({})
        with mock.patch.dict(sys.modules, {"paddleocr": paddle_module}):
            self.assertIs(False, decoder._ensure_paddle())
        self.assertEqual(4, len(calls))
        self.assertTrue(all(call.get("device") == "cpu" for call in calls))

    def test_python_settings_strip_all_legacy_vision_controls(self):
        forged = {
            "visionEnabled": True,
            "visionMaxPhotos": 3,
            "visionFields": ["brand"],
            "visionTimeoutSeconds": 90,
            "visionMaxTokens": 1200,
            "visionApiUrl": "http://forged.invalid",
            "visionModel": "forged-model",
            "visionAutoStart": True,
            "visionServerPort": 9999,
            "visionModelPath": "C:/forged/model.gguf",
            "unrelatedSetting": "preserved",
        }
        with mock.patch.object(config, "default_settings", return_value={
                "visionApiUrl": "http://default.invalid",
                "unrelatedDefault": True,
            }), mock.patch.object(
                config.dbmod, "get_settings_data", return_value=forged,
            ):
            cleaned = config.load_settings(object())
        self.assertEqual(
            set(config._MANAGED_VISION_SETTING_KEYS),
            {key for key in cleaned if key.startswith("vision")},
        )
        self.assertEqual("preserved", cleaned["unrelatedSetting"])
        self.assertTrue(cleaned["unrelatedDefault"])


class IntakeOrderingTests(unittest.TestCase):
    def test_attacker_receipt_text_and_problem_rows_are_normalized_pre_publish(self):
        raw = process._bounded_receipt_text(
            "00\t0001\nA\x00B\x01C\x7fD\ud800" + ("9" * 10_000)
            + ("\U0001f9e2" * 10), 512,
        )
        self.assertIsNotNone(raw)
        self.assertFalse(any(ord(char) < 32 or ord(char) == 127 for char in raw))
        self.assertNotIn("\ud800", raw)
        self.assertLessEqual(process._utf16_units(raw), 512)

        normalized = process._normalized_problem_receipts([{
            "type": "OCR\nSKU\tOUTLIER",
            "sku": "000001",
            "message": ("bad\nraw\tvalue " * 2_000),
        }])
        self.assertEqual("OCR SKU OUTLIER", normalized[0]["type"])
        self.assertFalse(any(
            ord(char) < 32 or ord(char) == 127
            for char in normalized[0]["message"]
        ))
        self.assertLessEqual(process._utf16_units(normalized[0]["message"]), 4_096)

        item = GroupedItem(
            sku="000001", original_qr_value=raw, members=[], marker=None,
            log=[{
                "file": "safe.jpg", "role": "photo", "time": "x\ny",
                "gapBeforeSec": 9e20, "decode": "ocr\ttext", "raw": raw,
            }],
        )
        receipt = process._grouping_info(item, "exif")
        self.assertEqual(1_000_000_000.0, receipt["log"][0]["gapBeforeSec"])
        self.assertEqual("x y", receipt["log"][0]["time"])
        self.assertEqual("ocr text", receipt["log"][0]["decode"])

    def test_intake_workset_and_dimensions_are_bounded_before_work(self):
        checks = []
        with tempfile.TemporaryDirectory() as tmp:
            first = pathlib.Path(tmp, "one.jpg")
            second = pathlib.Path(tmp, "two.jpg")
            first.write_bytes(b"one")
            second.write_bytes(b"two")
            process._validate_incoming_workset(
                [str(first), str(second)], lambda: checks.append("check"),
            )
            self.assertGreaterEqual(len(checks), 4)
            with mock.patch.object(process, "MAX_INTAKE_FILES", 1):
                with self.assertRaisesRegex(RuntimeError, "file safety limit"):
                    process._validate_incoming_workset(
                        [str(first), str(second)], lambda: None,
                    )
            with mock.patch.object(process, "MAX_INTAKE_TOTAL_BYTES", 5):
                with self.assertRaisesRegex(RuntimeError, "aggregate byte"):
                    process._validate_incoming_workset(
                        [str(first), str(second)], lambda: None,
                    )

        process._assert_bounded_image_dimensions(10_000, 10_000)
        with self.assertRaisesRegex(RuntimeError, "pixel count"):
            process._assert_bounded_image_dimensions(10_001, 10_000)
        with self.assertRaisesRegex(RuntimeError, "could not be verified"):
            process._assert_bounded_image_dimensions(None, 10)

        long_root = "C:\\" + ("r" * 4_000)
        with self.assertRaisesRegex(RuntimeError, "bounded worker IPC receipt"):
            process._assert_projected_result_budget(
                ["C:\\incoming\\" + ("p" * 4_000) + f"-{index}.jpg"
                 for index in range(1_000)],
                [], {}, [],
                {
                    "processingPath": long_root,
                    "needsReviewPath": long_root,
                    "archivePath": long_root,
                },
            )

        crowded = GroupedItem(
            sku="000001", original_qr_value="000001",
            members=[
                DecodedPhoto(path=f"incoming/{index}.jpg", filename=f"{index}.jpg")
                for index in range(process.MAX_GROUP_PHOTOS + 1)
            ],
            marker=None,
        )
        with self.assertRaisesRegex(RuntimeError, "photo safety limit"):
            process._assert_bounded_grouping([crowded])

    def test_direct_worker_validates_missing_roots_without_creating_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = pathlib.Path(tmp, "fresh")
            roots = {
                "incomingPath": str(data / "incoming"),
                "processingPath": str(data / "processing"),
                "needsReviewPath": str(data / "needs-review"),
                "archivePath": str(data / "archive"),
            }
            process._validate_managed_work_roots(roots)
            self.assertTrue(all(not pathlib.Path(value).exists() for value in roots.values()))
            with self.assertRaisesRegex(RuntimeError, "separate non-nested"):
                process._validate_managed_work_roots({
                    **roots,
                    "processingPath": str(data / "incoming" / "nested"),
                })

    def test_file_hash_keeps_cancellation_observable_per_chunk(self):
        checks = []
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp, "large.jpg")
            source.write_bytes(b"abcdefghij")
            digest = process.dedup.sha256_of_file(
                str(source), chunk_size=3,
                cancel_check=lambda: checks.append("check"),
            )
        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertGreaterEqual(len(checks), 8)

    def test_repeated_skus_get_distinct_collision_folders(self):
        existing = set()
        emitted = set()
        ordinals = {}
        root = str(pathlib.Path("processing").resolve())

        first = process._processing_target(
            "000123", "20260810-200100", root, existing, emitted, ordinals, create=False,
        )
        second = process._processing_target(
            "000123", "20260810-200100", root, existing, emitted, ordinals, create=False,
        )
        third = process._processing_target(
            "000123", "20260810-200100", root, existing, emitted, ordinals, create=False,
        )

        self.assertEqual(first, (False, str(pathlib.Path(root, "000123"))))
        self.assertEqual(
            second,
            (True, str(pathlib.Path(root, "000123__incoming-20260810-200100"))),
        )
        self.assertEqual(
            third,
            (True, str(pathlib.Path(root, "000123__incoming-20260810-200100__2"))),
        )

    def test_existing_sku_starts_collision_ordinals_at_one(self):
        existing = {"000123"}
        emitted = set()
        ordinals = {}
        root = str(pathlib.Path("processing").resolve())

        first = process._processing_target(
            "000123", "20260810-200100", root, existing, emitted, ordinals, create=False,
        )
        second = process._processing_target(
            "000123", "20260810-200100", root, existing, emitted, ordinals, create=False,
        )

        self.assertEqual(
            first,
            (True, str(pathlib.Path(root, "000123__incoming-20260810-200100"))),
        )
        self.assertEqual(
            second,
            (True, str(pathlib.Path(root, "000123__incoming-20260810-200100__2"))),
        )

    def _fixture(self):
        member = DecodedPhoto(path="incoming/item.jpg", filename="item.jpg")
        item = GroupedItem(
            sku="000001", original_qr_value="000001", members=[member], marker=None,
        )
        grouping = types.SimpleNamespace(items=[item], needs_review=[], problems=[])
        test_root = pathlib.Path.cwd()
        settings = {
            "incomingPath": str(test_root / "incoming"),
            "processingPath": str(test_root / "processing"),
            "needsReviewPath": str(test_root / "needs-review"),
            "archivePath": str(test_root / "archive"),
            "logsPath": "", "fileStabilitySeconds": 0,
            "visionEnabled": True, "visionFields": ["itemType"],
        }
        return item, grouping, settings

    def test_managed_session_and_final_cancel_precede_every_mutation(self):
        item, grouping, settings = self._fixture()
        events = []

        @contextlib.contextmanager
        def session(_label):
            events.append("session-enter")
            try:
                yield object()
            finally:
                events.append("session-exit")

        class Enricher:
            def __init__(self, _settings, _client, cancel_check=None):
                self.cancel = cancel_check

            def enrich(self, _sku, metas, tag_reading=None):
                self.cancel()
                events.append(("ask", metas))
                self.cancel()
                return {"fields": {"itemType": "Hat"}, "aiFields": ["itemType"]}

        def mutation(name):
            self.assertIn("session-exit", events)
            events.append("mutation:" + name)

        decoder = types.SimpleNamespace(
            decode=lambda _path: types.SimpleNamespace(
                sku=None, raw=None, method=None, qr_pattern_detected=False,
            ),
            # Intake reports engine availability before decoding so a broken
            # install can't masquerade as a batch with no stickers in it. The
            # double reports a healthy cascade so this ordering test stays
            # about the mutation fence and not about the dependency alarm.
            engine_status=lambda: {"qr_opencv": True, "qr_pyzbar": True, "ocr_paddle": True},
        )
        args = types.SimpleNamespace(incoming=None, dry_run=False)
        emitted = []
        with mock.patch.object(process.dbmod, "connect", return_value=object()), \
                mock.patch.object(process.config, "load_settings", return_value=settings), \
                mock.patch.object(process.config, "ensure_dirs", side_effect=lambda _s: mutation("dirs")), \
                mock.patch.object(process, "_reserve_processing_folder", side_effect=lambda root, prefix: mutation("reserve") or str(pathlib.Path(root, prefix + "0" * 32))), \
                mock.patch.object(process, "_list_incoming", return_value=(["incoming/item.jpg"], ["incoming/bad.txt"])), \
                mock.patch.object(process, "_validate_incoming_workset"), \
                mock.patch.object(process.fileops, "is_stable", return_value=True), \
                mock.patch.object(process, "get_exif", return_value=(None, None, 10, 10)), \
                mock.patch.object(process, "order_photos", return_value="exif"), \
                mock.patch.object(process, "Decoder", return_value=decoder), \
                mock.patch.object(process, "group_photos", return_value=grouping), \
                mock.patch.object(process.dbmod, "existing_hashes", return_value=set()), \
                mock.patch.object(process.dbmod, "existing_skus", return_value=set()), \
                mock.patch.object(process.dedup, "sha256_of_file", return_value="hash"), \
                mock.patch.object(process.fileops, "copy_into", side_effect=lambda _s, d: mutation("copy") or d), \
                mock.patch.object(process.fileops, "move_into", side_effect=lambda _s, d: mutation("move") or d), \
                mock.patch.object(process, "_thumb", return_value=None), \
                mock.patch.object(process, "managed_vision_session", session), \
                mock.patch.object(process, "ManagedVisionEnricher", Enricher), \
                mock.patch.object(process, "emit", side_effect=emitted.append):
            result = process.run(args, cancel_check=lambda: events.append("cancel-check"))

        first_mutation = next(i for i, event in enumerate(events)
                              if isinstance(event, str) and event.startswith("mutation:"))
        self.assertLess(events.index("session-exit"), first_mutation)
        admissions = [event for event in emitted if event.get("event") == "admitted"]
        self.assertEqual([{"event": "admitted", "mode": "managed"}], admissions)
        self.assertEqual("Hat", result["items"][0]["enrichment"]["fields"]["itemType"])

    def test_force_no_ai_has_one_admission_no_session_and_explicit_item_error(self):
        item, _grouping, settings = self._fixture()
        emitted = []
        with mock.patch.object(process, "emit", side_effect=emitted.append), \
                mock.patch.object(process, "managed_vision_session",
                                  side_effect=AssertionError("must not admit")):
            results = process._precompute_enrichments(
                [item], settings, "batch", dry=False, force_no_ai=True,
                cancel_check=lambda: None, source_hashes={},
            )
        self.assertEqual({"error": process.FORCE_SKIP_ERROR, "skipped": True},
                         results[id(item)])
        self.assertEqual([{"event": "admitted", "mode": "no-ai"}], emitted)

    def test_changed_incoming_bytes_unwind_session_before_mutation(self):
        item, _grouping, settings = self._fixture()
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

            def enrich(self, *_args, **_kwargs):
                events.append("ask")
                return {"fields": {"itemType": "Hat"}}

        expected = {str(pathlib.Path("incoming/item.jpg").absolute()): "same"}
        with mock.patch.object(process, "managed_vision_session", session), \
                mock.patch.object(process, "ManagedVisionEnricher", Enricher), \
                mock.patch.object(process.dedup, "sha256_of_file",
                                  side_effect=["same", "changed"]), \
                mock.patch.object(process, "emit"):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                process._precompute_enrichments(
                    [item], settings, "batch", dry=False, force_no_ai=False,
                    cancel_check=lambda: None, source_hashes=expected,
                )
        self.assertEqual(["enter", "ask", "exit"], events)

    def test_deferral_emits_no_admission_and_restore_failure_unwinds(self):
        item, _grouping, settings = self._fixture()
        emitted = []

        @contextlib.contextmanager
        def deferred_session(_label):
            raise managed.ManagedVisionDeferred(
                "busy", verdict={"status": "busy"},
            )
            yield  # pragma: no cover

        with mock.patch.object(process, "managed_vision_session", deferred_session), \
                mock.patch.object(process, "emit", side_effect=emitted.append):
            with self.assertRaises(managed.ManagedVisionDeferred):
                process._precompute_enrichments(
                    [item], settings, "batch", dry=False, force_no_ai=False,
                    cancel_check=lambda: None, source_hashes={},
                )
        self.assertEqual([], emitted)

        @contextlib.contextmanager
        def restore_failing_session(_label):
            yield object()
            raise RuntimeError("restore failed")

        class Enricher:
            def __init__(self, _settings, _client, cancel_check=None):
                self.cancel = cancel_check

            def enrich(self, _sku, _metas, tag_reading=None):
                self.cancel()
                return {"fields": {"itemType": "Hat"}}

        emitted = []
        with mock.patch.object(
                process, "managed_vision_session", restore_failing_session,
            ), mock.patch.object(process, "ManagedVisionEnricher", Enricher), \
                mock.patch.object(process, "_verify_source_identities"), \
                mock.patch.object(process, "emit", side_effect=emitted.append):
            with self.assertRaisesRegex(RuntimeError, "restore failed"):
                process._precompute_enrichments(
                    [item], settings, "batch", dry=False, force_no_ai=False,
                    cancel_check=lambda: None, source_hashes={},
                )
        self.assertEqual(
            [{"event": "admitted", "mode": "managed"}],
            [event for event in emitted if event.get("event") == "admitted"],
        )


class TerminalEventTests(unittest.TestCase):
    def test_main_emits_unicode_json_through_legacy_windows_stdout(self):
        raw = io.BytesIO()
        stdout = io.TextIOWrapper(raw, encoding="cp1252", newline="\n")
        try:
            with mock.patch.object(sys, "stdout", stdout), \
                    mock.patch.object(process, "CancellationGuard",
                                      return_value=lambda: None), \
                    mock.patch.object(process, "run",
                                      return_value={"title": "福"}):
                code = process.main([])
                stdout.flush()
            encoded = raw.getvalue()
        finally:
            stdout.detach()

        self.assertEqual(0, code)
        self.assertIn("福".encode("utf-8"), encoded)
        event = json.loads(encoded.decode("utf-8"))
        self.assertEqual("福", event["payload"]["title"])

    def _run_main(self, error):
        emitted = []
        with mock.patch.object(process, "CancellationGuard", return_value=lambda: None), \
                mock.patch.object(process, "run", side_effect=error), \
                mock.patch.object(process, "emit", side_effect=emitted.append):
            code = process.main([])
        return code, emitted

    def test_deferred_is_rc75_bounded_and_drops_peer_urls(self):
        error = managed.ManagedVisionDeferred(
            "http://secret:8188/" + ("x" * 500),
            verdict={"status": "not-a-public-status", "detail": "wait " + ("y" * 500),
                     "attempts": 4, "elapsed_s": 1.23456,
                     "peers": [{"endpoint": "http://private:8188"}]},
        )
        code, emitted = self._run_main(error)
        self.assertEqual(75, code)
        self.assertEqual("deferred", emitted[0]["event"])
        self.assertEqual("managed vision queue ambiguous", emitted[0]["message"])
        self.assertEqual("ambiguous", emitted[0]["status"])
        self.assertEqual(4, emitted[0]["attempts"])
        self.assertEqual(1.235, emitted[0]["elapsedSeconds"])
        self.assertNotIn("verdict", emitted[0])
        self.assertNotIn("private", json.dumps(emitted[0]))
        self.assertFalse(any(event.get("event") == "result" for event in emitted))

    def test_cancel_is_rc130_and_generic_is_rc1_with_no_result(self):
        code, emitted = self._run_main(managed.ManagedVisionCancelled("cancel"))
        self.assertEqual(130, code)
        self.assertEqual("cancelled", emitted[0]["event"])
        code, emitted = self._run_main(RuntimeError("restore failed"))
        self.assertEqual(1, code)
        self.assertEqual("error", emitted[0]["event"])
        self.assertFalse(any(event.get("event") == "result" for event in emitted))


if __name__ == "__main__":
    unittest.main()
