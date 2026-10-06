import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "benchmark_vision.py"
SPEC = importlib.util.spec_from_file_location("blackcat_benchmark_vision", SCRIPT)
assert SPEC and SPEC.loader
benchmark = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = benchmark
SPEC.loader.exec_module(benchmark)


class BenchmarkVisionTests(unittest.TestCase):
    @staticmethod
    def startup_text(done=33, tag="abc", backend="CUDA0"):
        return (
            f"common_param: common_params_print_info: build 10218 ({tag})\n"
            f"load_tensors: offloaded {done}/33 layers to GPU\n"
            f"llama_kv_cache:      {backend} KV buffer size =   136.00 MiB\n"
            f"sched_reserve:      {backend} compute buffer size =   148.30 MiB\n"
            f"clip_ctx: CLIP using {backend} backend\n"
            f"reserve_compute_meta:      {backend} compute buffer size =   223.30 MiB"
        )

    @classmethod
    def verified_provenance(cls, all_layers=True):
        done = 33 if all_layers else 12
        text = cls.startup_text(done=done)
        return {
            "schemaVersion": benchmark.PROVENANCE_SCHEMA_VERSION,
            "verified": True,
            "verifiedAt": "2026-08-17T00:00:00+00:00",
            "revalidatedAt": "2026-08-17T00:01:00+00:00",
            "pid": 123,
            "creationTime": "2026-08-17T00:00:00.0000000Z",
            "executable": "C:\\repo\\llama-server.exe",
            "executableSha256": "1" * 64,
            "commandFingerprint": "2" * 64,
            "manifestConfigSha256": "3" * 64,
            "modelProfileConfigSha256": "4" * 64,
            "listener": "127.0.0.1:1235",
            "modelAlias": "blackcat-vision",
            "modelProfile": "q4",
            "modelRevision": "5" * 40,
            "weightsSha256": "6" * 64,
            "projectorSha256": "7" * 64,
            "profile": {"batch": 512, "microBatch": 256, "threads": 12},
            "startupLogEvidence": benchmark._startup_log_evidence(text, 0),
        }

    def test_normalization_is_stable_and_bounded(self):
        self.assertEqual(benchmark.normalized("  T-Shirt  "), "t shirt")
        self.assertEqual(benchmark.normalized("GREY"), "gray")
        self.assertFalse(benchmark.known("Unknown"))
        self.assertTrue(benchmark.known("Levi's"))

    def test_stratified_selection_round_robins_categories(self):
        candidates = [
            {"id": 1, "category": "Clothing", "status": "Ready"},
            {"id": 2, "category": "Clothing", "status": "Ready"},
            {"id": 3, "category": "Bag", "status": "Ready"},
            {"id": 4, "category": "Hat", "status": "Ready"},
        ]
        selected = benchmark.select_stratified(candidates, 3)
        self.assertEqual({item["category"] for item in selected}, {"Bag", "Clothing", "Hat"})

    def test_summary_applies_every_acceptance_gate(self):
        comparisons = [
            {
                "field": field,
                "expected": "same",
                "predicted": "same",
                "predicted_known": True,
                "match": True,
            }
            for field in benchmark.CORE_FIELDS
        ]
        rows = [{
            "success": True,
            "json_valid": True,
            "comparisons": comparisons,
            "expected": {"brand": "same", "size": "same"},
            "predicted": {"brand": "same", "size": "same"},
            "latency_s": 10.0,
            "ttft_estimate_s": 2.0,
            "timings": {"prompt_per_second": 80.0, "predicted_per_second": 40.0},
            "finish_reason": "stop",
        }]
        summary = benchmark.summarize(
            rows,
            [{
                "gpu_used_mib": 5000.0, "dedicated_mib": 3900.0,
                "shared_mib": 0.0,
            }],
            self.verified_provenance(),
        )
        self.assertTrue(summary["qualified"])
        self.assertEqual(summary["performance"]["ttft_estimate_s"]["median"], 2.0)
        self.assertEqual(summary["performance"]["prompt_tokens_per_s"]["median"], 80.0)
        self.assertEqual(summary["performance"]["output_tokens_per_s"]["median"], 40.0)
        self.assertEqual(5000.0, summary["peak_whole_gpu_used_mib"])
        self.assertEqual(3900.0, summary["peak_server_dedicated_mib"])
        self.assertTrue(summary["acceptance"]["cuda_vision_kv_compute"])

    def test_unknown_ground_truth_brand_claim_counts_as_false(self):
        rows = [{
            "success": True,
            "json_valid": True,
            "comparisons": [],
            "expected": {"brand": None, "size": "Unknown"},
            "predicted": {"brand": "Nike", "size": "L"},
            "latency_s": 1.0,
            "finish_reason": "stop",
        }]
        summary = benchmark.summarize(
            rows,
            [{"gpu_used_mib": 4000.0, "dedicated_mib": 3900.0, "shared_mib": 0.0}],
            self.verified_provenance(),
        )
        self.assertEqual(1.0, summary["brand_size_false_claim_rate"])
        self.assertFalse(
            summary["acceptance"]["brand_size_false_claims_at_most_5_percent"]
        )

    def test_only_latest_startup_segment_can_prove_full_offload(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "server.log"
            log.write_text(
                self.startup_text(done=33, tag="old") + "\n" +
                self.startup_text(done=12, tag="current") + "\n",
                encoding="utf-8",
            )
            self.assertFalse(benchmark.all_layers_gpu(log))

    def test_failed_request_without_finish_receipt_is_not_clean(self):
        row = {
            "success": False,
            "json_valid": False,
            "comparisons": [],
            "expected": {},
            "predicted": {},
            "latency_s": 1.0,
            "finish_reason": None,
        }
        summary = benchmark.summarize(
            [row],
            [{"gpu_used_mib": 1.0, "dedicated_mib": 1.0, "shared_mib": 0.0}],
            self.verified_provenance(),
        )
        self.assertEqual(1, summary["truncated_requests"])
        self.assertFalse(summary["acceptance"]["no_truncation"])

    def test_rescore_marks_legacy_process_provenance_unverified(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "server.log"
            log.write_text(
                "common_param: common_params_print_info: build 10218 (abc)\n"
                "load_tensors: offloaded 33/33 layers to GPU\n",
                encoding="utf-8",
            )
            source = root / "legacy.json"
            source.write_text(json.dumps({
                "label": "legacy", "serverLog": str(log),
                "rows": [{
                    "success": True, "json_valid": True, "comparisons": [],
                    "expected": {"brand": None}, "predicted": {"brand": "Nike"},
                    "latency_s": 1.0, "finish_reason": "stop",
                }],
                "gpuSamples": [{
                    "gpu_used_mib": 5000.0, "dedicated_mib": 3900.0,
                    "shared_mib": 0.0,
                }],
            }), encoding="utf-8")
            rescored = benchmark.rescore_results(source, root / "output")
            payload = json.loads(rescored.read_text(encoding="utf-8"))
        self.assertEqual(benchmark.RESULT_SCHEMA_VERSION, payload["schemaVersion"])
        self.assertFalse(payload["serverProvenance"]["verified"])
        self.assertEqual(1.0, payload["summary"]["brand_size_false_claim_rate"])
        self.assertFalse(payload["summary"]["qualified"])
        self.assertFalse(benchmark.payload_is_qualified(payload))

    def test_rescore_rebuilds_all_current_comparisons_including_category(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fields = {field: "same" for field in benchmark.CORE_FIELDS}
            predicted = dict(fields)
            predicted["category"] = "different"
            source = root / "old-score.json"
            source.write_text(json.dumps({
                "label": "old-score",
                "serverProvenance": self.verified_provenance(),
                "rows": [{
                    "success": True,
                    "json_valid": True,
                    "comparisons": [],
                    "expected": fields,
                    "predicted": predicted,
                    "latency_s": 1.0,
                    "finish_reason": "stop",
                }],
                "gpuSamples": [{
                    "gpu_used_mib": 5000.0,
                    "dedicated_mib": 3900.0,
                    "shared_mib": 0.0,
                }],
            }), encoding="utf-8")
            rescored = benchmark.rescore_results(source, root / "output")
            payload = json.loads(rescored.read_text(encoding="utf-8"))
        comparisons = payload["rows"][0]["comparisons"]
        self.assertEqual(list(benchmark.CORE_FIELDS), [value["field"] for value in comparisons])
        self.assertAlmostEqual(5 / 6, payload["summary"]["core_field_accuracy"])
        self.assertEqual(benchmark.SCORING_VERSION, payload["scoringVersion"])

    def test_payload_qualification_requires_untampered_verified_provenance(self):
        payload = {"summary": {"qualified": True}, "serverProvenance": self.verified_provenance()}
        self.assertTrue(benchmark.payload_is_qualified(payload))
        payload["serverProvenance"]["verified"] = False
        self.assertFalse(benchmark.payload_is_qualified(payload))
        payload["serverProvenance"] = self.verified_provenance()
        payload["serverProvenance"]["startupLogEvidence"]["text"] += "tampered"
        self.assertFalse(benchmark.payload_is_qualified(payload))
        payload["serverProvenance"] = self.verified_provenance()
        payload["serverProvenance"].pop("revalidatedAt")
        self.assertFalse(benchmark.payload_is_qualified(payload))

    def approved_command(self, root: Path):
        executable = root / "runtime" / "llama-server.exe"
        weights = root / "models" / "weights.gguf"
        projector = root / "models" / "projector.gguf"
        api_key = root / "api-key.txt"
        log = root / "logs" / "server.log"
        argv = [
            str(executable), "-m", str(weights), "--mmproj", str(projector),
            "--alias", "blackcat-vision", "--host", "127.0.0.1", "--port", "1235",
            "--api-key-file", str(api_key), "-ngl", "all", "-c", "8192",
            "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--parallel", "1",
            "-b", "512", "-ub", "256", "-t", "12", "--reasoning", "off",
            "--image-min-tokens", "1024", "--image-max-tokens", "1024",
            "--cache-ram", "0", "--cors-origins", "http://127.0.0.1",
            "--no-cors-credentials", "--offline", "--no-webui", "-lv", "4",
            "--log-file", str(log),
        ]
        return argv, (executable, weights, projector, api_key, log)

    def test_exact_command_parser_accepts_only_one_complete_approved_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            argv, paths = self.approved_command(Path(temporary).resolve())
            parsed = benchmark.parse_approved_server_command(
                subprocess.list2cmdline(argv), *paths,
            )
        self.assertEqual(512, parsed["tuned"]["-b"])
        self.assertRegex(parsed["fingerprint"], r"^[0-9a-f]{64}$")

    def test_exact_command_parser_rejects_duplicate_or_conflicting_flags(self):
        with tempfile.TemporaryDirectory() as temporary:
            argv, paths = self.approved_command(Path(temporary).resolve())
            for addition in (("-b", "2048"), ("--host", "0.0.0.0")):
                with self.subTest(addition=addition), self.assertRaisesRegex(RuntimeError, "repeats"):
                    benchmark.parse_approved_server_command(
                        subprocess.list2cmdline([*argv, *addition]), *paths,
                    )

    def test_exact_command_parser_rejects_unknown_argument_even_if_it_contains_model_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            argv, paths = self.approved_command(Path(temporary).resolve())
            with self.assertRaisesRegex(RuntimeError, "unapproved argument"):
                benchmark.parse_approved_server_command(
                    subprocess.list2cmdline([*argv, "--model-note", str(paths[1])]), *paths,
                )

    def test_exact_command_parser_rejects_q6_verbosity_three(self):
        with tempfile.TemporaryDirectory() as temporary:
            argv, paths = self.approved_command(Path(temporary).resolve())
            argv[argv.index("-lv") + 1] = "3"
            with self.assertRaisesRegex(RuntimeError, r"unapproved -lv value"):
                benchmark.parse_approved_server_command(
                    subprocess.list2cmdline(argv), *paths,
                )

    def test_real_q6_verbosity_three_log_shape_remains_unqualifiable(self):
        q6_log = (
            "0.03.278.172 I cmn  common_param: common_params_print_info: verbosity = 3 "
            "(adjust with the `-lv N` CLI arg)\r\n"
            "0.03.365.662 I srv    load_model: loading model "
            "'Qwen_Qwen3.5-4B-Q6_K_L.gguf'\r\n"
            "0.07.359.587 I srv    load_model: loaded multimodal model, "
            "'mmproj-Qwen_Qwen3.5-4B-bf16.gguf'\r\n"
            "0.07.415.951 I srv  llama_server: model loaded\r\n"
            "0.07.415.959 I srv  llama_server: listening on http://127.0.0.1:1235\r\n"
        )
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "q6-verbosity-three.log"
            log.write_text(q6_log, encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "complete current startup"):
                benchmark.current_start_log_evidence(log)

    def test_startup_evidence_is_immutable_across_inference_log_appends(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "server.log"
            startup = self.startup_text() + "\n"
            log.write_text(startup, encoding="utf-8")
            before = benchmark.current_start_log_evidence(log)
            log.write_text(startup + "request: completed\n", encoding="utf-8")
            after_request = benchmark.current_start_log_evidence(log)
            self.assertEqual(before, after_request)
            log.write_text(
                startup + "request: completed\n"
                + self.startup_text(done=12, tag="def") + "\n",
                encoding="utf-8",
            )
            after_restart = benchmark.current_start_log_evidence(log)
        self.assertNotEqual(before["sha256"], after_restart["sha256"])
        self.assertFalse(after_restart["allLayersGpu"])

    def test_saved_startup_evidence_survives_large_logs_but_rejects_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "server.log"
            startup = self.startup_text()
            log.write_text(startup, encoding="utf-8")
            evidence = benchmark.current_start_log_evidence(log)
            with log.open("a", encoding="utf-8") as handle:
                handle.write("\nrequest completed" * 150_000)
            self.assertEqual(
                evidence,
                benchmark.validate_saved_startup_log_evidence(log, evidence),
            )
            with log.open("a", encoding="utf-8") as handle:
                handle.write(
                    "\n" + self.startup_text(tag="new") + "\n"
                )
            with self.assertRaisesRegex(RuntimeError, "newer llama.cpp startup"):
                benchmark.validate_saved_startup_log_evidence(log, evidence)

    def test_startup_evidence_fails_closed_without_each_cuda0_receipt(self):
        required_lines = (
            "llama_kv_cache:",
            "sched_reserve:",
            "clip_ctx:",
            "reserve_compute_meta:",
        )
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "server.log"
            lines = self.startup_text().splitlines()
            for prefix in required_lines:
                with self.subTest(prefix=prefix):
                    log.write_text(
                        "\n".join(line for line in lines if not line.startswith(prefix)),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(RuntimeError, "complete current startup"):
                        benchmark.current_start_log_evidence(log)
                    log.write_text(
                        "\n".join(
                            line.replace("CUDA0", "CPU") if line.startswith(prefix) else line
                            for line in lines
                        ),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(RuntimeError, "complete current startup"):
                        benchmark.current_start_log_evidence(log)

    def test_post_run_provenance_comparison_detects_process_drift(self):
        before = {
            field: "same" for field in benchmark._STABLE_PROVENANCE_FIELDS
        }
        after = dict(before)
        after["creationTime"] = "reused-pid"
        with self.assertRaisesRegex(RuntimeError, "creationTime"):
            benchmark._assert_same_server_provenance(before, after)

    def test_tracked_q6_profile_contains_exact_revision_urls_sizes_and_hashes(self):
        profile = benchmark.load_q6_profile()
        self.assertEqual("4168f45a16a1290d65a4ec0fa312ae917a4c15d6", profile["revision"])
        self.assertIn(profile["revision"], profile["weights"]["url"])
        self.assertIn(profile["revision"], profile["projector"]["url"])
        self.assertEqual(3_959_316_448, profile["weights"]["size"])
        self.assertEqual(675_569_216, profile["projector"]["size"])


if __name__ == "__main__":
    unittest.main()
