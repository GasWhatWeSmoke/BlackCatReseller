"""Worker entrypoint: `python -m black_cat_worker.process`.

Modes:
  (default)   full pass: stability filter -> exif sort -> decode -> group ->
              dedup -> copy-forward + thumbnails + archive originals; prints a
              JSON `result` event that Next.js persists via Prisma.
  --dry-run   decode + group only (no file ops, no archive); prints the grouping
              for inspection. Used to validate logic against a fixture folder.

All stdout lines are JSON objects ({"event": ...}). Progress events stream;
the final {"event":"result"} carries the payload.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import stat
import sys
import time
from typing import Callable, Dict, List, Optional
from uuid import uuid4

from . import config, db as dbmod, dedup, fileops, tag_ocr
from .decode import Decoder
from .exif_sort import get_exif, order_photos
from .grouping import DecodedPhoto, GroupedItem, group_photos
from .managed_vision import (
    ManagedVisionCancelled,
    ManagedVisionDeferred,
    ManagedVisionEnricher,
    assert_enrichment_batch_budget,
    managed_vision_session,
    validate_worker_enrichment,
)

_IMAGE_EXTS = {".jpg", ".jpeg"}
FORCE_NO_AI_ENV = "BLACKCAT_FORCE_NO_AI"
CANCEL_FILE_ENV = "BLACKCAT_CANCEL_FILE"
PARENT_PID_ENV = "BLACKCAT_PARENT_PID"
PARENT_CREATION_TOKEN_ENV = "BLACKCAT_PARENT_CREATION_TOKEN"
FORCE_SKIP_ERROR = "AI identification skipped by operator request"
MAX_INTAKE_FILES = 1_000
MAX_IMAGE_FILE_BYTES = 256 * 1024 * 1024
MAX_INTAKE_TOTAL_BYTES = 16 * 1024 * 1024 * 1024
MAX_IMAGE_SIDE = 20_000
MAX_IMAGE_PIXELS = 100_000_000
MAX_GROUP_PHOTOS = 32
MAX_PROJECTED_RESULT_BYTES = 28 * 1024 * 1024
MAX_RECEIPT_PROBLEMS = 50_000
MAX_RECEIPT_DURATION_MS = 7 * 24 * 60 * 60 * 1_000
MAX_INCOMING_SETTLE_SECONDS = 30
MANAGED_WORK_ROOT_KEYS = (
    "incomingPath", "processingPath", "needsReviewPath", "archivePath",
)


def _utf16_units(value: str) -> int:
    """Mirror JavaScript String.length for receipt-bound text."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _truncate_utf16(value: str, maximum: int) -> str:
    if _utf16_units(value) <= maximum:
        return value
    chars: List[str] = []
    used = 0
    for char in value:
        units = 2 if ord(char) > 0xFFFF else 1
        if used + units > maximum:
            break
        chars.append(char)
        used += units
    return "".join(chars)


def _bounded_receipt_text(value: object, maximum: int) -> Optional[str]:
    """Collapse control/whitespace runs and bound a receipt string in UTF-16."""
    if value is None:
        return None
    cleaned = "".join(
        " " if ord(char) < 32 or ord(char) == 127
        else "\ufffd" if 0xD800 <= ord(char) <= 0xDFFF
        else char
        for char in str(value)
    )
    bounded = _truncate_utf16(" ".join(cleaned.split()), maximum)
    return bounded or None


def _bounded_receipt_duration(started: float) -> int:
    elapsed = max(0, int((time.time() - started) * 1000))
    return min(elapsed, MAX_RECEIPT_DURATION_MS)


def _normalized_problem_receipts(problems: List[Dict]) -> List[Dict]:
    """Make every final problem row satisfy the untrusted Node IPC schema.

    This is deliberately non-throwing because archive/needs-review failures can
    be discovered after the worker's mutation fence has been sealed.  Their
    bounded diagnostic must never invalidate the otherwise recoverable receipt.
    """
    normalized: List[Dict] = []
    safe_sku_chars = frozenset(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
    )
    for value in problems[:MAX_RECEIPT_PROBLEMS]:
        row = value if isinstance(value, dict) else {}
        problem_type = _bounded_receipt_text(row.get("type"), 128)
        result: Dict = {"type": problem_type or "WORKER_PROBLEM"}

        if "sku" in row:
            if row.get("sku") is None:
                result["sku"] = None
            else:
                sku = _bounded_receipt_text(row.get("sku"), 128)
                if (
                    sku
                    and sku[0].isalnum()
                    and sku[0].isascii()
                    and ".." not in sku
                    and all(char in safe_sku_chars for char in sku)
                ):
                    result["sku"] = sku

        if "photoPath" in row:
            photo_path = row.get("photoPath")
            if photo_path is None:
                result["photoPath"] = None
            elif isinstance(photo_path, str) and (
                _utf16_units(photo_path) <= 32_768
                and not any(ord(char) < 32 or ord(char) == 127 for char in photo_path)
            ):
                result["photoPath"] = photo_path

        if "message" in row:
            result["message"] = _bounded_receipt_text(row.get("message"), 4_096) or ""
        normalized.append(result)
    return normalized


def emit(event: Dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _progress_step(total: int) -> int:
    """Emit cadence for a per-file phase: at most ~200 events, so a big batch
    still moves the bar smoothly without spending the parent's 20k-event
    progress budget on a single pass."""
    return max(1, total // 200)


def _configure_utf8_stdout() -> None:
    """Keep the JSON protocol Unicode-safe under Windows legacy code pages."""
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")


def _env_flag(name: str, environ=None) -> bool:
    environ = os.environ if environ is None else environ
    return str(environ.get(name) or "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _windows_process_creation_token(pid: int) -> Optional[str]:
    """Return the Windows FILETIME creation token for PID-reuse protection."""
    if os.name != "nt":
        return None
    from ctypes import wintypes

    class FILETIME(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetProcessTimes.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL
    process = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not process:
        return None
    try:
        creation, exit_time, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        ok = kernel32.GetProcessTimes(
            process,
            ctypes.byref(creation), ctypes.byref(exit_time),
            ctypes.byref(kernel), ctypes.byref(user),
        )
        value = (int(creation.high) << 32) | int(creation.low)
        return str(value) if ok else None
    finally:
        kernel32.CloseHandle(process)


def _process_creation_token(pid: int) -> Optional[str]:
    if pid <= 0:
        return None
    if os.name == "nt":
        return _windows_process_creation_token(pid)
    # Linux field 22 is the process start time in clock ticks since boot.
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="ascii") as handle:
            fields = handle.read().split()
        return fields[21] if len(fields) > 21 else None
    except OSError:
        try:
            os.kill(pid, 0)
        except OSError:
            return None
        # Non-Linux test/development fallback proves liveness but not PID reuse.
        return f"live:{pid}"


class CancellationGuard:
    """Immutable cancel/parent identity sampled once at worker startup."""

    def __init__(
        self,
        environ=None,
        *,
        exists_fn: Callable[[str], bool] = os.path.exists,
        token_fn: Callable[[int], Optional[str]] = _process_creation_token,
    ) -> None:
        environ = os.environ if environ is None else environ
        self._exists_fn = exists_fn
        self._token_fn = token_fn
        self.cancel_file = str(environ.get(CANCEL_FILE_ENV) or "").strip()
        if self.cancel_file and not os.path.isabs(self.cancel_file):
            raise RuntimeError(f"{CANCEL_FILE_ENV} must be an absolute path")

        parent_text = str(environ.get(PARENT_PID_ENV) or "").strip()
        self.parent_pid: Optional[int] = None
        self.parent_token = ""
        if parent_text:
            try:
                self.parent_pid = int(parent_text)
            except ValueError as exc:
                raise RuntimeError(f"{PARENT_PID_ENV} is not a valid PID") from exc
            supplied = str(
                environ.get(PARENT_CREATION_TOKEN_ENV) or ""
            ).strip()
            observed = self._token_fn(self.parent_pid)
            if observed is None or (supplied and observed != supplied):
                raise ManagedVisionCancelled("parent process exited")
            self.parent_token = supplied or observed

    def __call__(self) -> None:
        if self.cancel_file:
            try:
                if self._exists_fn(self.cancel_file):
                    raise ManagedVisionCancelled("intake cancellation requested")
            except ManagedVisionCancelled:
                raise
            except OSError as exc:
                raise RuntimeError(f"cannot read cancellation state: {exc}") from exc

        if self.parent_pid is not None:
            current = self._token_fn(self.parent_pid)
            if current is None or current != self.parent_token:
                raise ManagedVisionCancelled("parent process exited")


class MutationCancellationFence:
    """Observe cancellation until the first irreversible file mutation.

    Once source bytes, model cleanup, and one final cancellation checkpoint are
    proven, the worker must finish producing its result. Aborting midway through
    copy/archive work would leave processing files without the Node persistence
    receipt that owns them.
    """

    def __init__(self, check: Callable[[], None]) -> None:
        self._check = check
        self._sealed = False

    def __call__(self) -> None:
        if not self._sealed:
            self._check()

    def seal(self) -> None:
        self._check()
        self._sealed = True


def _list_incoming(incoming: str):
    files, skipped_non_image = [], []
    try:
        names = sorted(os.listdir(incoming))
    except FileNotFoundError:
        return files, skipped_non_image
    for name in names:
        full = os.path.join(incoming, name)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext in _IMAGE_EXTS:
            files.append(full)
        elif not name.startswith("."):
            skipped_non_image.append(full)
    return files, skipped_non_image


def _validate_incoming_workset(
    paths: List[str],
    cancel_check: Callable[[], None],
) -> None:
    """Bound direct input files before OCR, model admission, or mutation."""
    if len(paths) > MAX_INTAKE_FILES:
        raise RuntimeError(
            f"incoming workset exceeds the {MAX_INTAKE_FILES}-file safety limit"
        )
    total_bytes = 0
    seen = set()
    for source in paths:
        cancel_check()
        absolute = os.path.abspath(source)
        filename = os.path.basename(absolute)
        if (
            not filename
            or filename in {".", ".."}
            or _utf16_units(filename) > 255
            or any(ord(char) < 32 or ord(char) == 127 for char in filename)
        ):
            raise RuntimeError("incoming workset contains an unsafe filename")
        key = os.path.normcase(absolute)
        if key in seen or os.path.islink(source):
            raise RuntimeError("incoming workset contains a duplicate or linked path")
        seen.add(key)
        try:
            info = os.stat(source, follow_symlinks=False)
        except (OSError, TypeError) as exc:
            raise RuntimeError("incoming workset contains an unreadable file") from exc
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("incoming workset contains a non-regular file")
        if info.st_size < 0 or info.st_size > MAX_IMAGE_FILE_BYTES:
            raise RuntimeError("incoming file exceeds the per-file safety limit")
        total_bytes += int(info.st_size)
        if total_bytes > MAX_INTAKE_TOTAL_BYTES:
            raise RuntimeError("incoming workset exceeds the aggregate byte limit")
        cancel_check()


def _settled_incoming(incoming: str, stability: float, cancel_check: Callable[[], None]):
    """Wait for the whole workset; dropping a young marker splits its item."""
    if not math.isfinite(stability) or stability < 0:
        raise RuntimeError("File stability must be a finite number of zero or more seconds")
    deadline = time.monotonic() + MAX_INCOMING_SETTLE_SECONDS
    waiting = False
    while True:
        cancel_check()
        files, non_images = _list_incoming(incoming)
        _validate_incoming_workset(files + non_images, cancel_check)
        now = time.time()
        if all(fileops.is_stable(source, stability, now) for source in files + non_images):
            return files, non_images
        if not waiting:
            emit({"event": "progress", "stage": "scan",
                  "message": "Waiting for the photo batch to finish copying..."})
            waiting = True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Incoming files are still being copied. No items were saved; wait for copying to finish and retry.")
        time.sleep(min(0.25, remaining))


def _assert_incoming_workset(incoming: str, expected: List[str]) -> None:
    current = _list_incoming(incoming)
    identity = lambda paths: {os.path.normcase(os.path.abspath(value)) for value in paths}
    if identity(current[0] + current[1]) != identity(expected):
        raise RuntimeError("Incoming files changed while processing. No items were saved; wait for copying to finish and retry.")


def _paths_overlap(left: str, right: str) -> bool:
    try:
        common = os.path.normcase(os.path.commonpath([left, right]))
    except ValueError:
        return False
    return common in {os.path.normcase(left), os.path.normcase(right)}


def _validate_managed_work_roots(settings: Dict) -> None:
    """Mirror the Node preflight for direct worker invocations.

    Missing first-run leaf directories are validated prospectively and remain
    uncreated until managed admission succeeds. Redirecting existing ancestors
    and overlapping source/destination roots fail before OCR or inference.
    """
    roots = []
    for key in MANAGED_WORK_ROOT_KEYS:
        value = settings.get(key)
        if (
            not isinstance(value, str)
            or value != value.strip()
            or len(value.encode("utf-16-le", "surrogatepass")) // 2 > 4_096
            or not os.path.isabs(value)
        ):
            raise RuntimeError(f"{key} must be an absolute path")
        lexical = os.path.abspath(value)
        nearest = lexical
        while not os.path.exists(nearest):
            if os.path.lexists(nearest):
                raise RuntimeError(f"{key} has an unusable linked path component")
            parent = os.path.dirname(nearest)
            if parent == nearest:
                raise RuntimeError(f"{key} has no usable existing ancestor")
            nearest = parent
        try:
            info = os.lstat(nearest)
        except OSError as exc:
            raise RuntimeError(f"{key} has no usable existing ancestor") from exc
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(f"{key} must be a directory or safely creatable path")
        existing_real = os.path.abspath(os.path.realpath(nearest))
        missing_leaf = os.path.normcase(nearest) != os.path.normcase(lexical)
        if missing_leaf and os.path.normcase(existing_real) != os.path.normcase(nearest):
            raise RuntimeError(f"{key} has a linked or reparse-point ancestor")
        suffix = os.path.relpath(lexical, nearest)
        prospective_real = (
            os.path.abspath(os.path.join(existing_real, suffix))
            if missing_leaf else existing_real
        )
        roots.append((key, lexical, prospective_real))

    for index, (left_key, left_lexical, left_real) in enumerate(roots):
        for right_key, right_lexical, right_real in roots[index + 1:]:
            if (
                _paths_overlap(left_lexical, right_lexical)
                or _paths_overlap(left_real, right_real)
            ):
                raise RuntimeError(
                    f"{left_key} and {right_key} must be separate non-nested directories"
                )


def _assert_bounded_image_dimensions(width: object, height: object) -> None:
    if type(width) is not int or type(height) is not int:
        raise RuntimeError("incoming JPEG dimensions could not be verified")
    if width < 1 or height < 1 or width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE:
        raise RuntimeError("incoming JPEG dimensions exceed the safety limit")
    if width * height > MAX_IMAGE_PIXELS:
        raise RuntimeError("incoming JPEG pixel count exceeds the safety limit")


def _assert_bounded_grouping(items: List[GroupedItem]) -> None:
    if len(items) > MAX_INTAKE_FILES:
        raise RuntimeError("grouped intake exceeds the item safety limit")
    for item in items:
        photo_count = len(item.members) + (1 if item.marker is not None else 0)
        if photo_count > MAX_GROUP_PHOTOS:
            raise RuntimeError(
                f"grouped item exceeds the {MAX_GROUP_PHOTOS}-photo safety limit"
            )


def _photo_meta(p: DecodedPhoto, stored_path: str, thumb_path: Optional[str],
                sha: Optional[str], sort_order: int, is_marker: bool,
                include_in_listing: Optional[bool] = None) -> Dict:
    include = (not is_marker) if include_in_listing is None else include_in_listing
    return {
        "originalFilename": p.filename,
        "storedPath": stored_path,
        "thumbPath": thumb_path,
        "sha256": sha,
        "sortOrder": sort_order,
        "isCover": False,  # assigned after the loop (first LISTING photo wins)
        "isMarker": is_marker,
        "includeInListing": include,
        "rotation": 0,
        "decodedValue": _bounded_receipt_text(p.decoded_raw, 512),
        "decodeMethod": _bounded_receipt_text(p.decode_method, 128),
        "width": p.width,
        "height": p.height,
        "exifDateTimeOriginal": _bounded_receipt_text(p.exif_dto, 128),
        "exifSubSec": _bounded_receipt_text(p.exif_subsec, 128),
    }


def _allocate_shell_sku(existing: set, taken: set) -> str:
    """Short, unique, obviously-synthetic SKU for a shell item the operator will
    rename (FIX-0001, FIX-0002, ...). Unique across the DB and this batch."""
    n = 1
    while True:
        candidate = f"FIX-{n:04d}"
        if candidate not in existing and candidate not in taken:
            taken.add(candidate)
            return candidate
        n += 1


def _processing_target(
    sku: str,
    batch_id: str,
    processing_root: str,
    existing_skus: set,
    emitted_skus: set,
    collision_ordinals: Dict[str, int],
    *, create: bool,
) -> tuple[bool, str]:
    """Allocate a non-overlapping folder for one grouped item.

    The grouper deliberately retains repeated decoded SKUs so the operator can
    resolve an ambiguous marker instead of silently losing a group. Treat the
    first previously-unseen SKU as the new item and every later group as a
    collision. Existing inventory makes even the first incoming group a
    collision. Ordinal suffixes keep three-or-more same-SKU groups from
    overwriting each other's copied bytes before Node persists the result.
    """
    is_collision = sku in existing_skus or sku in emitted_skus
    emitted_skus.add(sku)
    if not is_collision:
        folder = sku
        prefix = f"{sku}__intake-{batch_id}-"
    else:
        ordinal = collision_ordinals.get(sku, 0) + 1
        collision_ordinals[sku] = ordinal
        folder = f"{sku}__incoming-{batch_id}"
        if ordinal > 1:
            folder += f"__{ordinal}"
        prefix = folder + "-"
    if not create:
        return is_collision, os.path.join(processing_root, folder)
    return is_collision, _reserve_processing_folder(processing_root, prefix)


def _reserve_processing_folder(processing_root: str, prefix: str) -> str:
    # A missing database row does not make a retained directory ours. Reserve
    # a fresh directory atomically after the mutation fence, including on resume.
    for _ in range(10):
        destination = os.path.join(processing_root, prefix + uuid4().hex)
        try:
            os.mkdir(destination)
            return destination
        except FileExistsError:
            continue
    raise RuntimeError("Could not reserve a new processing folder; existing photos were left untouched")


def _grouping_info(item: GroupedItem, order_source: str) -> Dict:
    reasons: List[str] = []
    for reason_value in item.reasons:
        reason = _bounded_receipt_text(reason_value, 1_024)
        if reason and reason not in reasons:
            reasons.append(reason)
        if len(reasons) >= 32:
            break

    log: List[Dict] = []
    for source in item.log:
        gap_value = source.get("gapBeforeSec")
        if isinstance(gap_value, (int, float)) and not isinstance(gap_value, bool):
            gap = float(gap_value)
            gap = max(-1_000_000_000.0, min(1_000_000_000.0, gap)) \
                if math.isfinite(gap) else None
        else:
            gap = None
        log.append({
            "file": source.get("file"),
            "role": _bounded_receipt_text(source.get("role"), 128) or "photo",
            "time": _bounded_receipt_text(source.get("time"), 128),
            "gapBeforeSec": gap,
            "decode": _bounded_receipt_text(source.get("decode"), 128),
            "raw": _bounded_receipt_text(source.get("raw"), 4_096),
        })

    return {
        "confidence": item.confidence,
        "reasons": reasons,
        "closedBy": item.closed_by,
        "orderSource": order_source,
        "log": log,
    }


def _assert_projected_result_budget(
    input_paths: List[str],
    items: List[GroupedItem],
    enrichments: Dict[int, Dict],
    problems: List[Dict],
    settings: Dict,
) -> None:
    """Conservatively prove the final one-line receipt fits before mutation.

    Six path-shaped strings cover the original, processing folder, stored
    photo, thumbnail, review/problem, and archive representations. The fixed
    per-input allowance covers all scalar/photo/grouping keys; model-derived
    JSON and actual grouping/problem structures are counted separately.
    """
    encoded = lambda value: len(json.dumps(
        value, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
    ).encode("utf-8"))
    projected = 1024 * 1024  # envelope, counts, timestamps, and failure headroom
    projected += encoded(list(enrichments.values()))
    projected += encoded([_grouping_info(item, "filename-mixed") for item in items])
    projected += encoded(problems)
    root_shapes = [
        str(settings.get(key) or "")
        for key in ("processingPath", "needsReviewPath", "archivePath")
    ]
    for source in input_paths:
        path_shape = max(encoded(source), *(encoded(root) + 512 for root in root_shapes))
        projected += path_shape * 6 + 8 * 1024
        if projected > MAX_PROJECTED_RESULT_BYTES:
            raise RuntimeError(
                "intake result would exceed the bounded worker IPC receipt"
            )


def _original_vision_metas(item: GroupedItem) -> List[Dict]:
    """Build the existing enricher shape from read-only incoming photo paths."""
    metas = [
        {"storedPath": member.path, "isMarker": False}
        for member in item.members
    ]
    if item.marker is not None:
        metas.append({"storedPath": item.marker.path, "isMarker": True})
    return metas


def _verify_source_identities(
    paths: List[str],
    expected_hashes: Dict[str, str],
    cancel_check: Callable[[], None],
) -> None:
    """Prove mutable incoming files still match the bytes admitted for work."""
    for source in paths:
        cancel_check()
        key = os.path.abspath(source)
        expected = expected_hashes.get(key)
        if not expected:
            raise RuntimeError("incoming photo identity is missing")
        observed = dedup.sha256_of_file(source, cancel_check=cancel_check)
        cancel_check()
        if observed != expected:
            raise RuntimeError("incoming photo changed during managed processing")


def _precompute_enrichments(
    items: List[GroupedItem],
    settings: Dict,
    batch_id: str,
    *,
    dry: bool,
    force_no_ai: bool,
    cancel_check: Callable[[], None],
    source_hashes: Dict[str, str],
) -> Dict[int, Dict]:
    """Finish all managed asks before the caller mutates intake files."""
    vision_enabled = bool(settings.get("visionEnabled", False)) and bool(
        settings.get(
            "visionFields", ["size", "color", "pattern", "itemType", "brand"]
        )
    )
    if dry or force_no_ai or not vision_enabled or not items:
        cancel_check()
        emit({"event": "admitted", "mode": "no-ai"})
        cancel_check()
        if force_no_ai and not dry:
            return {
                id(item): {"error": FORCE_SKIP_ERROR, "skipped": True}
                for item in items
            }
        return {id(item): {} for item in items}

    results: Dict[int, Dict] = {}
    cancel_check()
    with managed_vision_session(f"blackcat-intake:{batch_id}") as client:
        # Entry and the eager queue-boundary check succeeded. A deferral therefore
        # occurs before this admission event is visible to the parent.
        cancel_check()
        emit({"event": "admitted", "mode": "managed"})
        enricher = ManagedVisionEnricher(
            settings, client, cancel_check=cancel_check,
        )
        item_total = len(items)
        for item_i, item in enumerate(items, start=1):
            cancel_check()
            metas = _original_vision_metas(item)
            source_paths = [str(meta["storedPath"]) for meta in metas]
            _verify_source_identities(source_paths, source_hashes, cancel_check)
            emit({"event": "progress", "stage": "enrich", "sku": item.sku,
                  "i": item_i, "n": item_total})
            ask_started = time.time()
            # Read the clothing tags first so the model gets the actual printed
            # characters as evidence instead of squinting at a 40-pixel label.
            # This runs on the CPU while the GPU sits idle, and it never fails
            # the item: an unreadable tag just means no snippet.
            tag_reading = None
            try:
                tag_reading = tag_ocr.read_tags(
                    [str(meta["storedPath"]) for meta in metas if not meta.get("isMarker")],
                    settings,
                    cancel_check=cancel_check,
                )
            except (ManagedVisionCancelled, ManagedVisionDeferred):
                # A cancel or a deferral must unwind the whole session, not be
                # swallowed as "this item had no readable tag".
                raise
            except Exception:
                tag_reading = None
            enrichment = enricher.enrich(item.sku, metas, tag_reading=tag_reading)
            _verify_source_identities(source_paths, source_hashes, cancel_check)
            cancel_check()
            elapsed = round(time.time() - ask_started, 1)
            enrichment = validate_worker_enrichment(enrichment)
            results[id(item)] = enrichment
            assert_enrichment_batch_budget(results.values())
            if enrichment.get("error"):
                emit({"event": "progress", "stage": "enrich_done", "sku": item.sku,
                      "ok": False, "secs": elapsed,
                      "error": enrichment.get("error")})
            else:
                emit({"event": "progress", "stage": "enrich_done", "sku": item.sku,
                      "ok": True, "secs": elapsed,
                      "fields": list((enrichment.get("fields") or {}).keys())})

    # This runs only after ResidentSession.__exit__ has completed. A cancel racing
    # the final answer is discarded before any photo/file mutation.
    cancel_check()
    return results


def run(args, *, cancel_check: Optional[Callable[[], None]] = None) -> Dict:
    conn = dbmod.connect(config.db_path())
    try:
        if conn is None and not args.dry_run:
            raise dbmod.InventoryReadError("The inventory database is unavailable. Intake stopped before changing photos.")
        return _run(args, conn, cancel_check=cancel_check)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass  # Closing must not hide the original processing error.


def _run(args, conn, *, cancel_check: Optional[Callable[[], None]] = None) -> Dict:
    started = time.time()
    cancel_check = MutationCancellationFence(cancel_check or CancellationGuard())
    settings = config.load_settings(conn, require_database=not args.dry_run)
    existing_hashes = dbmod.existing_hashes(conn) if conn is not None else set()
    existing_skus = dbmod.existing_skus(conn) if conn is not None else set()
    incoming = args.incoming or settings["incomingPath"]
    work_roots = dict(settings)
    work_roots["incomingPath"] = incoming
    _validate_managed_work_roots(work_roots)
    dry = args.dry_run
    force_no_ai = _env_flag(FORCE_NO_AI_ENV)

    cancel_check()
    stability = float(settings.get("fileStabilitySeconds", 2))
    if dry:
        files, non_images = _list_incoming(incoming)
        _validate_incoming_workset(files + non_images, cancel_check)
    else:
        files, non_images = _settled_incoming(incoming, stability, cancel_check)

    problems: List[Dict] = []
    needs_review_out: List[Dict] = []

    # Record unsupported files now, but defer every move until after admission
    # and all managed asks have completed successfully.
    for f in non_images:
        problems.append({"type": "UNSUPPORTED_FORMAT", "photoPath": f,
                         "message": "Not a JPEG; routed to needs-review."})

    # The complete settled set keeps product photos and their end markers together.
    ready_files = files
    cancel_check()

    if not ready_files:
        emit({"event": "progress", "stage": "scan", "message": "no ready files"})
        cancel_check()
        emit({"event": "admitted", "mode": "no-ai"})
        cancel_check()
        if not dry:
            cancel_check()
            _assert_incoming_workset(incoming, files + non_images)
            cancel_check.seal()
            config.ensure_dirs(settings)
            for f in non_images:
                cancel_check()
                fileops.move_into(f, settings["needsReviewPath"])
        return _empty_result(started, problems)

    # Bind every mutable incoming photo to exact bytes before EXIF/OCR/grouping
    # or managed vision observes it. These hashes are reused for dedup after the
    # managed session, avoiding a second identity source.
    total_ready = len(ready_files)
    emit({"event": "progress", "stage": "scan", "total": total_ready})
    source_hashes: Dict[str, str] = {}
    hash_step = _progress_step(total_ready)
    for hashed_i, source in enumerate(ready_files, 1):
        cancel_check()
        source_hashes[os.path.abspath(source)] = dedup.sha256_of_file(
            source, cancel_check=cancel_check,
        )
        cancel_check()
        if hashed_i % hash_step == 0 or hashed_i == total_ready:
            emit({"event": "progress", "stage": "hash",
                  "done": hashed_i, "total": total_ready})

    # Build DecodedPhoto list with EXIF, then sort chronologically. order_photos
    # reports HOW the batch was ordered (pure EXIF vs filename fallback) — that
    # feeds each item's grouping-confidence report.
    photos: List[DecodedPhoto] = []
    exif_step = _progress_step(total_ready)
    for exif_i, f in enumerate(ready_files, 1):
        cancel_check()
        dto, subsec, w, h = get_exif(f)
        cancel_check()
        try:
            _assert_bounded_image_dimensions(w, h)
        except RuntimeError as error:
            raise RuntimeError(f"Photo {os.path.basename(f)!r}: {error}") from None
        dto = _bounded_receipt_text(dto, 128)
        subsec = _bounded_receipt_text(subsec, 128)
        photos.append(DecodedPhoto(path=f, filename=os.path.basename(f),
                                   exif_dto=dto, exif_subsec=subsec, width=w, height=h))
        if exif_i % exif_step == 0 or exif_i == total_ready:
            emit({"event": "progress", "stage": "exif",
                  "done": exif_i, "total": total_ready})
    cancel_check()
    order_source = order_photos(photos)
    cancel_check()
    if order_source != "exif":
        emit({"event": "progress", "stage": "sort", "orderSource": order_source})

    # Decode cascade (QR -> OCR).
    decoder = Decoder(settings)
    # Say it out loud BEFORE decoding anything. Every engine swallows its own
    # ImportError so a missing dependency degrades instead of crashing, which
    # means a broken install produces a batch with zero markers — visually
    # identical to a shoot where nobody photographed a sticker. The portable
    # interpreter shipped under worker/python has none of these installed, so
    # this is a real way to end up decoding nothing and never being told.
    engines = decoder.engine_status()
    if not engines["qr_opencv"]:
        problems.append({
            "type": "DECODE_ENGINE_UNAVAILABLE",
            "message": ("QR reading is unavailable — OpenCV (opencv-python) failed to "
                        "import in the worker interpreter, so no sticker can be decoded "
                        "or even located and every item will come back unmarked. "
                        "Reinstall the worker dependencies (npm run worker:setup)."),
        })
        emit({"event": "progress", "stage": "decode",
              "message": "QR engine unavailable — no stickers can be read"})
    else:
        missing = [name for name, key in (("pyzbar", "qr_pyzbar"), ("PaddleOCR", "ocr_paddle"))
                   if engines[key] is False]
        if missing:
            problems.append({
                "type": "DECODE_FALLBACK_UNAVAILABLE",
                "message": (f"Primary QR reading works, but {' and '.join(missing)} failed to "
                            "import, so stickers with a damaged or glare-hit code have no "
                            "second chance and will come back unreadable. Reinstall the "
                            "worker dependencies (npm run worker:setup)."),
            })
    total = len(photos)
    for i, p in enumerate(photos, 1):
        cancel_check()
        outcome = decoder.decode(p.path)
        cancel_check()
        p.sku = outcome.sku
        p.decoded_raw = _bounded_receipt_text(outcome.raw, 512)
        p.decode_method = _bounded_receipt_text(outcome.method, 128)
        p.qr_pattern_detected = outcome.qr_pattern_detected
        emit({"event": "progress", "stage": "decode", "done": i, "total": total,
              "file": p.filename, "sku": p.sku})

    cancel_check()
    grouping = group_photos(photos, order_source=order_source)
    cancel_check()
    _assert_bounded_grouping(grouping.items)
    for prob in grouping.problems:
        problems.append({"type": prob.type, "sku": prob.sku,
                         "photoPath": prob.photo_path, "message": prob.message})
    problems = _normalized_problem_receipts(problems)

    seen_hashes = set()
    duplicates: List[Dict] = []
    dupe_paths: List[str] = []          # skipped in-batch dupes — terminal, archived by the worker
    items_out: List[Dict] = []
    collisions_out: List[Dict] = []
    batch_id = time.strftime("%Y%m%d-%H%M%S")
    photos_processed = 0

    # Assign synthetic SKUs to placeholder shells (unreadable/missing stickers)
    # so they land in the app as fixable items instead of vanishing.
    shell_taken: set = set()
    shells = 0
    for item in grouping.items:
        if item.placeholder and not item.sku:
            item.sku = _allocate_shell_sku(existing_skus, shell_taken)
            shells += 1

    # Image-to-item matching summary (so the UI/log shows how grouping turned out).
    emit({"event": "progress", "stage": "group", "items": len(grouping.items),
          "shells": shells, "needsReview": len(grouping.needs_review),
          "problems": len(grouping.problems), "orderSource": order_source})

    # Stable originals have only been read so far. Precompute every AI result in
    # one serialized local-model session before any file mutation.
    enrichments = _precompute_enrichments(
        grouping.items, settings, batch_id,
        dry=dry, force_no_ai=force_no_ai, cancel_check=cancel_check,
        source_hashes=source_hashes,
    )
    # Model JSON must already satisfy the exact Node receipt schema, and the
    # aggregate must leave ample room below the 32 MiB one-line IPC boundary.
    # This proof runs before the first copy/move/thumbnail/log mutation.
    assert_enrichment_batch_budget(enrichments.values())
    _assert_projected_result_budget(
        ready_files + non_images,
        grouping.items,
        enrichments,
        problems,
        settings,
    )
    cancel_check()
    if not dry:
        # Analysis may take minutes. Recheck the current inventory before choosing
        # ordinary versus collision folders; failed reads still precede mutation.
        existing_hashes = dbmod.existing_hashes(conn)
        existing_skus = dbmod.existing_skus(conn)
        _assert_incoming_workset(incoming, files + non_images)
    _verify_source_identities(ready_files, source_hashes, cancel_check)

    if not dry:
        cancel_check()
        cancel_check.seal()
        config.ensure_dirs(settings)
        for f in non_images:
            cancel_check()
            fileops.move_into(f, settings["needsReviewPath"])

    # Legacy needs-review leftovers (shells replaced this; kept for safety).
    for p in grouping.needs_review:
        dest = p.path
        if not dry:
            cancel_check()
            dest = fileops.move_into(p.path, settings["needsReviewPath"])
        needs_review_out.append({"originalFilename": p.filename, "storedPath": dest,
                                 "reason": "unterminated_group"})

    # Per-batch grouping audit log — the exact why-these-photos-grouped record,
    # one JSON line per item (kept even on dry runs when a logs dir exists).
    grouping_log_path = None
    if settings.get("logsPath") and not dry:
        cancel_check()
    try:
        logs_dir = settings.get("logsPath")
        if logs_dir and not dry:
            os.makedirs(logs_dir, exist_ok=True)
            grouping_log_path = os.path.join(logs_dir, f"grouping-{batch_id}.jsonl")
    except Exception:
        grouping_log_path = None

    item_total = len(grouping.items)
    emitted_skus: set = set()
    collision_ordinals: Dict[str, int] = {}
    for item_i, item in enumerate(grouping.items, start=1):
        cancel_check()
        is_collision, proc_dir = _processing_target(
            item.sku,
            batch_id,
            settings["processingPath"],
            existing_skus,
            emitted_skus,
            collision_ordinals,
            create=not dry,
        )
        photo_metas: List[Dict] = []
        attached_paths: List[str] = []  # /incoming originals actually attached to this item
        idx = 1
        in_batch_dupes = 0
        reattached = 0
        for member in item.members:
            sha = None if dry else source_hashes.get(os.path.abspath(member.path))
            if not dry and not sha:
                raise RuntimeError("incoming photo identity is missing")
            photos_processed += 1
            # IN-BATCH duplicate guard ONLY: the exact same physical file dropped
            # twice in one /incoming dump must not attach to the item twice. We do
            # NOT skip on the cross-batch FileHash ledger here — a photo that belongs
            # to a NEWLY grouped item must ALWAYS be attached, or the item ends up
            # with no pictures (and vision has nothing to analyze). A whole item that
            # was already imported is caught by the SKU-collision path below, not by
            # silently dropping its photos. (This was the root cause of "items have
            # no photos / no AI data" after re-importing.)
            if sha is not None and sha in seen_hashes:
                duplicates.append({"originalFilename": member.filename, "sha256": sha})
                dupe_paths.append(member.path)
                in_batch_dupes += 1
                continue
            if sha is not None:
                if sha in existing_hashes:
                    reattached += 1  # seen in a prior import; we keep it anyway
                seen_hashes.add(sha)
            stored, thumb = member.path, None
            if not dry:
                cancel_check()
                name = fileops.clean_photo_name(item.sku, idx, member.path)
                stored = fileops.copy_into(member.path, os.path.join(proc_dir, name))
                cancel_check()
                thumb = _thumb(stored, proc_dir, name)
            attached_paths.append(member.path)
            photo_metas.append(_photo_meta(member, stored, thumb, sha, idx - 1, False,
                                           include_in_listing=not member.exclude_from_listing))
            idx += 1

        # Marker photo -> internal/, excluded from listing. A shell from an
        # unreadable sticker HAS a marker photo (the dead sticker shot); an
        # end-of-batch shell has none.
        marker = item.marker
        if marker is not None:
            photos_processed += 1
            msha = None if dry else source_hashes.get(os.path.abspath(marker.path))
            if not dry and not msha:
                raise RuntimeError("incoming marker identity is missing")
            mstored = marker.path
            if not dry:
                cancel_check()
                mname = f"{item.sku}_sku_marker{os.path.splitext(marker.path)[1].lower() or '.jpg'}"
                mstored = fileops.copy_into(marker.path, os.path.join(proc_dir, "internal", mname))
            marker_meta = _photo_meta(marker, mstored, None, msha, idx - 1, True)
            photo_metas.append(marker_meta)
            attached_paths.append(marker.path)

        # Cover = first photo that will actually appear in the listing.
        for meta in photo_metas:
            if meta["includeInListing"]:
                meta["isCover"] = True
                break

        listing_n = sum(1 for m in photo_metas if m["includeInListing"])
        emit({"event": "progress", "stage": "item", "sku": item.sku,
              "i": item_i, "n": item_total,
              "listingPhotos": listing_n, "inBatchDupes": in_batch_dupes,
              "reattached": reattached, "collision": is_collision,
              "confidence": item.confidence, "placeholder": item.placeholder})

        # Identity-bound result computed from stable originals before copying.
        enrichment = enrichments[id(item)]

        grouping_info = _grouping_info(item, order_source)
        record = {
            "sku": item.sku,
            "originalQrValue": _bounded_receipt_text(item.original_qr_value, 512),
            "processingFolderPath": proc_dir,
            "photos": photo_metas,
            "enrichment": enrichment,
            "grouping": grouping_info,
            "placeholder": item.placeholder,
            # Left in /incoming for Node to archive AFTER this item commits (resume-safe).
            "originalPaths": list(attached_paths),
        }
        if grouping_log_path:
            cancel_check()
            try:
                with open(grouping_log_path, "a", encoding="utf-8") as glf:
                    glf.write(json.dumps({"sku": item.sku, **grouping_info}) + "\n")
            except Exception:
                pass
        if is_collision:
            collisions_out.append(record)
        else:
            items_out.append(record)

    # Originals handling (full run only). ITEM + COLLISION originals are deliberately LEFT
    # in /incoming so Node archives them ONLY after each item's DB commit succeeds — a
    # crashed persist then leaves un-persisted originals in /incoming for a clean resume.
    # The worker archives only TERMINAL files here (skipped in-batch dupes) and routes any
    # ungrouped leftover to needs-review so nothing silently re-ingests.
    if not dry:
        archive_dir = os.path.join(settings["archivePath"], batch_id)
        deferred = set()  # item/collision originals Node will archive post-commit
        for rec in items_out + collisions_out:
            for ap in rec.get("originalPaths", []):
                deferred.add(os.path.abspath(ap))
        for d in dupe_paths:  # terminal: a skipped exact-duplicate file, no DB row to coordinate
            if os.path.exists(d):
                _safe_archive(
                    d, archive_dir, settings, problems,
                    cancel_check=cancel_check,
                )
        for f in ready_files:  # safety net for any ungrouped leftover
            if os.path.abspath(f) in deferred:
                continue
            if os.path.exists(f):
                cancel_check()
                try:
                    fileops.move_into(f, settings["needsReviewPath"])
                    problems.append({"type": "UNCLEAR_GROUP", "photoPath": f,
                                     "message": "ungrouped leftover routed to needs-review (not re-ingested)"})
                except Exception as e:
                    problems.append({"type": "UNREADABLE_FILE", "photoPath": f,
                                     "message": f"leftover move failed ({e}); remove from /incoming by hand"})

    problems = _normalized_problem_receipts(problems)
    duration_ms = _bounded_receipt_duration(started)
    return {
        "batchId": batch_id,
        "items": items_out,
        "collisions": collisions_out,
        "duplicates": duplicates,
        "needsReview": needs_review_out,
        "problems": problems,
        "counts": {
            "itemsCreated": len(items_out),
            "photosProcessed": photos_processed,
            "duplicatesSkipped": len(duplicates),
            "problems": len(problems),
            "collisions": len(collisions_out),
        },
        "durationMs": duration_ms,
    }


def _safe_archive(
    src: str,
    archive_dir: str,
    settings: Dict,
    problems: List[Dict],
    *,
    cancel_check: Callable[[], None],
) -> None:
    """Move a terminal original into /archive; on failure route it to needs-review so it is
    never lost AND never silently re-ingested."""
    cancel_check()
    try:
        fileops.move_into(src, archive_dir)
    except Exception as e:
        cancel_check()
        try:
            fileops.move_into(src, settings["needsReviewPath"])
            problems.append({"type": "UNREADABLE_FILE", "photoPath": src,
                             "message": f"archive failed ({e}); moved to needs-review"})
        except Exception as e2:
            problems.append({"type": "UNREADABLE_FILE", "photoPath": src,
                             "message": f"archive failed ({e}); needs-review also failed ({e2}); remove by hand"})


def _thumb(stored: str, proc_dir: str, name: str) -> Optional[str]:
    from .thumbnails import make_thumbnail
    return make_thumbnail(stored, os.path.join(proc_dir, "thumbs", name))


def _empty_result(started: float, problems: List[Dict]) -> Dict:
    problems = _normalized_problem_receipts(problems)
    return {
        "batchId": time.strftime("%Y%m%d-%H%M%S"),
        "items": [], "collisions": [], "duplicates": [], "needsReview": [],
        "problems": list(problems),
        "counts": {"itemsCreated": 0, "photosProcessed": 0, "duplicatesSkipped": 0,
                   "problems": len(problems), "collisions": 0},
        "durationMs": _bounded_receipt_duration(started),
    }


def _bounded_text(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _bounded_verdict(value: object) -> Dict:
    if not isinstance(value, dict):
        return {"status": "ambiguous"}
    status = value.get("status")
    bounded: Dict = {
        "status": status if status in {"busy", "ambiguous"} else "ambiguous",
    }
    attempts = value.get("attempts")
    if type(attempts) is int and 0 <= attempts <= 1_000_000:
        bounded["attempts"] = attempts
    elapsed_s = value.get("elapsed_s", value.get("elapsedSeconds"))
    if type(elapsed_s) in (int, float) and 0 <= elapsed_s <= 86_400:
        bounded["elapsedSeconds"] = round(float(elapsed_s), 3)
    return bounded


def main(argv=None) -> int:
    _configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Black Cat Agent intake worker")
    parser.add_argument("--incoming", default=None, help="override incoming dir")
    parser.add_argument("--dry-run", action="store_true",
                        help="decode + group only; no file ops or archive")
    args = parser.parse_args(argv)
    try:
        cancel_guard = CancellationGuard()
        result = run(args, cancel_check=cancel_guard)
        emit({"event": "result", "payload": result})
        return 0
    except ManagedVisionDeferred as exc:
        verdict = _bounded_verdict(exc.verdict)
        emit({
            "event": "deferred",
            "code": "VISION_DEFERRED",
            "kind": "generation_queue",
            "message": "managed vision queue " + verdict["status"],
            **verdict,
        })
        return 75
    except ManagedVisionCancelled as exc:
        emit({"event": "cancelled",
              "message": _bounded_text(exc, 240) or "intake cancellation requested"})
        return 130
    except Exception as e:  # never crash silently — report to the UI
        emit({"event": "error", "message": _bounded_text(e, 500)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
