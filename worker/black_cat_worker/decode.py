"""Per-photo decode cascade: QR (OpenCV -> pyzbar) -> OCR (PaddleOCR PP-OCRv5).

A photo is a marker iff a decode yields a value that normalizes/corrects to a
valid SKU.  All heavy deps are imported lazily and degrade gracefully, so the
pipeline still runs (markers just won't be found) if a dep is missing — and the
pure-logic tests need none of them.

Engine rationale (benchmark-checked): traditional OCR ~= VLM accuracy on clean
printed labels but far faster/lighter/deterministic; the allowlist + format
correction (sku.coerce_to_sku) is the real accuracy lever.  A vision-LLM
escalation is Version B.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from . import ocr_engine
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


class Decoder:
    """Holds lazily-initialized engines so PaddleOCR loads at most once."""

    def __init__(self, settings: dict):
        self.settings = settings
        self.prefixes = settings.get("skuPrefixes", ["BC-"])
        self.length = int(settings.get("skuLength", 6))
        self.ocr_enabled = bool(settings.get("ocrEnabled", True))
        self.ocr_preprocess = bool(settings.get("ocrPreprocess", True))
        # Smart gate: only OCR a photo when a QR-LIKE PATTERN was detected but not decoded
        # (i.e. it's a sticker shot with a damaged/glare QR). Garment photos have no QR at
        # all, and running CPU OCR on every one of them cost ~14s/photo — it turned a
        # seconds-long decode pass into many minutes. `false` reverts to OCR-everything.
        self.ocr_smart_gate = bool(settings.get("ocrSmartGate", True))
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
        raw_seen: Optional[str] = None
        # Load + downscale ONCE (iPhone shots are ~4000px); reuse for QR + OCR.
        work = self._load_work_image(path)

        # 1) QR via OpenCV (single + multi).
        if work is not None and self._qr is not None:
            for val in self._opencv_qr(work):
                raw_seen = raw_seen or val
                normalized = sku_mod.normalize(val, self.prefixes, self.length)
                if normalized:
                    return DecodeOutcome(normalized, val, "qr-opencv", True)

        # 2) QR via pyzbar.
        if work is not None and self._ensure_pyzbar():
            try:
                for res in self._pyzbar.decode(work):
                    val = res.data.decode("utf-8", "ignore")
                    raw_seen = raw_seen or val
                    normalized = sku_mod.normalize(val, self.prefixes, self.length)
                    if normalized:
                        return DecodeOutcome(normalized, val, "qr-pyzbar", True)
            except Exception:
                pass

        # QR didn't decode — check whether a QR-like pattern is at least PRESENT.
        # Cheap (~ms). Feeds both the OCR smart gate and the grouper's boundary
        # safeguard (an unreadable sticker still ends its item).
        pattern = self._qr_pattern_present(work) if work is not None and self._qr is not None else False

        # 3) OCR fallback (allowlist + format correction). No thresholding — it
        # destroyed real glossy/angled labels; the raw downscaled image reads best.
        # Smart-gated: only worth paying CPU OCR when this LOOKS like a sticker shot
        # (a QR pattern is present but wouldn't decode). If cv2 is unavailable we can't
        # detect, so fall back to the old OCR-everything behavior.
        run_ocr = self.ocr_enabled
        if run_ocr and self.ocr_smart_gate and work is not None and self._qr is not None:
            run_ocr = pattern
        if run_ocr and self._ensure_paddle():
            for text in self._ocr_texts(work if work is not None else path):
                corrected = sku_mod.coerce_to_sku(text, self.prefixes, self.length)
                if corrected:
                    return DecodeOutcome(corrected, text, "ocr", pattern)
                if raw_seen is None and any(ch.isalnum() for ch in text):
                    raw_seen = text

        return DecodeOutcome(None, raw_seen, None, pattern)

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

    def _load_work_image(self, path: str, max_side: int = 1800):
        """Read and downscale to max_side (keeps QR + label text legible, fast)."""
        if not self._ensure_cv2():
            return None
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
