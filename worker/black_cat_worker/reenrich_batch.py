"""Managed AI re-identification for one exact, bounded item batch.

The caller supplies stored photo paths only. Model identity, endpoint selection,
and llama.cpp lifecycle remain fixed and app-owned. All enrichments are retained
in memory until the managed session has restored its prior resident profile.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from typing import Callable, Dict, Iterable, List, Optional

from . import config, tag_ocr
from .photo_orientation import validate_rotation
from .exif_sort import get_exif
from .managed_vision import (
    ManagedVisionCancelled,
    ManagedVisionDeferred,
    ManagedVisionEnricher,
    assert_enrichment_batch_budget,
    managed_vision_session,
    validate_worker_enrichment,
)
from .process import CancellationGuard


_MAX_ITEMS = 500
# Stored inventory can legitimately contain dozens of photos. The enricher
# deterministically selects visionMaxPhotos from these paths before encoding.
_MAX_PHOTOS_PER_ITEM = 32
_MAX_SPEC_BYTES = 8 * 1024 * 1024
_MAX_IMAGE_FILE_BYTES = 256 * 1024 * 1024
_MAX_BATCH_IMAGE_BYTES = 16 * 1024 * 1024 * 1024
_MAX_IMAGE_SIDE = 20_000
_MAX_IMAGE_PIXELS = 100_000_000
_URL_RE = re.compile(r"(?i)\b(?:https?://|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)[^\s,;]*")
_PROBE_IMAGE = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "/x8AAusB9Y9Z4JkAAAAASUVORK5CYII="
)


def emit(event: Dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _safe_text(value: object, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    text = _URL_RE.sub("[managed endpoint]", text)
    return text[:limit]


def _deferral_payload(exc: ManagedVisionDeferred) -> Dict:
    verdict = exc.verdict if isinstance(exc.verdict, dict) else {}
    raw_status = str(verdict.get("status") or "").strip().lower()
    status = raw_status if raw_status in {"busy", "ambiguous"} else "busy"
    payload: Dict = {
        "event": "deferred",
        "code": "VISION_DEFERRED",
        "status": status,
        "message": _safe_text(exc) or "managed vision is busy",
    }
    attempts = verdict.get("attempts")
    if type(attempts) is int and 0 <= attempts <= 1000:
        payload["attempts"] = attempts
    elapsed = verdict.get(
        "elapsedSeconds", verdict.get("elapsed_seconds", verdict.get("elapsed_s"))
    )
    if type(elapsed) in (int, float) and 0 <= float(elapsed) <= 3600:
        payload["elapsedSeconds"] = round(float(elapsed), 3)
    detail = verdict.get("detail")
    if isinstance(detail, str) and detail.strip():
        payload["detail"] = _safe_text(detail)
    return payload


def _validate_photo(raw: object) -> Dict:
    required = {"photoId", "storedPath", "isMarker", "sha256"}
    if not isinstance(raw, dict) or not required <= set(raw) or set(raw) - required - {"rotation"}:
        raise ValueError(
            "each photo must contain photoId, storedPath, isMarker, sha256, and optional rotation only"
        )
    photo_id = raw.get("photoId")
    stored_path = raw.get("storedPath")
    is_marker = raw.get("isMarker", False)
    expected_hash = raw.get("sha256")
    if "rotation" in raw:
        validate_rotation(raw["rotation"])
    if type(photo_id) is not int or photo_id <= 0:
        raise ValueError("photoId must be a positive integer")
    if (
        not isinstance(stored_path, str)
        or not stored_path.strip()
        or len(stored_path) > 4096
        or not os.path.isabs(stored_path)
    ):
        raise ValueError("photo storedPath must be a bounded absolute path")
    if type(is_marker) is not bool:
        raise ValueError("photo isMarker must be boolean")
    if (
        not isinstance(expected_hash, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash)
    ):
        raise ValueError("photo sha256 must be a 64-character hex digest")
    return {
        "photoId": photo_id,
        "storedPath": stored_path,
        "isMarker": is_marker,
        "sha256": expected_hash.lower(),
        **({"rotation": raw["rotation"]} if "rotation" in raw else {}),
    }


def validate_batch_spec(raw: object) -> List[Dict]:
    if not isinstance(raw, dict) or set(raw) != {"items"}:
        raise ValueError("batch spec must contain only items")
    items = raw.get("items")
    if not isinstance(items, list) or not (1 <= len(items) <= _MAX_ITEMS):
        raise ValueError(f"items must contain between 1 and {_MAX_ITEMS} entries")
    result: List[Dict] = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"requestId", "sku", "photos"}:
            raise ValueError("each item must contain requestId, sku, and photos only")
        request_id = item.get("requestId")
        sku = item.get("sku")
        photos = item.get("photos")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            raise ValueError("requestId must be a non-empty string of at most 128 characters")
        if request_id in seen:
            raise ValueError("requestId values must be unique")
        if not isinstance(sku, str) or len(sku) > 128:
            raise ValueError("sku must be a string of at most 128 characters")
        if not isinstance(photos, list) or len(photos) > _MAX_PHOTOS_PER_ITEM:
            raise ValueError(f"photos must be a list of at most {_MAX_PHOTOS_PER_ITEM}")
        seen.add(request_id)
        normalized_photos = [_validate_photo(photo) for photo in photos]
        if not any(not photo["isMarker"] for photo in normalized_photos):
            raise ValueError("each item needs at least one non-marker listing photo")
        result.append({
            "requestId": request_id,
            "sku": sku,
            "photos": normalized_photos,
        })
    return result


def _verify_photo_identities(
    items: Iterable[Dict],
    cancel_check: Callable[[], None],
    settings: Dict,
) -> None:
    configured_root = settings.get("processingPath")
    if not isinstance(configured_root, str) or not os.path.isabs(configured_root):
        raise RuntimeError("managed processing root must be an absolute directory")
    try:
        root_info = os.stat(configured_root)
    except OSError as exc:
        raise RuntimeError("managed processing root is unavailable") from exc
    if not stat.S_ISDIR(root_info.st_mode):
        raise RuntimeError("managed processing root is not a directory")
    root_real = os.path.normcase(os.path.realpath(configured_root))

    seen_ids = set()
    seen_paths = set()
    total_bytes = 0
    for item in items:
        for photo in item["photos"]:
            cancel_check()
            photo_id = photo["photoId"]
            source = photo["storedPath"]
            if os.path.islink(source):
                raise RuntimeError("stored photo is a linked path")
            stored_path = os.path.normcase(os.path.realpath(source))
            try:
                relative = os.path.relpath(stored_path, root_real)
            except ValueError as exc:
                raise RuntimeError("stored photo is outside the managed processing root") from exc
            if (
                relative in {"", ".."}
                or relative.startswith(".." + os.sep)
                or os.path.isabs(relative)
            ):
                raise RuntimeError("stored photo is outside the managed processing root")
            if photo_id in seen_ids or stored_path in seen_paths:
                raise RuntimeError("stored photo identity is duplicated")
            seen_ids.add(photo_id)
            seen_paths.add(stored_path)
            try:
                before = os.stat(source, follow_symlinks=False)
            except (OSError, TypeError) as exc:
                raise RuntimeError("stored photo is unavailable") from exc
            if not stat.S_ISREG(before.st_mode):
                raise RuntimeError("stored photo is not a regular file")
            if before.st_size < 0 or before.st_size > _MAX_IMAGE_FILE_BYTES:
                raise RuntimeError("stored photo exceeds the per-file safety limit")
            total_bytes += int(before.st_size)
            if total_bytes > _MAX_BATCH_IMAGE_BYTES:
                raise RuntimeError("stored photo batch exceeds the aggregate byte limit")
            _dto, _subsec, width, height = get_exif(source)
            if type(width) is not int or type(height) is not int:
                raise RuntimeError("stored photo dimensions could not be verified")
            if (
                width < 1 or height < 1
                or width > _MAX_IMAGE_SIDE or height > _MAX_IMAGE_SIDE
                or width * height > _MAX_IMAGE_PIXELS
            ):
                raise RuntimeError("stored photo dimensions exceed the safety limit")
            digest = hashlib.sha256()
            with open(source, "rb") as handle:
                opened = os.fstat(handle.fileno())
                if not stat.S_ISREG(opened.st_mode):
                    raise RuntimeError("stored photo is not a regular file")
                while True:
                    block = handle.read(1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                    cancel_check()
            if digest.hexdigest() != photo["sha256"]:
                raise RuntimeError("stored photo changed during managed re-identification")
            try:
                after = os.stat(source, follow_symlinks=False)
            except (OSError, TypeError) as exc:
                raise RuntimeError("stored photo changed during managed re-identification") from exc
            if (
                os.path.normcase(os.path.realpath(source)) != stored_path
                or (before.st_dev, before.st_ino, before.st_size)
                != (after.st_dev, after.st_ino, after.st_size)
            ):
                raise RuntimeError("stored photo changed during managed re-identification")
            cancel_check()


def run_batch(
    items: Iterable[Dict],
    *,
    settings: Optional[Dict] = None,
    cancel_check: Optional[Callable[[], None]] = None,
    session_factory=managed_vision_session,
    enricher_factory=ManagedVisionEnricher,
) -> Dict:
    """Return the batch payload only after managed-session exit succeeds."""
    materialized = list(items)
    settings = dict(settings or config.load_settings())
    cancel_check = cancel_check or CancellationGuard()
    pending: List[Dict] = []
    cancel_check()
    _verify_photo_identities(materialized, cancel_check, settings)
    with session_factory(f"blackcat-reidentify:{len(materialized)}") as client:
        cancel_check()
        _verify_photo_identities(materialized, cancel_check, settings)
        enricher = enricher_factory(settings, client, cancel_check=cancel_check)
        for item in materialized:
            cancel_check()
            _verify_photo_identities([item], cancel_check, settings)
            tag_reading = None
            if settings.get("visionEnabled", False) and settings.get("tagOcrEnabled", True):
                try:
                    rotations = {photo["storedPath"]: photo["rotation"] for photo in item["photos"]
                                 if not photo["isMarker"] and photo.get("rotation", 0)}
                    tag_reading = tag_ocr.read_tags(
                        [photo["storedPath"] for photo in item["photos"] if not photo["isMarker"]],
                        settings, cancel_check=cancel_check,
                        **({"rotations": rotations} if rotations else {}),
                    )
                except (ManagedVisionCancelled, ManagedVisionDeferred):
                    raise
                except Exception:
                    # Match intake: unavailable tag OCR must not lose the item.
                    tag_reading = None
            cancel_check()
            _verify_photo_identities([item], cancel_check, settings)
            enrichment = validate_worker_enrichment(
                enricher.enrich(item["sku"], item["photos"], tag_reading=tag_reading)
            )
            _verify_photo_identities([item], cancel_check, settings)
            cancel_check()
            pending.append({
                "requestId": item["requestId"],
                "enrichment": enrichment,
            })
            assert_enrichment_batch_budget(
                row["enrichment"] for row in pending
            )
    # A restore failure raises from __exit__, so nothing below can be published.
    cancel_check()
    _verify_photo_identities(materialized, cancel_check, settings)
    return {"items": pending}


def run_probe(
    *,
    settings: Optional[Dict] = None,
    cancel_check: Optional[Callable[[], None]] = None,
    session_factory=managed_vision_session,
) -> Dict:
    """Make one bounded image ask and publish no model/transport identity."""
    settings = dict(settings or config.load_settings())
    cancel_check = cancel_check or CancellationGuard()
    timeout = max(1, min(int(settings.get("visionTimeoutSeconds", 120)), 180))
    cancel_check()
    with session_factory("blackcat-vision-probe") as client:
        cancel_check()
        text, meta = client.ask(
            [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Inspect this synthetic image. Return exactly the four ASCII characters READY and nothing else."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_PROBE_IMAGE}"}},
                ],
            }],
            max_tokens=16,
            temperature=0.0,
            timeout_s=timeout,
        )
        cancel_check()
        if not isinstance(text, str) or text.strip() != "READY":
            raise RuntimeError("managed vision probe returned an invalid final answer")
        if not isinstance(meta, dict) or not isinstance(meta.get("model"), str) or not meta["model"].strip():
            raise RuntimeError("managed vision probe returned invalid response metadata")
        if meta.get("response_model") != meta["model"]:
            raise RuntimeError("managed vision probe returned mismatched response identity")
        if not isinstance(meta.get("usage"), dict) or meta.get("finish_reason") != "stop":
            raise RuntimeError("managed vision probe returned incomplete response metadata")
        model = meta["model"].strip()
    cancel_check()
    return {"ok": True, "model": model, "responseModel": model}


def _read_json(path: str) -> object:
    with open(path, "r", encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_SPEC_BYTES:
            raise ValueError("batch spec is not a bounded regular file")
        return json.load(handle)


def _terminal_error(exc: BaseException) -> int:
    if isinstance(exc, ManagedVisionDeferred):
        emit(_deferral_payload(exc))
        return 75
    if isinstance(exc, ManagedVisionCancelled):
        emit({
            "event": "cancelled",
            "code": "VISION_CANCELLED",
            "message": _safe_text(exc) or "managed vision cancelled",
        })
        return 130
    emit({"event": "error", "message": _safe_text(exc, 500) or "managed vision failed"})
    return 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="managed Black Cat AI re-identification")
    parser.add_argument("spec", nargs="?")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.probe:
            if args.spec:
                raise ValueError("--probe does not accept a spec file")
            payload = run_probe()
        else:
            if not args.spec:
                raise ValueError("a batch spec file is required")
            items = validate_batch_spec(_read_json(args.spec))
            payload = run_batch(items)
        emit({"event": "result", "payload": payload})
        return 0
    except BaseException as exc:
        return _terminal_error(exc)


if __name__ == "__main__":
    raise SystemExit(main())
