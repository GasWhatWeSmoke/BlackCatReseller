"""One shared, CPU-pinned PaddleOCR engine for the whole worker process.

Two callers now need OCR for different jobs: decode.py reads SKU sticker cards,
tag_ocr.py reads clothing tags. Each building its own PaddleOCR would pay the
model-load cost and the resident memory twice per intake run, so the engine is
constructed once here and shared.

CPU pinning is a hardware decision, not a preference: the llama.cpp vision
sidecar owns the 8 GB of VRAM on this box (see HARDWARE.md), and an OCR pass
that grabbed GPU memory would evict it mid-batch. Every constructor shape below
passes device="cpu" explicitly, and if none of them is accepted the engine is
reported UNAVAILABLE rather than falling back to an implicit device — a silently
GPU-resident OCR is worse than no OCR.

Everything is imported lazily and degrades to "unavailable" instead of raising,
so the pure-logic tests need no PaddleOCR install.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence, Tuple

# Tried in order; the first shape the installed PaddleOCR accepts wins.
# paddleocr 3.x dropped the 2.x kwargs (use_angle_cls/show_log).
# enable_mkldnn=False avoids a OneDNN PIR crash on PP-OCRv5 under Paddle 3.x.
# The doc-orientation / unwarping / textline-orientation sub-models are three
# extra passes that dominate CPU time; labels and tags are shot upright.
_CPU_PINNED_SHAPES: Tuple[dict, ...] = (
    {"device": "cpu", "lang": "en", "enable_mkldnn": False,
     "use_doc_orientation_classify": False, "use_doc_unwarping": False,
     "use_textline_orientation": False},
    {"device": "cpu", "lang": "en", "enable_mkldnn": False},
    {"device": "cpu", "lang": "en"},
    {"device": "cpu"},
)

# None = not attempted yet, False = attempted and unavailable, else the engine.
_ENGINE: Any = None


@dataclass
class OcrLine:
    """One recognized text line.

    The recognition score is kept. decode.py historically discarded it because a
    SKU either coerces to a valid code or it doesn't. Tag reading uses the score
    to filter/rank text readings; even a high score does not verify that the
    text names the garment's brand or size.
    """
    text: str
    confidence: Optional[float] = None
    box: Optional[Tuple[int, int, int, int]] = None  # x0, y0, x1, y1
    source: Optional[str] = None  # photo path, when known

    def with_source(self, source: str) -> "OcrLine":
        return OcrLine(self.text, self.confidence, self.box, source)


def build_engine() -> Any:
    """Construct a CPU-pinned PaddleOCR, or return None if unavailable.

    Only TypeError advances to the next constructor shape — that is the signal
    that this PaddleOCR version does not accept those kwargs. Any other failure
    (a broken install, a missing model download) means OCR is unavailable, and
    trying further shapes would just repeat it.
    """
    try:
        from paddleocr import PaddleOCR  # type: ignore
        built = None
        for kwargs in _CPU_PINNED_SHAPES:
            try:
                built = PaddleOCR(**kwargs)
                break
            except TypeError:
                continue
        return built
    except Exception:
        return None


def shared_engine() -> Any:
    """The process-wide engine: the built engine, or False when unavailable."""
    global _ENGINE
    if _ENGINE is None:
        built = build_engine()
        _ENGINE = built if built is not None else False
    return _ENGINE


def reset_shared_engine() -> None:
    """Drop the cached engine. For tests that patch the paddleocr module."""
    global _ENGINE
    _ENGINE = None


def run_engine(engine: Any, image_or_path: Any) -> Any:
    """Call whichever inference API this PaddleOCR version exposes."""
    if not engine:
        return None
    try:
        return engine.predict(image_or_path)  # paddleocr 3.x
    except Exception:
        try:
            return engine.ocr(image_or_path)  # paddleocr 2.x
        except Exception:
            return None


def _as_box(poly: Any) -> Optional[Tuple[int, int, int, int]]:
    """Reduce a polygon or box of any supported shape to (x0, y0, x1, y1)."""
    try:
        pts = list(poly)
        if len(pts) == 4 and all(isinstance(v, (int, float)) for v in pts):
            x0, y0, x1, y1 = (float(v) for v in pts)  # already a box
            return (int(min(x0, x1)), int(min(y0, y1)), int(max(x0, x1)), int(max(y0, y1)))
        xs, ys = [], []
        for pt in pts:
            x, y = list(pt)[:2]
            xs.append(float(x))
            ys.append(float(y))
        if not xs or not ys:
            return None
        return (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))
    except Exception:
        return None


def _dictish_get(node: Any, key: str) -> Any:
    """Read a key from a PaddleOCR 3.x result, which is dict-like OR attributed."""
    try:
        if key in node:
            return node[key]
    except Exception:
        pass
    return getattr(node, key, None)


def extract_lines(result: Any) -> List[OcrLine]:
    """Flatten any PaddleOCR return shape into OcrLines, keeping scores.

    Handles paddleocr 3.x predict() (result objects exposing rec_texts /
    rec_scores / rec_polys) and the 2.x ocr() line shape [box, (text, score)].
    Unknown shapes yield nothing rather than raising.
    """
    lines: List[OcrLine] = []

    def walk(node: Any) -> None:
        if node is None:
            return
        if isinstance(node, str):
            if node:
                lines.append(OcrLine(node))
            return

        rec = _dictish_get(node, "rec_texts")
        if rec is not None:
            texts = list(rec) if isinstance(rec, (list, tuple)) else [rec]
            scores = _dictish_get(node, "rec_scores")
            scores = list(scores) if isinstance(scores, (list, tuple)) else []
            polys = _dictish_get(node, "rec_polys")
            if polys is None:
                polys = _dictish_get(node, "rec_boxes")
            if polys is None:
                polys = _dictish_get(node, "dt_polys")
            polys = list(polys) if isinstance(polys, (list, tuple)) else []
            for i, text in enumerate(texts):
                text = str(text)
                if not text:
                    continue
                score = None
                if i < len(scores):
                    try:
                        score = float(scores[i])
                    except Exception:
                        score = None
                box = _as_box(polys[i]) if i < len(polys) else None
                lines.append(OcrLine(text, score, box))
            return

        # 2.x line: [box, (text, score)]
        if (
            isinstance(node, (list, tuple))
            and len(node) == 2
            and isinstance(node[1], (list, tuple))
            and node[1]
            and isinstance(node[1][0], str)
        ):
            text = node[1][0]
            score = None
            if len(node[1]) > 1:
                try:
                    score = float(node[1][1])
                except Exception:
                    score = None
            if text:
                lines.append(OcrLine(text, score, _as_box(node[0])))
            return

        if isinstance(node, (list, tuple)):
            for child in node:
                walk(child)

    walk(result)
    return lines


def read_lines(image_or_path: Any, engine: Any = None) -> List[OcrLine]:
    """Run OCR on one image and return its lines. [] when OCR is unavailable."""
    eng = engine if engine is not None else shared_engine()
    if not eng:
        return []
    return extract_lines(run_engine(eng, image_or_path))
