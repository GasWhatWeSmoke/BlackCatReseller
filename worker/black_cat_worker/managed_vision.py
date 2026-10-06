"""Fixed local llama.cpp vision transport for Black Cat Reseller.

The desktop runtime owns the local llama.cpp process.  Python only serializes
bounded requests to its fixed loopback endpoint and holds one cross-process
session lock for each logical intake/re-identification batch.  Callers cannot
select a model, endpoint, or process lifecycle through this module.
"""
from __future__ import annotations

import contextlib
import contextvars
import errno
import json
import math
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional

from . import evidence
from . import props
from . import tag_ocr
from . import vision
from .photo_orientation import validate_rotation


VISION_API_URL = "http://127.0.0.1:1235/v1/chat/completions"
VISION_MODEL_ALIAS = "blackcat-vision"
MAX_VISION_PHOTOS = 4
MAX_VISION_OUTPUT_TOKENS = 1800
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_SESSION_LOCK_PATH = _PROJECT_ROOT / ".local" / "vision" / "run" / "session.lock"
_MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_TIMING_VALUE = 1_000_000_000_000
_LLAMA_TIMING_FIELDS = (
    "cache_n",
    "prompt_n",
    "prompt_ms",
    "prompt_per_token_ms",
    "prompt_per_second",
    "predicted_n",
    "predicted_ms",
    "predicted_per_token_ms",
    "predicted_per_second",
    "draft_n",
    "draft_n_accepted",
)
_ACTIVE_CLIENT: contextvars.ContextVar["ManagedVisionClient | None"] = (
    contextvars.ContextVar("blackcat_managed_vision_client", default=None)
)


class ManagedVisionDeferred(RuntimeError):
    """Another local process owns the bounded vision session."""

    def __init__(self, message: str, *, verdict: object = None) -> None:
        super().__init__(message)
        self.verdict = verdict


class ManagedVisionCancelled(RuntimeError):
    """The parent requested cancellation at a safe local-session checkpoint."""


class ManagedVisionAnswerError(RuntimeError):
    """The local model returned no usable final answer; this item may retry once."""

    def __init__(self, message: str, *, metadata: Optional[Dict] = None) -> None:
        super().__init__(message)
        self.metadata = dict(metadata or {})


_ITEM_FIELD_NAMES = frozenset({
    "size", "color", "pattern", "itemType", "category", "brand",
})
_MAX_RAW_DEPTH = 8
_MAX_RAW_NODES = 4_096
_MAX_RAW_CHARS = 65_536
# Keep model-derived data well below the 32 MiB one-line IPC ceiling. The
# remaining envelope contains source/stored paths, grouping receipts, and
# bounded problems for at most 1,000 photos.
MAX_ENRICHMENT_BATCH_JSON_BYTES = 8 * 1024 * 1024


def _schema_error() -> ManagedVisionAnswerError:
    return ManagedVisionAnswerError(
        "managed vision returned an invalid enrichment schema"
    )


def _utf16_length(value: str) -> int:
    """Match JavaScript String.length for the mirrored Node receipt schema."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _bounded_schema_string(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or _utf16_length(value) > maximum
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise _schema_error()
    return value


def _validate_raw_json(value: object) -> object:
    nodes = 0
    chars = 0

    def visit(candidate: object, depth: int) -> object:
        nonlocal nodes, chars
        nodes += 1
        if nodes > _MAX_RAW_NODES or depth > _MAX_RAW_DEPTH:
            raise _schema_error()
        if candidate is None or type(candidate) is bool:
            return candidate
        if isinstance(candidate, str):
            candidate_units = _utf16_length(candidate)
            if candidate_units > _MAX_RAW_CHARS or any(
                ord(char) < 32 and char not in "\t\n\r" or ord(char) == 127
                for char in candidate
            ):
                raise _schema_error()
            chars += candidate_units
            if chars > _MAX_RAW_CHARS:
                raise _schema_error()
            return candidate
        if type(candidate) in (int, float):
            number = float(candidate)
            if not math.isfinite(number) or not -1_000_000_000_000 <= number <= 1_000_000_000_000:
                raise _schema_error()
            return candidate
        if isinstance(candidate, list):
            if len(candidate) > 512:
                raise _schema_error()
            return [visit(entry, depth + 1) for entry in candidate]
        if isinstance(candidate, dict):
            if len(candidate) > 128:
                raise _schema_error()
            result: Dict = {}
            for key, entry in candidate.items():
                if (
                    not isinstance(key, str)
                    or not key
                    or _utf16_length(key) > 128
                    or key in {"__proto__", "prototype", "constructor"}
                    or any(ord(char) < 32 or ord(char) == 127 for char in key)
                ):
                    raise _schema_error()
                chars += _utf16_length(key)
                if chars > _MAX_RAW_CHARS:
                    raise _schema_error()
                result[key] = visit(entry, depth + 1)
            return result
        raise _schema_error()

    return visit(value, 0)


def validate_worker_enrichment(value: object) -> Dict:
    """Mirror the Node IPC enrichment contract before any file mutation."""
    if not isinstance(value, dict) or any(
        key not in {"fields", "aiFields", "raw", "error", "skipped", "intentional"}
        for key in value
    ):
        raise _schema_error()
    result: Dict = {}
    if "fields" in value:
        fields = value["fields"]
        if not isinstance(fields, dict) or any(
            key not in _ITEM_FIELD_NAMES for key in fields
        ):
            raise _schema_error()
        result["fields"] = {
            key: _bounded_schema_string(field_value, 512)
            for key, field_value in fields.items()
        }
    if "aiFields" in value:
        ai_fields = value["aiFields"]
        if not isinstance(ai_fields, list) or len(ai_fields) > len(_ITEM_FIELD_NAMES):
            raise _schema_error()
        normalized = [_bounded_schema_string(field, 32) for field in ai_fields]
        if (
            len(set(normalized)) != len(normalized)
            or any(field not in _ITEM_FIELD_NAMES for field in normalized)
            or "fields" not in result
            or any(field not in result["fields"] for field in normalized)
        ):
            raise _schema_error()
        result["aiFields"] = normalized
    if "raw" in value:
        result["raw"] = _validate_raw_json(value["raw"])
    if "error" in value:
        result["error"] = _bounded_schema_string(value["error"], 2_048)
    for flag in ("skipped", "intentional"):
        if flag in value:
            if value[flag] is not True:
                raise _schema_error()
            result[flag] = True
    if result.get("intentional") and not result.get("skipped"):
        raise _schema_error()
    if result.get("skipped") and (
        "error" not in result or "fields" in result or "raw" in result
    ):
        raise _schema_error()
    return result


def assert_enrichment_batch_budget(values) -> None:
    """Bound aggregate model-derived IPC before callers mutate or publish."""
    normalized = [validate_worker_enrichment(value) for value in values]
    encoded = json.dumps(
        normalized, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
    ).encode("utf-8")
    if len(encoded) > MAX_ENRICHMENT_BATCH_JSON_BYTES:
        raise RuntimeError("managed vision enrichment batch exceeds the IPC safety limit")


def _bounded_answer_metadata(raw: object) -> Dict:
    """Project bounded diagnostics and the locally verified response identity."""
    if not isinstance(raw, dict):
        return {}
    result: Dict = {}
    usage = raw.get("usage")
    if isinstance(usage, dict):
        result["usage"] = {
            key: value for key, value in usage.items()
            if key in {"prompt_tokens", "completion_tokens", "total_tokens"}
            and type(value) is int and 0 <= value <= 1_000_000
        }
    timings = raw.get("timings")
    if isinstance(timings, dict):
        bounded_timings = {}
        for key in _LLAMA_TIMING_FIELDS:
            value = timings.get(key)
            if (
                type(value) in (int, float)
                and 0 <= value <= _MAX_TIMING_VALUE
                and (type(value) is int or math.isfinite(value))
            ):
                bounded_timings[key] = value
        if bounded_timings:
            result["timings"] = bounded_timings
    finish = raw.get("finish_reason")
    if isinstance(finish, str):
        result["finish_reason"] = " ".join(finish.split())[:64]
    model = raw.get("model")
    response_model = raw.get("response_model", model)
    if isinstance(model, str) and isinstance(response_model, str):
        model = " ".join(model.split())[:240]
        response_model = " ".join(response_model.split())[:240]
        if model and response_model == model:
            # ManagedVisionClient has already asserted requested == response
            # identity. Re-export only that receipt, never the endpoint.
            result["model"] = model
            result["response_model"] = response_model
    reasoning_chars = raw.get("reasoning_chars")
    if type(reasoning_chars) is int and 0 <= reasoning_chars <= 10_000_000:
        result["reasoning_chars"] = reasoning_chars
    reasoning_chars_capped = raw.get("reasoning_chars_capped")
    if type(reasoning_chars_capped) is bool:
        result["reasoning_chars_capped"] = reasoning_chars_capped
    return result


def _reasoning_chars(message: Dict, choice: Dict) -> int:
    """Count reasoning without copying model text into logs or IPC receipts."""
    total = 0
    for candidate in (
        message.get("reasoning_content"), message.get("reasoning"),
        choice.get("reasoning_content"), choice.get("reasoning"),
    ):
        if isinstance(candidate, str):
            total += len(candidate)
    return min(total, 10_000_000)


def _lock_file(handle) -> None:
    """Take a non-blocking, one-byte OS lock on Windows or POSIX."""
    handle.seek(0)
    if os.name == "nt":
        import msvcrt  # Windows-only standard library module.

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return
    import fcntl  # POSIX fallback keeps the worker tests portable.

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def _session_file_lock(lock_path: Optional[Path] = None):
    """Hold the local vision lane across one complete logical batch."""
    path = _session_lock_path() if lock_path is None else Path(lock_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b", buffering=0)
    acquired = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
        try:
            _lock_file(handle)
            acquired = True
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            raise ManagedVisionDeferred(
                "local vision session is busy",
                verdict={"status": "busy", "detail": "local vision session lock is held"},
            ) from exc
        yield
    finally:
        if acquired:
            try:
                _unlock_file(handle)
            except OSError:
                # Closing the handle also releases the OS lock. Never hide an
                # inference/cancellation exception with cleanup noise.
                pass
        handle.close()


def _session_lock_path() -> Path:
    if os.environ.get("BLACKCAT_VISION_ROOT", "").strip():
        return vision.local_vision_asset_root() / "run" / "session.lock"
    return _SESSION_LOCK_PATH


class ManagedVisionClient:
    """Narrow fixed-loopback client with no model or URL override."""

    __slots__ = ("_opener",)

    def __init__(self, *, opener=None) -> None:
        self._opener = opener or vision._build_local_vision_opener().open

    def ask(
        self,
        messages: List[Dict],
        *,
        max_tokens: int,
        temperature: float,
        timeout_s: int,
    ) -> tuple[str, Dict]:
        if type(max_tokens) is not int or not 1 <= max_tokens <= MAX_VISION_OUTPUT_TOKENS:
            raise ValueError(
                f"max_tokens must be an integer from 1 to {MAX_VISION_OUTPUT_TOKENS}"
            )
        if (
            type(temperature) not in (int, float)
            or not math.isfinite(float(temperature))
            or not 0 <= float(temperature) <= 2
        ):
            raise ValueError("temperature must be a finite number from 0 to 2")
        if type(timeout_s) is not int or not 1 <= timeout_s <= 900:
            raise ValueError("timeout_s must be an integer from 1 to 900")
        payload = {
            "model": VISION_MODEL_ALIAS,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": float(temperature),
            "stream": False,
        }
        try:
            body = json.dumps(
                payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise ValueError("local vision request is not JSON serializable") from exc
        request = urllib.request.Request(
            VISION_API_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {vision._read_local_vision_api_key()}",
            },
            method="POST",
        )
        response = None
        try:
            response = self._opener(request, timeout=timeout_s)
            raw = response.read(_MAX_HTTP_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"local vision server rejected the request (HTTP {exc.code})"
            ) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            raise RuntimeError("local vision server is unavailable") from exc
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
        if len(raw) > _MAX_HTTP_RESPONSE_BYTES:
            raise ManagedVisionAnswerError("local vision response exceeded the safety limit")
        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ManagedVisionAnswerError("local vision returned a malformed response") from exc
        if not isinstance(envelope, dict):
            raise ManagedVisionAnswerError("local vision returned an invalid response envelope")

        response_model = envelope.get("model")
        if response_model != VISION_MODEL_ALIAS:
            # A different identity means the fixed port is serving the wrong
            # process/model. This is a hard batch failure, never a soft item miss.
            raise RuntimeError("local vision response model did not match blackcat-vision")
        choices = envelope.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ManagedVisionAnswerError("local vision returned no completion choice")
        choice = choices[0]
        message = choice.get("message")
        if not isinstance(message, dict):
            raise ManagedVisionAnswerError("local vision returned no final message")
        finish_reason = choice.get("finish_reason")
        reasoning_chars = _reasoning_chars(message, choice)
        metadata = _bounded_answer_metadata({
            "model": VISION_MODEL_ALIAS,
            "response_model": response_model,
            "finish_reason": finish_reason,
            "usage": envelope.get("usage") if isinstance(envelope.get("usage"), dict) else {},
            "timings": envelope.get("timings") if isinstance(envelope.get("timings"), dict) else {},
            "reasoning_chars": reasoning_chars,
            "reasoning_chars_capped": reasoning_chars == 10_000_000,
        })
        content = message.get("content")
        if finish_reason != "stop":
            detail = "local vision response was truncated" if finish_reason == "length" \
                else "local vision response did not finish cleanly"
            raise ManagedVisionAnswerError(detail, metadata=metadata)
        if not isinstance(content, str) or not content.strip():
            detail = "local vision returned reasoning without a final answer" \
                if reasoning_chars else "local vision returned no final answer"
            raise ManagedVisionAnswerError(detail, metadata=metadata)
        if len(content) > _MAX_RAW_CHARS:
            raise ManagedVisionAnswerError(
                "local vision final answer exceeded the safety limit", metadata=metadata,
            )
        return content, metadata


@contextlib.contextmanager
def managed_vision_session(
    label: str,
    *,
    _client_factory=ManagedVisionClient,
    _lock_path: Optional[Path] = None,
) -> Iterator[ManagedVisionClient]:
    """Admit one fixed local vision session for one bounded logical batch."""
    del label  # Retained for stable call sites and diagnostics at higher layers.
    existing = _ACTIVE_CLIENT.get()
    if existing is not None:
        yield existing
        return
    lock_path = _session_lock_path() if _lock_path is None else Path(_lock_path)
    with _session_file_lock(lock_path):
        client = _client_factory()
        token = _ACTIVE_CLIENT.set(client)
        try:
            yield client
        finally:
            _ACTIVE_CLIENT.reset(token)


class ManagedVisionEnricher:
    """Vision parser/mapper using only a previously admitted local client.

    Invalid or empty model answers retain the historical one-item retry and
    fail-soft result. Cancellation, lock deferral, transport, and model identity
    failures are intentionally not caught here; they unwind the whole locked
    session before any result can be published.
    """

    __slots__ = (
        "enabled", "max_photos", "fields", "timeout", "max_tokens", "_cv2",
        "_managed_client", "_cancel_check", "last_meta",
    )

    def __init__(
        self,
        settings: Dict,
        client: ManagedVisionClient,
        cancel_check: Optional[Callable[[], None]] = None,
    ) -> None:
        # Keep only bounded behavior from the historical parser. In particular,
        # do not materialize its URL/model fields or inherit its raw HTTP call.
        self.enabled = bool(settings.get("visionEnabled", False))
        self.max_photos = int(settings.get("visionMaxPhotos", 4))
        self.fields = set(settings.get(
            "visionFields", ["size", "color", "pattern", "itemType", "brand"]
        ))
        self.timeout = float(settings.get("visionTimeoutSeconds", 120))
        self.max_tokens = int(settings.get("visionMaxTokens", 1800))
        self._cv2 = None
        self._managed_client = client
        self._cancel_check = cancel_check or (lambda: None)
        self.last_meta: Dict = {}

    # Reuse the proven image selection/encoding and field mapping implementations
    # without inheriting the legacy endpoint transport surface.
    def _ensure_cv2(self):
        return vision.VisionEnricher._ensure_cv2(self)

    def _pick_images(self, photo_metas: List[Dict]) -> List[str]:
        listing = [
            photo for photo in photo_metas
            if not photo.get("isMarker") and photo.get("storedPath")
        ]
        limit = self.max_photos
        if limit < 1 or limit > MAX_VISION_PHOTOS:
            raise ValueError(
                f"visionMaxPhotos must be between 1 and {MAX_VISION_PHOTOS}"
            )
        if len(listing) <= limit:
            chosen = listing
        elif limit == 1:
            chosen = [listing[0]]
        else:
            count = len(listing)
            indices = sorted({
                round(index * (count - 1) / (limit - 1))
                for index in range(limit)
            })
            chosen = [listing[index] for index in indices]
        return [str(photo["storedPath"]) for photo in chosen]

    def _encode(self, path: str, max_side: int = 1024, rotation: int = 0) -> Optional[str]:
        return vision.VisionEnricher._encode(self, path, max_side=max_side, rotation=rotation)

    def _map_fields(self, parsed: Dict):
        return vision.VisionEnricher._map_fields(self, parsed)

    def _call(self, images_b64: List[str], tag_snippet: Optional[str] = None) -> str:
        prompt = vision._PROMPT
        if tag_snippet:
            # OCR evidence goes AFTER the instructions so it reads as data about
            # this item rather than as further instructions. It is explicitly
            # framed as fallible: PaddleOCR read "BrooksiBrathers" off a real
            # Brooks Brothers tag, which is a useful clue and a wrong string.
            prompt = f"{prompt}\n\n{tag_snippet}"
        content = [{"type": "text", "text": prompt}]
        content.extend({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
        } for encoded in images_b64)
        text, meta = self._managed_client.ask(
            [{"role": "user", "content": content}],
            max_tokens=self.max_tokens,
            temperature=0.0,
            timeout_s=max(1, int(self.timeout)),
        )
        self.last_meta = dict(meta or {})
        return text

    def enrich(self, sku: str, photo_metas: List[Dict], tag_reading=None) -> Dict:
        del sku  # Kept for parity with the existing enricher/public worker API.
        if not self.enabled or not self.fields:
            return validate_worker_enrichment({})
        paths = self._pick_images(photo_metas)
        rotations = {str(photo["storedPath"]): validate_rotation(photo.get("rotation", 0))
                     for photo in photo_metas if photo.get("storedPath")}
        if not paths:
            return validate_worker_enrichment({"error": "no listing photos to analyze"})
        images = []
        for path in paths:
            self._cancel_check()
            rotation = rotations.get(path, 0)
            encoded = self._encode(path, rotation=rotation) if rotation else self._encode(path)
            self._cancel_check()
            if encoded:
                images.append(encoded)
        if not images:
            return validate_worker_enrichment({
                "error": "photos could not be read/encoded for analysis",
            })

        tag_snippet = ""
        tag_payload: Optional[Dict] = None
        if tag_reading is not None:
            try:
                tag_snippet = tag_ocr.prompt_snippet(tag_reading)
                tag_payload = tag_reading.to_json()
            except Exception:
                # Tag OCR is an accuracy aid, never a reason to lose the item.
                tag_snippet, tag_payload = "", None

        last_soft: Optional[Dict] = None
        for _attempt in (1, 2):
            self._cancel_check()
            try:
                raw = self._call(images, tag_snippet)
            except ManagedVisionAnswerError as exc:
                # Keep the last attempted completion receipt so benchmarks and
                # diagnostics cannot mistake a rejected truncation for a clean run.
                self.last_meta = _bounded_answer_metadata(exc.metadata)
                self._cancel_check()
                last_soft = {"error": f"vision call failed: {exc}"}
                continue
            self._cancel_check()
            parsed = vision._parse_json(raw)
            if not parsed:
                candidate = {"error": "vision returned unparseable output", "raw": raw}
                try:
                    last_soft = validate_worker_enrichment(candidate)
                except ManagedVisionAnswerError:
                    last_soft = {"error": "vision returned invalid structured output"}
                continue
            fields, ai_fields = self._map_fields(parsed)
            parsed = dict(parsed)
            if tag_reading is not None:
                # The model saw the same ruler the OCR did: a bare number it calls a
                # model or style number that only the ruler photo carried is the ruler's.
                crossed = props.cross_check(parsed, tag_reading, fields)
                if "size" in crossed and "size" in ai_fields:
                    ai_fields.remove("size")
                if crossed:
                    parsed["propsScrubbed"] = sorted(
                        set(parsed.get("propsScrubbed") or []) | set(crossed))
            if tag_payload is not None:
                # Keep the raw OCR alongside the model's answer. When a brand
                # looks wrong later, this is the record of what the tag actually
                # said versus what the model concluded.
                parsed["ocr"] = tag_payload
            try:
                record, derived = evidence.build_evidence(parsed, fields, tag_reading)
                # OCR fills gaps the model left; it never overwrites an answer.
                for key, value in derived.items():
                    if not parsed.get(key):
                        parsed[key] = value
                    if key == "size" and "size" in self.fields and not fields.get("size"):
                        fields["size"] = value
                        if "size" not in ai_fields:
                            ai_fields.append("size")
                if record:
                    parsed["evidence"] = record
            except Exception:
                # Evidence is a reporting layer. Losing it must not lose the item.
                pass
            try:
                return validate_worker_enrichment({
                    "fields": fields, "aiFields": ai_fields, "raw": parsed,
                })
            except ManagedVisionAnswerError:
                last_soft = {"error": "vision returned invalid structured output"}
                continue
        return validate_worker_enrichment(
            last_soft or {"error": "vision returned no usable output"}
        )
