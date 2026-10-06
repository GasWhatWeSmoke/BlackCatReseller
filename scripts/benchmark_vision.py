"""Read-only accuracy/performance benchmark for the fixed local vision model."""
from __future__ import annotations

import argparse
import ctypes
import csv
import hashlib
import json
import math
import os
import re
import shlex
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from black_cat_worker.managed_vision import (  # noqa: E402
    ManagedVisionEnricher,
    managed_vision_session,
)
from black_cat_worker import vision as vision_helpers  # noqa: E402


CORE_FIELDS = ("brand", "size", "category", "itemType", "color", "pattern")
UNKNOWN = {"", "unknown", "unbranded", "n/a", "na", "none", "null"}
RESULT_SCHEMA_VERSION = 3
SCORING_VERSION = 2
PROVENANCE_SCHEMA_VERSION = 1
STARTUP_EVIDENCE_MAX_BYTES = 256 * 1024
START_MARKER_BYTES = re.compile(
    rb"common_param:[^\r\n]*?build\s+\d+\s+\(", re.IGNORECASE,
)
OFFLOAD_BYTES = re.compile(
    rb"offloaded\s+\d+\s*/\s*\d+\s+layers\s+to\s+GPU", re.IGNORECASE,
)
CUDA_RECEIPT_BYTES = {
    "visionBackend": re.compile(rb"clip_ctx:\s*CLIP using CUDA0 backend", re.IGNORECASE),
    "projectorComputeBuffer": re.compile(
        rb"reserve_compute_meta:\s*CUDA0 compute buffer size\s*=\s*"
        rb"[0-9]+(?:\.[0-9]+)?\s+MiB", re.IGNORECASE,
    ),
    "kvBuffer": re.compile(
        rb"llama_kv_cache:\s*CUDA0 KV buffer size\s*=\s*"
        rb"[0-9]+(?:\.[0-9]+)?\s+MiB", re.IGNORECASE,
    ),
    "computeBuffer": re.compile(
        rb"sched_reserve:\s*CUDA0 compute buffer size\s*=\s*"
        rb"[0-9]+(?:\.[0-9]+)?\s+MiB", re.IGNORECASE,
    ),
}
Q6_PROFILE_PATH = ROOT / "config" / "local-vision-q6-benchmark.json"


def load_q6_profile(path: Path = Q6_PROFILE_PATH) -> Dict:
    profile = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schemaVersion": 1,
        "kind": "blackcat-local-vision-benchmark-profile",
        "id": "qwen3.5-4b-q6-k-l",
        "sourceRepository": "bartowski/Qwen_Qwen3.5-4B-GGUF",
        "revision": "4168f45a16a1290d65a4ec0fa312ae917a4c15d6",
        "directory": "models/qwen3.5-4b-q6-k-l",
    }
    if not isinstance(profile, dict) or any(profile.get(key) != value for key, value in expected.items()):
        raise RuntimeError("tracked Q6 benchmark profile identity has drifted")
    pins = {
        "weights": {
            "name": "Qwen_Qwen3.5-4B-Q6_K_L.gguf",
            "url": (
                "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/"
                "4168f45a16a1290d65a4ec0fa312ae917a4c15d6/"
                "Qwen_Qwen3.5-4B-Q6_K_L.gguf?download=true"
            ),
            "size": 3_959_316_448,
            "sha256": "0d7931a7f143ccfdf675c0d84d542c387cd9255af94ee9c8fb5fa6f6df7c08a0",
        },
        "projector": {
            "name": "mmproj-Qwen_Qwen3.5-4B-bf16.gguf",
            "url": (
                "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/"
                "4168f45a16a1290d65a4ec0fa312ae917a4c15d6/"
                "mmproj-Qwen_Qwen3.5-4B-bf16.gguf?download=true"
            ),
            "size": 675_569_216,
            "sha256": "463f39bd1c291c1186c319a8c90ff8640aafa678b14cbee2232d695113dfbb66",
        },
    }
    if any(profile.get(role) != pin for role, pin in pins.items()):
        raise RuntimeError("tracked Q6 benchmark artifact pins have drifted")
    return profile


# Kept as a public module constant for result tooling, but sourced from the
# tracked acquisition profile rather than an untracked local download.
Q6_FALLBACK = load_q6_profile()


def normalized(value: object) -> str:
    text = re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()
    aliases = {
        "grey": "gray",
        "multi color": "multicolor",
        "tee": "t shirt",
        "tshirt": "t shirt",
    }
    return aliases.get(text, text)


def known(value: object) -> bool:
    return normalized(value) not in UNKNOWN


def build_comparisons(expected: object, predicted: object) -> List[Dict]:
    expected_fields = expected if isinstance(expected, dict) else {}
    predicted_fields = predicted if isinstance(predicted, dict) else {}
    comparisons: List[Dict] = []
    for field in CORE_FIELDS:
        expected_value = expected_fields.get(field)
        if not known(expected_value):
            continue
        predicted_value = predicted_fields.get(field)
        comparisons.append({
            "field": field,
            "expected": expected_value,
            "predicted": predicted_value,
            "predicted_known": known(predicted_value),
            "match": normalized(expected_value) == normalized(predicted_value),
        })
    return comparisons


def percentile(values: Iterable[float], quantile: float) -> float:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def open_read_only(database: Path) -> sqlite3.Connection:
    absolute = database.resolve()
    uri = absolute.as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def load_candidates(connection: sqlite3.Connection) -> List[Dict]:
    rows = connection.execute(
        """
        SELECT id, sku, brand, size, itemType, category, color, pattern, status, aiFields
        FROM Item
        WHERE itemType IS NOT NULL AND trim(itemType) <> ''
          AND color IS NOT NULL AND trim(color) <> ''
          AND (aiFields IS NULL OR trim(aiFields) IN ('', '[]'))
        ORDER BY id
        """
    ).fetchall()
    result: List[Dict] = []
    for row in rows:
        photos = connection.execute(
            """
            SELECT id, storedPath, isMarker, sortOrder
            FROM Photo
            WHERE itemId = ? AND isMarker = 0 AND includeInListing = 1
            ORDER BY sortOrder, id
            """,
            (row["id"],),
        ).fetchall()
        existing = [
            {"photoId": photo["id"], "storedPath": photo["storedPath"], "isMarker": False}
            for photo in photos
            if photo["storedPath"] and Path(photo["storedPath"]).is_file()
        ]
        if not existing:
            continue
        result.append({
            "id": row["id"],
            "sku": row["sku"],
            "category": row["category"] or "Clothing",
            "status": row["status"],
            "expected": {field: row[field] for field in CORE_FIELDS},
            "photos": existing,
        })
    return result


def select_stratified(candidates: List[Dict], count: int) -> List[Dict]:
    groups: Dict[str, List[Dict]] = defaultdict(list)
    for item in candidates:
        groups[str(item.get("category") or "Clothing")].append(item)
    for values in groups.values():
        values.sort(key=lambda item: (str(item.get("status")), int(item["id"])))
    selected: List[Dict] = []
    names = sorted(groups)
    while len(selected) < min(count, len(candidates)):
        advanced = False
        for name in names:
            if groups[name] and len(selected) < count:
                selected.append(groups[name].pop(0))
                advanced = True
        if not advanced:
            break
    return selected


def query_gpu_process_memory(pid: Optional[int]) -> Dict[str, Optional[float]]:
    if not pid or os.name != "nt":
        return {"dedicated_mib": None, "shared_mib": None}
    command = (
        "$rows=Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUPROCESSMEMORY "
        "-ErrorAction Stop | Where-Object { $_.Name -match 'pid_" + str(pid) + "_' };"
        "$d=($rows | Measure-Object -Property DedicatedUsage -Sum).Sum;"
        "$s=($rows | Measure-Object -Property SharedUsage -Sum).Sum;"
        "@{dedicated=[double]($d/1MB);shared=[double]($s/1MB)} | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", command],
            capture_output=True, text=True, timeout=10, check=True,
        )
        parsed = json.loads(completed.stdout.strip())
        return {
            "dedicated_mib": round(float(parsed.get("dedicated", 0.0)), 3),
            "shared_mib": round(float(parsed.get("shared", 0.0)), 3),
        }
    except Exception:
        return {"dedicated_mib": None, "shared_mib": None}


def query_gpu() -> Dict[str, Optional[float]]:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.free,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5, check=True,
        )
        used, free, utilization = [float(part.strip()) for part in completed.stdout.splitlines()[0].split(",")]
        return {"gpu_used_mib": used, "gpu_free_mib": free, "gpu_utilization": utilization}
    except Exception:
        return {"gpu_used_mib": None, "gpu_free_mib": None, "gpu_utilization": None}


class GpuMonitor:
    def __init__(self, pid: Optional[int]) -> None:
        self.pid = pid
        self.samples: List[Dict] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            sample = {"at": time.time(), **query_gpu(), **query_gpu_process_memory(self.pid)}
            self.samples.append(sample)
            self._stop.wait(1.0)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self._stop.set()
        self._thread.join(timeout=15)
        if not self.samples:
            self.samples.append({"at": time.time(), **query_gpu(), **query_gpu_process_memory(self.pid)})


def state_pid(explicit: Optional[int]) -> Optional[int]:
    if explicit:
        return explicit
    receipt = ROOT / ".local" / "vision" / "server-state.json"
    try:
        value = json.loads(receipt.read_text(encoding="utf-8")).get("pid")
        return int(value) if value else None
    except Exception:
        return None


def current_start_log_segment(log_path: Path) -> str:
    try:
        with log_path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 2_000_000), os.SEEK_SET)
            raw = handle.read(2_000_000)
    except OSError:
        return ""
    starts = list(START_MARKER_BYTES.finditer(raw))
    return raw[starts[-1].start():].decode("utf-8", errors="replace") if starts else ""


def _startup_log_evidence(segment: str, file_offset: int = 0) -> Dict:
    build = re.search(r"common_param:.*?build\s+(\d+)\s+\(", segment, re.IGNORECASE)
    if not build or int(build.group(1)) != 10218:
        raise RuntimeError("benchmark log does not contain a current b10218 startup segment")
    offloads = list(re.finditer(
        r"offloaded\s+(\d+)\s*/\s*(\d+)\s+layers\s+to\s+GPU",
        segment,
        re.IGNORECASE,
    ))
    if not offloads:
        raise RuntimeError("benchmark log startup segment has no GPU offload receipt")
    cuda_receipts = {
        "visionBackend": re.search(
            r"clip_ctx:\s*CLIP using CUDA0 backend", segment, re.IGNORECASE,
        ),
        "projectorComputeBuffer": re.search(
            r"reserve_compute_meta:\s*CUDA0 compute buffer size\s*=\s*"
            r"([0-9]+(?:\.[0-9]+)?)\s+MiB", segment, re.IGNORECASE,
        ),
        "kvBuffer": re.search(
            r"llama_kv_cache:\s*CUDA0 KV buffer size\s*=\s*"
            r"([0-9]+(?:\.[0-9]+)?)\s+MiB", segment, re.IGNORECASE,
        ),
        "computeBuffer": re.search(
            r"sched_reserve:\s*CUDA0 compute buffer size\s*=\s*"
            r"([0-9]+(?:\.[0-9]+)?)\s+MiB", segment, re.IGNORECASE,
        ),
    }
    missing_cuda = [name for name, receipt in cuda_receipts.items() if receipt is None]
    if missing_cuda:
        raise RuntimeError(
            "benchmark log startup segment lacks CUDA0 evidence for " + ", ".join(missing_cuda)
        )
    buffer_sizes = {
        "projectorComputeBufferMiB": float(cuda_receipts["projectorComputeBuffer"].group(1)),
        "kvBufferMiB": float(cuda_receipts["kvBuffer"].group(1)),
        "computeBufferMiB": float(cuda_receipts["computeBuffer"].group(1)),
    }
    if any(not math.isfinite(size) or size <= 0 for size in buffer_sizes.values()):
        raise RuntimeError("benchmark log reports an empty or invalid CUDA0 buffer")
    offload = offloads[-1]
    done, total = int(offload.group(1)), int(offload.group(2))
    receipt_end = max([offload.end(), *[receipt.end() for receipt in cuda_receipts.values()]])
    evidence_text = segment[:receipt_end]
    immutable_prefix = evidence_text.encode("utf-8")
    if len(immutable_prefix) > STARTUP_EVIDENCE_MAX_BYTES:
        raise RuntimeError("benchmark startup evidence exceeds its bounded receipt limit")
    return {
        "build": 10218,
        "offloadedLayers": done,
        "totalLayers": total,
        "allLayersGpu": total > 0 and done == total,
        "gpuResidency": {
            "visionBackend": "CUDA0",
            **buffer_sizes,
            "verified": True,
        },
        "capturedBytes": len(immutable_prefix),
        "fileOffset": file_offset,
        "sha256": hashlib.sha256(immutable_prefix).hexdigest(),
        "text": evidence_text,
    }


def current_start_log_evidence(log_path: Path) -> Dict:
    current_offset: Optional[int] = None
    candidate = bytearray()
    evidence: Optional[Dict] = None
    position = 0
    try:
        with log_path.open("rb") as handle:
            for line in handle:
                starts = list(START_MARKER_BYTES.finditer(line))
                if starts:
                    marker = starts[-1]
                    current_offset = position + marker.start()
                    candidate = bytearray(line[marker.start():])
                    evidence = None
                elif current_offset is not None and evidence is None:
                    candidate.extend(line)
                if current_offset is not None and evidence is None:
                    if len(candidate) > STARTUP_EVIDENCE_MAX_BYTES:
                        raise RuntimeError(
                            "benchmark startup evidence exceeds its bounded receipt limit"
                        )
                    receipts = [OFFLOAD_BYTES.search(candidate)] + [
                        pattern.search(candidate) for pattern in CUDA_RECEIPT_BYTES.values()
                    ]
                    if all(receipts):
                        receipt_end = max(receipt.end() for receipt in receipts)
                        captured = bytes(candidate[:receipt_end])
                        evidence = _startup_log_evidence(
                            captured.decode("utf-8", errors="replace"), current_offset,
                        )
                        candidate = bytearray()
                position += len(line)
    except OSError as error:
        raise RuntimeError(f"benchmark startup log is unavailable: {error}") from error
    if current_offset is None or evidence is None:
        raise RuntimeError("benchmark log does not contain a complete current startup segment")
    return evidence


def validate_saved_startup_log_evidence(log_path: Path, expected: object) -> Dict:
    if not isinstance(expected, dict) or not isinstance(expected.get("fileOffset"), int) or \
            not isinstance(expected.get("capturedBytes"), int):
        raise RuntimeError("benchmark startup evidence receipt is invalid")
    offset = expected["fileOffset"]
    length = expected["capturedBytes"]
    if offset < 0 or length <= 0 or length > STARTUP_EVIDENCE_MAX_BYTES:
        raise RuntimeError("benchmark startup evidence receipt is out of bounds")
    try:
        with log_path.open("rb") as handle:
            handle.seek(offset, os.SEEK_SET)
            captured = handle.read(length)
            if len(captured) != length:
                raise RuntimeError("benchmark startup evidence was truncated during inference")
            derived = _startup_log_evidence(
                captured.decode("utf-8", errors="replace"), offset,
            )
            if derived != expected:
                raise RuntimeError("benchmark startup evidence changed during inference")
            carry = b""
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                scanned = carry + chunk
                if START_MARKER_BYTES.search(scanned):
                    raise RuntimeError("a newer llama.cpp startup appeared during inference")
                carry = scanned[-4096:]
    except OSError as error:
        raise RuntimeError(f"benchmark startup log could not be revalidated: {error}") from error
    return expected


def all_layers_gpu(log_path: Path) -> bool:
    try:
        return current_start_log_evidence(log_path)["allLayersGpu"] is True
    except RuntimeError:
        return False


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _command_line_argv(command_line: str) -> List[str]:
    if not isinstance(command_line, str) or not command_line.strip() or "\0" in command_line:
        raise RuntimeError("benchmark server command line is missing or invalid")
    if os.name == "nt":
        argc = ctypes.c_int()
        convert = ctypes.windll.shell32.CommandLineToArgvW
        convert.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
        convert.restype = ctypes.POINTER(ctypes.c_wchar_p)
        argv_pointer = convert(command_line, ctypes.byref(argc))
        if not argv_pointer:
            raise RuntimeError("could not parse benchmark server command line")
        try:
            return [argv_pointer[index] for index in range(argc.value)]
        finally:
            ctypes.windll.kernel32.LocalFree(ctypes.cast(argv_pointer, ctypes.c_void_p))
    # Test/development fallback; production provenance verification is Windows-only.
    return [
        token[1:-1] if len(token) >= 2 and token[0] == token[-1] == '"' else token
        for token in shlex.split(command_line, posix=False)
    ]


def _normalized_path(value: object) -> str:
    text = str(value or "")
    if not text or not Path(text).is_absolute():
        raise RuntimeError("benchmark server command paths must be absolute")
    return os.path.normcase(str(Path(text).resolve()))


def parse_approved_server_command(
    command_line: str,
    executable: Path,
    weights: Path,
    projector: Path,
    api_key_file: Path,
    log_path: Path,
) -> Dict:
    argv = _command_line_argv(command_line)
    if not argv or _normalized_path(argv[0]) != _normalized_path(executable):
        raise RuntimeError("benchmark command executable does not match the pinned runtime")

    fixed_values = {
        "-m": str(weights),
        "--mmproj": str(projector),
        "--alias": "blackcat-vision",
        "--host": "127.0.0.1",
        "--port": "1235",
        "--api-key-file": str(api_key_file),
        "-ngl": "all",
        "-c": "8192",
        "-fa": "on",
        "-ctk": "q8_0",
        "-ctv": "q8_0",
        "--parallel": "1",
        "--reasoning": "off",
        "--image-min-tokens": "1024",
        "--image-max-tokens": "1024",
        "--cache-ram": "0",
        "--cors-origins": "http://127.0.0.1",
        "-lv": "4",
        "--log-file": str(log_path),
    }
    path_flags = {"-m", "--mmproj", "--api-key-file", "--log-file"}
    tuned_values = {
        "-b": {"512", "1024", "2048"},
        "-ub": {"256", "512", "1024"},
        "-t": {"8", "12", "16"},
    }
    switches = {"--no-cors-credentials", "--offline", "--no-webui"}
    values: Dict[str, str] = {}
    enabled = set()
    index = 1
    while index < len(argv):
        flag = argv[index]
        if flag in switches:
            if flag in enabled:
                raise RuntimeError(f"benchmark server command repeats {flag}")
            enabled.add(flag)
            index += 1
            continue
        if flag not in fixed_values and flag not in tuned_values:
            raise RuntimeError(f"benchmark server command has an unapproved argument: {flag}")
        if flag in values:
            raise RuntimeError(f"benchmark server command repeats {flag}")
        if index + 1 >= len(argv):
            raise RuntimeError(f"benchmark server command is missing the value for {flag}")
        values[flag] = argv[index + 1]
        index += 2

    missing = (set(fixed_values) | set(tuned_values)) - set(values)
    missing_switches = switches - enabled
    if missing or missing_switches:
        absent = sorted(missing | missing_switches)[0]
        raise RuntimeError(f"benchmark server command is missing {absent}")
    for flag, expected in fixed_values.items():
        actual = values[flag]
        matches = (
            _normalized_path(actual) == _normalized_path(expected)
            if flag in path_flags else actual == expected
        )
        if not matches:
            raise RuntimeError(f"benchmark server command has an unapproved {flag} value")
    for flag, allowed in tuned_values.items():
        if values[flag] not in allowed:
            raise RuntimeError(f"benchmark server command has an unapproved {flag} value")
    tuned = {flag: int(values[flag]) for flag in tuned_values}
    if tuned["-ub"] > tuned["-b"]:
        raise RuntimeError("benchmark micro-batch exceeds its batch")
    canonical = {"executable": _normalized_path(executable), "args": argv[1:]}
    return {
        "argv": argv,
        "tuned": tuned,
        "fingerprint": hashlib.sha256(
            json.dumps(canonical, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        ).hexdigest(),
    }


def _server_process(pid: int) -> Dict:
    if os.name != "nt":
        raise RuntimeError("local vision benchmark process verification requires Windows")
    command = (
        f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}' -ErrorAction Stop;"
        "if(-not $p){throw 'process not found'};"
        "@{pid=[int]$p.ProcessId;executable=[string]$p.ExecutablePath;"
        "commandLine=[string]$p.CommandLine;creationTime=$p.CreationDate.ToUniversalTime().ToString('o')}"
        "|ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True, text=True, timeout=15, check=True,
    )
    return json.loads(completed.stdout.strip())


def _listener_pids(port: int) -> List[int]:
    command = (
        f"@(Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue"
        "|ForEach-Object{@{address=[string]$_.LocalAddress;pid=[int]$_.OwningProcess}})"
        "|ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True, text=True, timeout=15, check=True,
    )
    raw = json.loads(completed.stdout.strip() or "[]")
    rows = raw if isinstance(raw, list) else [raw]
    if any(row.get("address") != "127.0.0.1" for row in rows):
        raise RuntimeError("port 1235 has a non-loopback or ambiguous listener")
    return sorted({int(row["pid"]) for row in rows})


def _get_local_json(path: str, api_key_file: Path) -> Dict:
    if not api_key_file.is_file() or api_key_file.stat().st_size > 256:
        raise RuntimeError("local vision API credential is missing or invalid")
    api_key = api_key_file.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", api_key):
        raise RuntimeError("local vision API credential is missing or invalid")
    request = vision_helpers.urllib.request.Request(
        f"http://127.0.0.1:1235{path}",
        headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    with vision_helpers._build_local_vision_opener().open(request, timeout=3) as response:
        return json.loads(response.read(256 * 1024).decode("utf-8"))


def validate_server_provenance(
    pid: Optional[int], log_path: Path, model_profile: str = "q4",
    expected_startup_evidence: Optional[Dict] = None,
) -> Dict:
    if not pid:
        raise RuntimeError("a verified local llama.cpp server PID is required")
    manifest_path = ROOT / "config" / "local-vision.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    asset_root = (ROOT / manifest["assetRoot"]).resolve()
    executable = (asset_root / manifest["runtime"]["directory"] /
                  manifest["runtime"]["executable"]).resolve()
    if model_profile == "q4":
        model_pin = manifest["model"]
        profile_manifest_path = manifest_path
    elif model_profile == "q6":
        model_pin = load_q6_profile()
        profile_manifest_path = Q6_PROFILE_PATH
    else:
        raise RuntimeError("unsupported benchmark model profile")
    model_directory = (asset_root / model_pin["directory"]).resolve()
    weights = (model_directory / model_pin["weights"]["name"]).resolve()
    projector = (model_directory / model_pin["projector"]["name"]).resolve()
    api_key_file = (asset_root / manifest["server"]["apiKeyFile"]).resolve()
    for path, pin in ((weights, model_pin["weights"]), (projector, model_pin["projector"])):
        if not path.is_file() or path.stat().st_size != int(pin["size"]):
            raise RuntimeError(f"benchmark model artifact is missing or truncated: {path}")
        if _sha256_file(path) != pin["sha256"]:
            raise RuntimeError(f"benchmark model artifact failed SHA-256 verification: {path}")
    process = _server_process(pid)
    if int(process.get("pid") or 0) != pid:
        raise RuntimeError("benchmark process identity did not match the requested PID")
    creation_time = process.get("creationTime")
    if not isinstance(creation_time, str) or not creation_time.strip():
        raise RuntimeError("benchmark process creation time is unavailable")
    if Path(process.get("executable") or "").resolve() != executable:
        raise RuntimeError("benchmark PID is not the pinned llama-server executable")
    listeners = _listener_pids(int(manifest["server"]["port"]))
    if listeners != [pid]:
        raise RuntimeError("benchmark PID does not exclusively own 127.0.0.1:1235")

    parsed_command = parse_approved_server_command(
        str(process.get("commandLine") or ""),
        executable,
        weights,
        projector,
        api_key_file,
        log_path.resolve(),
    )
    tuned = parsed_command["tuned"]

    health = _get_local_json("/health", api_key_file)
    models = _get_local_json("/v1/models", api_key_file)
    aliases = [entry.get("id") for entry in models.get("data", []) if isinstance(entry, dict)]
    if health.get("status") != "ok" or aliases != ["blackcat-vision"]:
        raise RuntimeError("benchmark server health/model identity did not match blackcat-vision")
    startup_evidence = (
        validate_saved_startup_log_evidence(log_path, expected_startup_evidence)
        if expected_startup_evidence is not None
        else current_start_log_evidence(log_path)
    )

    return {
        "schemaVersion": PROVENANCE_SCHEMA_VERSION,
        "verified": True,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "pid": pid,
        "creationTime": creation_time,
        "executable": str(executable),
        "executableSha256": _sha256_file(executable),
        "commandFingerprint": parsed_command["fingerprint"],
        "manifestConfigSha256": _sha256_file(manifest_path),
        "modelProfileConfigSha256": _sha256_file(profile_manifest_path),
        "listener": "127.0.0.1:1235",
        "modelAlias": "blackcat-vision",
        "modelProfile": model_profile,
        "modelRevision": model_pin.get("revision"),
        "weightsSha256": model_pin["weights"]["sha256"],
        "projectorSha256": model_pin["projector"]["sha256"],
        "profile": {
            "batch": tuned["-b"], "microBatch": tuned["-ub"], "threads": tuned["-t"],
        },
        "startupLogEvidence": startup_evidence,
    }


_STABLE_PROVENANCE_FIELDS = (
    "schemaVersion", "verified", "pid", "creationTime", "executable",
    "executableSha256", "commandFingerprint", "manifestConfigSha256",
    "modelProfileConfigSha256", "listener", "modelAlias", "modelProfile",
    "modelRevision", "weightsSha256", "projectorSha256", "profile",
    "startupLogEvidence",
)


def _assert_same_server_provenance(before: Dict, after: Dict) -> None:
    for field in _STABLE_PROVENANCE_FIELDS:
        if before.get(field) != after.get(field):
            raise RuntimeError(f"benchmark server provenance changed during inference: {field}")


def revalidate_server_provenance(
    before: Dict, pid: Optional[int], log_path: Path, model_profile: str,
) -> Dict:
    after = validate_server_provenance(
        pid,
        log_path,
        model_profile,
        expected_startup_evidence=before.get("startupLogEvidence"),
    )
    _assert_same_server_provenance(before, after)
    return {**before, "revalidatedAt": after["verifiedAt"]}


def provenance_is_verified(value: object) -> bool:
    if not isinstance(value, dict) or value.get("verified") is not True or \
            value.get("schemaVersion") != PROVENANCE_SCHEMA_VERSION:
        return False
    hashes = (
        "executableSha256", "commandFingerprint", "manifestConfigSha256",
        "modelProfileConfigSha256", "weightsSha256", "projectorSha256",
    )
    if any(not isinstance(value.get(field), str) or
           re.fullmatch(r"[0-9a-f]{64}", value[field]) is None for field in hashes):
        return False
    if not isinstance(value.get("pid"), int) or value["pid"] <= 0 or \
            not isinstance(value.get("creationTime"), str) or not value["creationTime"] or \
            not isinstance(value.get("executable"), str) or not value["executable"] or \
            value.get("listener") != "127.0.0.1:1235" or \
            value.get("modelAlias") != "blackcat-vision" or \
            value.get("modelProfile") not in {"q4", "q6"} or \
            not isinstance(value.get("modelRevision"), str) or \
            re.fullmatch(r"[0-9a-f]{40}", value["modelRevision"]) is None:
        return False
    for field in ("verifiedAt", "revalidatedAt"):
        try:
            timestamp = datetime.fromisoformat(str(value.get(field) or "").replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                return False
        except ValueError:
            return False
    profile = value.get("profile")
    if not isinstance(profile, dict) or profile.get("batch") not in {512, 1024, 2048} or \
            profile.get("microBatch") not in {256, 512, 1024} or \
            profile.get("threads") not in {8, 12, 16} or \
            profile["microBatch"] > profile["batch"]:
        return False
    evidence = value.get("startupLogEvidence")
    if not isinstance(evidence, dict) or not isinstance(evidence.get("text"), str):
        return False
    try:
        offset = evidence.get("fileOffset")
        return (
            isinstance(offset, int)
            and offset >= 0
            and evidence == _startup_log_evidence(evidence["text"], offset)
        )
    except RuntimeError:
        return False


def summarize(
    rows: List[Dict], gpu_samples: List[Dict], server_provenance: Optional[Dict] = None,
) -> Dict:
    successes = [row for row in rows if row["success"]]
    comparisons = [comparison for row in rows for comparison in row["comparisons"]]
    claims = []
    for row in rows:
        expected = row.get("expected") if isinstance(row.get("expected"), dict) else {}
        predicted = row.get("predicted") if isinstance(row.get("predicted"), dict) else {}
        for field in ("brand", "size"):
            predicted_value = predicted.get(field)
            if known(predicted_value):
                expected_value = expected.get(field)
                claims.append({
                    "field": field,
                    "expected": expected_value,
                    "predicted": predicted_value,
                    "match": known(expected_value) and
                             normalized(expected_value) == normalized(predicted_value),
                })
    latencies = [row["latency_s"] for row in rows]
    ttft_estimates = [
        float(row["ttft_estimate_s"])
        for row in rows
        if isinstance(row.get("ttft_estimate_s"), (int, float))
    ]
    prompt_rates = [
        float(row["timings"]["prompt_per_second"])
        for row in rows
        if isinstance(row.get("timings"), dict)
        and isinstance(row["timings"].get("prompt_per_second"), (int, float))
    ]
    output_rates = [
        float(row["timings"]["predicted_per_second"])
        for row in rows
        if isinstance(row.get("timings"), dict)
        and isinstance(row["timings"].get("predicted_per_second"), (int, float))
    ]
    shared = [sample["shared_mib"] for sample in gpu_samples if sample.get("shared_mib") is not None]
    whole_gpu = [sample["gpu_used_mib"] for sample in gpu_samples if sample.get("gpu_used_mib") is not None]
    process_dedicated = [sample["dedicated_mib"] for sample in gpu_samples if sample.get("dedicated_mib") is not None]
    accuracy = sum(1 for comparison in comparisons if comparison["match"]) / len(comparisons) if comparisons else 0.0
    false_claim_rate = sum(1 for claim in claims if not claim["match"]) / len(claims) if claims else 0.0
    verified_provenance = provenance_is_verified(server_provenance)
    startup_evidence = (
        server_provenance.get("startupLogEvidence", {})
        if isinstance(server_provenance, dict) else {}
    )
    gpu_residency = (
        startup_evidence.get("gpuResidency", {})
        if isinstance(startup_evidence, dict) else {}
    )
    cuda_buffers = (
        "projectorComputeBufferMiB", "kvBufferMiB", "computeBufferMiB",
    )
    cuda_residency_verified = (
        verified_provenance
        and isinstance(gpu_residency, dict)
        and gpu_residency.get("visionBackend") == "CUDA0"
        and gpu_residency.get("verified") is True
        and all(
            isinstance(gpu_residency.get(field), (int, float))
            and math.isfinite(float(gpu_residency[field]))
            and float(gpu_residency[field]) > 0
            for field in cuda_buffers
        )
    )
    summary = {
        "scoring_version": SCORING_VERSION,
        "comparison_fields": list(CORE_FIELDS),
        "requests": len(rows),
        "successes": len(successes),
        "success_rate": len(successes) / len(rows) if rows else 0.0,
        "json_valid_rate": sum(1 for row in rows if row["json_valid"]) / len(rows) if rows else 0.0,
        "core_field_accuracy": accuracy,
        "brand_size_false_claim_rate": false_claim_rate,
        "latency_s": {
            "median": statistics.median(latencies) if latencies else 0.0,
            "p95": percentile(latencies, 0.95),
            "maximum": max(latencies, default=0.0),
        },
        "performance": {
            # llama.cpp's non-streaming response does not expose a first-token
            # timestamp. Subtracting its measured generation time from the
            # client-observed latency is the closest reproducible TTFT estimate.
            "ttft_estimate_s": {
                "median": statistics.median(ttft_estimates) if ttft_estimates else None,
                "p95": percentile(ttft_estimates, 0.95) if ttft_estimates else None,
            },
            "prompt_tokens_per_s": {
                "median": statistics.median(prompt_rates) if prompt_rates else None,
                "p95": percentile(prompt_rates, 0.95) if prompt_rates else None,
            },
            "output_tokens_per_s": {
                "median": statistics.median(output_rates) if output_rates else None,
                "p95": percentile(output_rates, 0.95) if output_rates else None,
            },
        },
        "peak_whole_gpu_used_mib": max(whole_gpu) if whole_gpu else None,
        "peak_server_dedicated_mib": max(process_dedicated) if process_dedicated else None,
        "peak_server_shared_mib": max(shared) if shared else None,
        "gpu_process_memory_observed": bool(shared or process_dedicated),
        "all_layers_gpu_from_log": (
            verified_provenance and startup_evidence.get("allLayersGpu") is True
        ),
        "cuda_vision_kv_compute_from_log": (
            cuda_residency_verified
        ),
        "truncated_requests": sum(1 for row in rows if row.get("finish_reason") != "stop"),
    }
    summary["acceptance"] = {
        "success_and_json": summary["success_rate"] == 1.0 and summary["json_valid_rate"] == 1.0,
        "core_accuracy_at_least_85_percent": accuracy >= 0.85,
        "brand_size_false_claims_at_most_5_percent": false_claim_rate <= 0.05,
        "p95_at_most_60_seconds": summary["latency_s"]["p95"] <= 60.0,
        "zero_shared_memory": bool(shared) and max(shared) == 0.0,
        "all_layers_gpu": summary["all_layers_gpu_from_log"],
        "cuda_vision_kv_compute": summary["cuda_vision_kv_compute_from_log"],
        "no_truncation": summary["truncated_requests"] == 0,
        "verified_server_provenance": verified_provenance,
    }
    summary["qualified"] = all(summary["acceptance"].values())
    return summary


def payload_is_qualified(payload: object) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("summary"), dict)
        and payload["summary"].get("qualified") is True
        and provenance_is_verified(payload.get("serverProvenance"))
    )


def benchmark(args: argparse.Namespace) -> Dict:
    database = Path(args.database)
    with open_read_only(database) as connection:
        selected = select_stratified(load_candidates(connection), args.items)
    if len(selected) < args.items:
        raise RuntimeError(f"Only {len(selected)} confirmed items with existing photos were available")

    photo_counts = sorted(set(args.photo_counts))
    if any(count not in {1, 2, 4} for count in photo_counts):
        raise ValueError("photo counts must be selected from 1, 2, and 4")
    settings = {
        "visionEnabled": True,
        "visionMaxPhotos": 4,
        "visionFields": list(CORE_FIELDS),
        "visionTimeoutSeconds": args.timeout,
        "visionMaxTokens": 1800,
    }
    rows: List[Dict] = []
    pid = state_pid(args.server_pid)
    log_path = Path(args.server_log)
    provenance = validate_server_provenance(pid, log_path, args.model_profile)
    print(f"Benchmarking {len(selected)} confirmed items × {photo_counts} × {args.repeats} repeats")
    print(f"Read-only database: {database.resolve()}")
    print(f"Server PID for shared-memory counters: {pid or 'unavailable'}")

    with GpuMonitor(pid) as monitor:
        with managed_vision_session(f"blackcat-benchmark:{args.label}") as client:
            request_number = 0
            total = len(selected) * len(photo_counts) * args.repeats
            for item in selected:
                for photo_count in photo_counts:
                    for repeat in range(1, args.repeats + 1):
                        request_number += 1
                        run_settings = {**settings, "visionMaxPhotos": photo_count}
                        enricher = ManagedVisionEnricher(run_settings, client)
                        started = time.perf_counter()
                        enrichment = enricher.enrich(item["sku"], item["photos"])
                        latency = time.perf_counter() - started
                        predicted = enrichment.get("fields") if isinstance(enrichment.get("fields"), dict) else {}
                        comparisons = build_comparisons(item["expected"], predicted)
                        meta = dict(enricher.last_meta or {})
                        timings = meta.get("timings") if isinstance(meta.get("timings"), dict) else {}
                        predicted_ms = timings.get("predicted_ms")
                        ttft_estimate_s = (
                            max(0.0, latency - float(predicted_ms) / 1000.0)
                            if isinstance(predicted_ms, (int, float))
                            else None
                        )
                        row = {
                            "sku": item["sku"],
                            "category": item["category"],
                            "status": item["status"],
                            "photo_count": photo_count,
                            "repeat": repeat,
                            "latency_s": round(latency, 4),
                            "ttft_estimate_s": (
                                round(ttft_estimate_s, 4) if ttft_estimate_s is not None else None
                            ),
                            "success": not bool(enrichment.get("error")),
                            "json_valid": isinstance(enrichment.get("raw"), dict),
                            "error": enrichment.get("error"),
                            "expected": item["expected"],
                            "predicted": predicted,
                            "comparisons": comparisons,
                            "usage": meta.get("usage"),
                            "timings": timings,
                            "finish_reason": meta.get("finish_reason"),
                        }
                        rows.append(row)
                        matches = sum(1 for comparison in comparisons if comparison["match"])
                        print(
                            f"[{request_number:03d}/{total:03d}] {item['sku']} "
                            f"photos={photo_count} repeat={repeat} {latency:.1f}s "
                            f"fields={matches}/{len(comparisons)} "
                            f"{'ok' if row['success'] else row['error']}"
                        )

    provenance = revalidate_server_provenance(
        provenance, pid, log_path, args.model_profile,
    )
    summary = summarize(rows, monitor.samples, provenance)
    return {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "scoringVersion": SCORING_VERSION,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "label": args.label,
        "model": "blackcat-vision",
        "modelProfile": args.model_profile,
        "database": str(database.resolve()),
        "selectedSkus": [item["sku"] for item in selected],
        "photoCounts": photo_counts,
        "repeats": args.repeats,
        "serverPid": pid,
        "serverLog": str(log_path.resolve()),
        "serverProvenance": provenance,
        "summary": summary,
        "rows": rows,
        "gpuSamples": monitor.samples,
    }


def write_results(payload: Dict, output_directory: Path) -> Path:
    output_directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_label = re.sub(r"[^a-zA-Z0-9_.-]+", "-", payload["label"]).strip("-") or "profile"
    json_path = output_directory / f"{stamp}-{safe_label}.json"
    csv_path = output_directory / f"{stamp}-{safe_label}.csv"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "sku", "category", "status", "photo_count", "repeat", "latency_s",
            "ttft_estimate_s", "prompt_tokens_per_s", "output_tokens_per_s",
            "success", "json_valid", "error", "field_matches", "field_total",
        ])
        writer.writeheader()
        for row in payload["rows"]:
            writer.writerow({
                **{key: row.get(key) for key in writer.fieldnames or []},
                "prompt_tokens_per_s": (row.get("timings") or {}).get("prompt_per_second"),
                "output_tokens_per_s": (row.get("timings") or {}).get("predicted_per_second"),
                "field_matches": sum(1 for value in row["comparisons"] if value["match"]),
                "field_total": len(row["comparisons"]),
            })
    return json_path


def rescore_results(source: Path, output_directory: Path) -> Path:
    payload = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list) or \
            not isinstance(payload.get("gpuSamples"), list):
        raise ValueError("rescore input is not a Black Cat vision benchmark result")
    for row in payload["rows"]:
        if not isinstance(row, dict):
            raise ValueError("rescore input contains an invalid benchmark row")
        row["comparisons"] = build_comparisons(row.get("expected"), row.get("predicted"))
    provenance = payload.get("serverProvenance")
    if not provenance_is_verified(provenance):
        payload["serverProvenance"] = {
            "schemaVersion": PROVENANCE_SCHEMA_VERSION,
            "verified": False,
            "reason": "saved run lacks verifiable immutable server provenance",
        }
    payload["summary"] = summarize(
        payload["rows"], payload["gpuSamples"], payload["serverProvenance"],
    )
    payload["schemaVersion"] = RESULT_SCHEMA_VERSION
    payload["scoringVersion"] = SCORING_VERSION
    payload["rescoredAt"] = datetime.now(timezone.utc).isoformat()
    payload["label"] = str(payload.get("label") or "profile") + "-rescored"
    return write_results(payload, output_directory)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    value.add_argument("--database", default=str(ROOT / "data" / "black-cat.db"))
    value.add_argument("--items", type=int, default=24)
    value.add_argument("--repeats", type=int, default=3)
    value.add_argument("--photo-counts", type=int, nargs="+", default=[1, 2, 4])
    value.add_argument("--timeout", type=int, default=120)
    value.add_argument("--label", default="q4-k-m-b512-ub256-t12")
    value.add_argument("--server-pid", type=int)
    value.add_argument("--server-log", default=str(ROOT / ".local" / "vision" / "logs" / "llama-server.log"))
    value.add_argument("--model-profile", choices=("q4", "q6"), default="q4")
    value.add_argument("--output", default=str(ROOT / "var" / "benchmarks"))
    value.add_argument("--rescore", type=Path, help="Rescore a saved result without inference")
    value.add_argument("--smoke", action="store_true", help="Run three items, four photos, once")
    return value


def main() -> int:
    args = parser().parse_args()
    if args.rescore:
        result_path = rescore_results(args.rescore, Path(args.output))
        payload = json.loads(result_path.read_text(encoding="utf-8"))
        print(json.dumps(payload["summary"], indent=2))
        print(f"Rescored results: {result_path}")
        return 0 if payload_is_qualified(payload) else 2
    if args.smoke:
        args.items = 3
        args.repeats = 1
        args.photo_counts = [4]
        args.label += "-smoke"
    if not 1 <= args.items <= 30 or not 1 <= args.repeats <= 3:
        raise ValueError("items must be 1..30 and repeats must be 1..3")
    payload = benchmark(args)
    result_path = write_results(payload, Path(args.output))
    print(json.dumps(payload["summary"], indent=2))
    print(f"Detailed results: {result_path}")
    return 0 if payload_is_qualified(payload) else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Benchmark cancelled; the database was opened read-only.", file=sys.stderr)
        raise SystemExit(130)
