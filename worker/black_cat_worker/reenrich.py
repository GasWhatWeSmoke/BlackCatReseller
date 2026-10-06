"""Managed AI re-identification for one already-imported item.

Usage: ``python -m black_cat_worker.reenrich <spec.json>``. The spec contains
only ``sku`` and stored ``photos``; the fixed local runtime owns model, endpoint, and
server lifecycle. A result is emitted only after managed-session exit succeeds.
"""
from __future__ import annotations

import json
import sys

from .managed_vision import ManagedVisionCancelled, ManagedVisionDeferred
from .reenrich_batch import (
    _deferral_payload,
    _safe_text,
    emit,
    run_batch,
    validate_batch_spec,
)


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) != 1:
        emit({"event": "error", "message": "usage: reenrich <spec.json>"})
        return 2
    try:
        with open(argv[0], "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if not isinstance(raw, dict) or set(raw) != {"sku", "photos"}:
            raise ValueError("single spec must contain only sku and photos")
        items = validate_batch_spec({
            "items": [{
                "requestId": "single",
                "sku": raw["sku"],
                "photos": raw["photos"],
            }],
        })
        payload = run_batch(items)
        emit({"event": "result", "payload": payload["items"][0]["enrichment"]})
        return 0
    except ManagedVisionDeferred as exc:
        emit(_deferral_payload(exc))
        return 75
    except ManagedVisionCancelled as exc:
        emit({
            "event": "cancelled",
            "code": "VISION_CANCELLED",
            "message": _safe_text(exc) or "managed vision cancelled",
        })
        return 130
    except BaseException as exc:
        emit({
            "event": "error",
            "message": _safe_text(exc, 500) or "managed vision failed",
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
