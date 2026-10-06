"""Deterministic localhost llama.cpp-compatible vision fixture.

The production Python transport is fixed to ``127.0.0.1:1235`` and the exact
``blackcat-vision`` alias. This fixture implements that same HTTP boundary
without loading a model or touching the GPU.

Set:

* ``BLACKCAT_E2E_RESPONSES`` to a JSON array of scripted enrichment objects.
* ``BLACKCAT_E2E_REQUEST_LOG`` to an optional disposable JSONL receipt path.

The synthetic image probe returns ``READY`` without consuming an enrichment.
"""
from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List


HOST = "127.0.0.1"
PORT = 1235
MODEL_ALIAS = "blackcat-vision"
_MAX_REQUEST_BYTES = 32 * 1024 * 1024
_STATE = {"responses": None, "index": 0, "lock": threading.Lock()}


def _load_responses() -> List[Dict]:
    cached = _STATE["responses"]
    if isinstance(cached, list):
        return cached
    source = str(os.environ.get("BLACKCAT_E2E_RESPONSES") or "").strip()
    if not source:
        raise RuntimeError("BLACKCAT_E2E_RESPONSES is required by the local VLM fixture")
    with open(source, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise RuntimeError("local VLM fixture responses must be a JSON object array")
    _STATE["responses"] = raw
    return raw


def _completion(content: str) -> bytes:
    return json.dumps({
        "id": "blackcat-e2e",
        "object": "chat.completion",
        "model": MODEL_ALIAS,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }, separators=(",", ":")).encode("utf-8")


def _write_receipt(payload: Dict) -> None:
    target = str(os.environ.get("BLACKCAT_E2E_REQUEST_LOG") or "").strip()
    if not target:
        return
    with open(target, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, separators=(",", ":")) + "\n")


class Handler(BaseHTTPRequestHandler):
    server_version = "BlackCatLocalVisionFixture/1"

    def log_message(self, *_args) -> None:
        pass

    def _send_json(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, b'{"status":"ok"}')
            return
        if self.path == "/v1/models":
            self._send_json(
                200,
                b'{"object":"list","data":[{"id":"blackcat-vision","object":"model"}]}',
            )
            return
        self._send_json(404, b'{"error":"not found"}')

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self._send_json(404, b'{"error":"not found"}')
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 1 or length > _MAX_REQUEST_BYTES:
            self._send_json(413, b'{"error":"request size rejected"}')
            return
        try:
            request = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, b'{"error":"invalid JSON"}')
            return
        if not isinstance(request, dict) or request.get("model") != MODEL_ALIAS:
            self._send_json(400, b'{"error":"wrong model alias"}')
            return

        messages = request.get("messages")
        content = messages[0].get("content") if isinstance(messages, list) and messages else []
        if not isinstance(content, list):
            content = []
        prompt = " ".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
        images = sum(
            1 for part in content
            if isinstance(part, dict) and part.get("type") == "image_url"
            and str((part.get("image_url") or {}).get("url") or "").startswith("data:image/")
        )
        is_probe = "ASCII characters READY" in prompt
        with _STATE["lock"]:
            if is_probe:
                answer = "READY"
                kind = "probe"
            else:
                responses = _load_responses()
                index = int(_STATE["index"])
                if index >= len(responses):
                    self._send_json(500, b'{"error":"fixture response queue exhausted"}')
                    return
                answer = json.dumps(responses[index], separators=(",", ":"))
                _STATE["index"] = index + 1
                kind = f"enrich#{index + 1}"
            _write_receipt({
                "kind": kind,
                "model": request.get("model"),
                "images": images,
                "stream": request.get("stream"),
            })
        self._send_json(200, _completion(answer))


def main() -> None:
    responses = _load_responses()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"local VLM fixture on http://{HOST}:{PORT} with {len(responses)} scripted response(s)",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
