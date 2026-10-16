"""Read localized strict BC-###### END-marker evidence from QR or printed text.

Printed OCR runs independently of QR detection. Exact syntax, OCR recognition
confidence and physical light-label context are separate checks. Conflicting,
partial and ambiguous candidates remain review evidence; no digits are guessed.
Originals are retained; EXIF orientation is applied to the analysis image only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional
import re

from . import ocr_engine, regions
from . import sku as sku_mod


@dataclass
class DecodeOutcome:
    sku: Optional[str]
    raw: Optional[str]
    method: Optional[str]  # qr-opencv | qr-pyzbar | ocr | None
    # A QR-like pattern (finder squares) was LOCATED in the image, decoded or
    # not. On an undecoded photo this means "this is probably a sticker shot
    # with glare/blur" — the grouper uses it as an item-boundary signal so a
    # dead sticker can't silently merge two items.
    qr_pattern_detected: bool = False
    review_reason: Optional[str] = None
    evidence: list = field(default_factory=list)


class Decoder:
    """Holds lazily-initialized engines so PaddleOCR loads at most once."""

    def __init__(self, settings: dict):
        self.settings = settings
        self.prefixes = settings.get("skuPrefixes", ["BC-"])
        self.length = int(settings.get("skuLength", 6))
        self.ocr_enabled = bool(settings.get("ocrEnabled", True))
        self.ocr_preprocess = bool(settings.get("ocrPreprocess", True))
        # Historical ocrSmartGate settings are deliberately ignored: a printed
        # text sticker need not contain any QR pattern.
        self._cv2 = None
        self._qr = None
        self._pyzbar = None
        self._paddle = None
        self._np = None
        self._init_done = False

    # ---- lazy engine accessors -------------------------------------------
    def _ensure_cv2(self):
        if self._cv2 is None:
            try:
                import cv2  # type: ignore
                import numpy as np  # type: ignore
                self._cv2 = cv2
                self._np = np
                self._qr = cv2.QRCodeDetector()
            except Exception:
                self._cv2 = False
        return self._cv2

    def _ensure_pyzbar(self):
        if self._pyzbar is None:
            try:
                from pyzbar import pyzbar  # type: ignore
                self._pyzbar = pyzbar
            except Exception:
                self._pyzbar = False
        return self._pyzbar

    def _ensure_paddle(self):
        # The engine itself lives in ocr_engine so the tag reader shares this one
        # instance instead of loading PP-OCRv5 a second time. The CPU pinning and
        # the never-fall-back-to-an-implicit-device rule live there too.
        if self._paddle is None:
            built = ocr_engine.shared_engine()
            self._paddle = built if built else False
        return self._paddle

    # ---- availability -----------------------------------------------------
    def engine_status(self) -> dict:
        """Force-initialize every engine and report what is actually usable.

        Each engine is imported lazily and swallows its own ImportError so a
        missing dependency degrades instead of crashing. That is the right
        runtime behaviour and the wrong reporting behaviour: without cv2 the
        QR path is gone, every photo decodes to nothing, and the batch looks
        exactly like a shoot with no stickers in it. Callers use this to say so
        out loud once per run instead of silently finding zero markers.
        """
        cv2_ok = bool(self._ensure_cv2())
        return {
            # The QR path. Without it nothing can be decoded or even localized.
            "qr_opencv": cv2_ok,
            # Second-chance QR reader for codes OpenCV localizes but can't read.
            "qr_pyzbar": bool(self._ensure_pyzbar()),
            # Fallback for stickers whose QR is damaged; gated by ocrEnabled.
            "ocr_paddle": bool(self._ensure_paddle()) if self.ocr_enabled else None,
        }

    # ---- public API -------------------------------------------------------
    def decode(self, path: str) -> DecodeOutcome:
        work = self._load_work_image(path)
        qr_candidates = []
        if work is not None and self._qr is not None:
            qr_candidates.extend((val, "qr-opencv") for val in self._opencv_qr(work))
        if work is not None and self._ensure_pyzbar():
            try:
                qr_candidates.extend((res.data.decode("utf-8", "ignore"), "qr-pyzbar") for res in self._pyzbar.decode(work))
            except Exception:
                pass
        pattern = bool(qr_candidates) or (self._qr_pattern_present(work) if work is not None and self._qr is not None else False)
        accepted = {}
        evidence = []
        review = None
        for raw, method in qr_candidates:
            value = sku_mod.normalize(raw)
            if value:
                accepted[value] = (raw, method)
                evidence.append({"raw": raw, "normalized": value, "classification": "inventory_sticker", "method": method, "status": "verified"})
            elif re.match(r"^\s*BC\s*[-‐‑–—]", raw, re.I):
                review = "encoded inventory candidate has invalid or incomplete SKU syntax"
                evidence.append({"raw": raw,"normalized":None,"classification":"inventory_candidate","method":method,"status":"review"})
        # Printed stickers are supported independently of the presence of a QR.
        # Run one OCR pass even when a QR decoded, to catch conflicting labels.
        if self.ocr_enabled and self._ensure_paddle():
            lines = regions.classify([line.with_source(path) for line in ocr_engine.read_lines(work if work is not None else path, self._paddle)])
            for line in lines:
                value = sku_mod.normalize(line.text)
                candidate_like = value is not None or re.match(r"^\s*BC\s*[-‐‑–—]", line.text, re.I)
                if not candidate_like:
                    continue
                physical = regions.sticker_context(work, line, lines)
                score_ok = line.confidence is not None and line.confidence >= 0.90
                supported = bool(value and physical and score_ok)
                row = {"raw": line.text, "normalized": value, "classification": "inventory_sticker" if supported else "inventory_candidate",
                       "box": list(line.box) if line.box else None, "coordinateSpace": "analysis_image",
                       "imageSize": [int(work.shape[1]), int(work.shape[0])] if hasattr(work, "shape") else None, "recognitionScore": line.confidence,
                       "method": "ocr", "status": "verified" if supported else "review", "lightLabelContext": physical}
                evidence.append(row)
                if supported:
                    accepted[value] = (line.text, "ocr")
                elif value not in accepted:
                    review = "printed inventory candidate needs a clear localized sticker read"
        if len(accepted) > 1:
            return DecodeOutcome(None, " | ".join(accepted), None, pattern, "multiple conflicting SKU candidates", evidence)
        if len(accepted) == 1 and review is None:
            value, (raw, method) = next(iter(accepted.items()))
            return DecodeOutcome(value, raw, method, pattern, None, evidence)
        return DecodeOutcome(None, evidence[0]["raw"] if evidence else None, None, pattern, review, evidence)

    def _qr_pattern_present(self, img) -> bool:
        """True if OpenCV can LOCALIZE a QR-like pattern (finder squares) in the image,
        even when it can't decode it. Cheap (~ms) — this is what makes the OCR gate safe:
        a sticker with a glare-damaged QR still detects; a hoodie doesn't."""
        try:
            ok, points = self._qr.detectMulti(img)
            if ok and points is not None and len(points) > 0:
                return True
        except Exception:
            pass
        try:
            ok, points = self._qr.detect(img)
            if ok and points is not None:
                return True
        except Exception:
            pass
        return False

    def _load_work_image(self, path: str, max_side: int = 3000):
        """Read and downscale to max_side (keeps QR + label text legible, fast)."""
        if not self._ensure_cv2():
            return None
        try:
            from PIL import Image, ImageOps
            with Image.open(path) as original:
                oriented = ImageOps.exif_transpose(original).convert("RGB")
                img = self._cv2.cvtColor(self._np.asarray(oriented), self._cv2.COLOR_RGB2BGR)
        except Exception:
            img = self._cv2.imread(path)
        if img is None:
            return None
        longest = max(img.shape[0], img.shape[1])
        if longest > max_side:
            s = max_side / float(longest)
            img = self._cv2.resize(img, None, fx=s, fy=s, interpolation=self._cv2.INTER_AREA)
        return img

    # ---- engine helpers ---------------------------------------------------
    def _opencv_qr(self, img) -> List[str]:
        out: List[str] = []
        try:
            data, points, _ = self._qr.detectAndDecode(img)
            if data:
                out.append(data)
        except Exception:
            pass
        try:
            ok, decoded, points, _ = self._qr.detectAndDecodeMulti(img)
            if ok and decoded:
                out.extend([d for d in decoded if d])
        except Exception:
            pass
        return out

    def _ocr_texts(self, img_or_path) -> List[str]:
        # SKU decoding only needs the strings: a candidate either coerces to a
        # valid SKU or it doesn't, so the recognition score adds nothing here.
        # Tag reading does use it — see ocr_engine.OcrLine.confidence.
        return [line.text for line in ocr_engine.read_lines(img_or_path, self._paddle)]


def _extract_paddle_texts(result) -> List[str]:
    """Flatten a PaddleOCR result into plain strings.

    Kept as the module's historical entry point; the shape handling (3.x
    predict() objects and the 2.x [box, (text, score)] line form) now lives in
    ocr_engine.extract_lines, which also preserves the recognition scores.
    """
    return [line.text for line in ocr_engine.extract_lines(result)]
