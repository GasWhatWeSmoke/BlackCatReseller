"""Conservative, spatial routing of OCR evidence, independent of boundaries.

Geometry/text heuristics are review evidence, not an object detector. Unsupported
regions stay unknown; no ruler dimension is inferred from recognized numerals.
"""
from __future__ import annotations

import re
from dataclasses import replace
from typing import List

from .ocr_engine import OcrLine
from .sku import normalize

_TOOL = re.compile(r"(?:HOME\s*DEPOT|HUSKY|EMPIRE|EMPIR[EÉ][?®]*|MILWAUKEE|MODEL\s*403|RULER|YARDSTICK|TAPE\s*MEASURE)", re.I)
_NUMBER = re.compile(r"[0-9]{1,3}(?:\.[0-9]+)?\Z")
_SIZE = re.compile(r"(?:SIZE\s*[:.]?\s*(?:[0-9]{1,3}|[2345]?X?[SML]|XS|XXL)|W\s*[0-9]{2}\s*L\s*[0-9]{2})\Z", re.I)


def _near(a, b, factor=5):
    if not a.box or not b.box or a.source != b.source:
        return False
    ax, ay, ar, ab = a.box
    bx, by, br, bb = b.box
    height = max(ab - ay, bb - by, 1)
    return abs((ay + ab) - (by + bb)) / 2 <= height * factor and max(ax - br, bx - ar, 0) <= height * factor


def classify(lines: List[OcrLine]) -> List[OcrLine]:
    out = [replace(line) for line in lines]
    # Spatially aligned scale numbers. A numeric size elsewhere in the image
    # remains independent, even if a ruler logo is present in that same photo.
    numeric = [i for i, line in enumerate(out) if _NUMBER.fullmatch(line.text.strip()) and line.box]
    scale = set()
    for i in numeric:
        a = out[i]
        ax, ay, ar, ab = a.box
        horizontal = [j for j in numeric if out[j].source == a.source and abs((out[j].box[1] + out[j].box[3]) - (ay + ab)) <= max(ab-ay, out[j].box[3]-out[j].box[1])]
        vertical = [j for j in numeric if out[j].source == a.source and abs((out[j].box[0] + out[j].box[2]) - (ax + ar)) <= max(ar-ax, out[j].box[2]-out[j].box[0])]
        for candidates, axis in ((horizontal, 0), (vertical, 1)):
            candidates.sort(key=lambda j: out[j].box[axis])
            if len(candidates) < 3:
                continue
            values = [float(out[j].text) for j in candidates]
            delta = [b-a for a,b in zip(values, values[1:])]
            if all(0 < d <= 10 for d in delta) or all(-10 <= d < 0 for d in delta):
                scale.update(candidates)
    for i, line in enumerate(out):
        if line.classification != "unknown":
            continue
        text = " ".join(line.text.upper().split())
        if normalize(text):
            line.classification = "inventory_candidate"
        elif i in scale:
            line.classification = "measurement_scale"
        elif _TOOL.fullmatch(text) and any(_near(line, out[j]) for j in scale):
            line.classification = "measuring_tool_branding"
        elif _SIZE.fullmatch(text):
            line.classification = "garment_tagged_size"
        else:
            line.classification = "unknown"
    # Identifiers located inside the scale's vicinity are tool metadata only.
    for line in out:
        if line.classification == "unknown" and re.search(r"\b(?:SKU|MODEL|PART|UPC)\b", line.text, re.I) and any(_near(line, out[j]) for j in scale):
            line.classification = "tool_identifier"
    return out


def sticker_context(image, line: OcrLine, lines=()) -> bool:
    """Require a localized dark-on-light label patch around the exact candidate.

    This is bounded physical evidence in addition to syntax, not a guarantee of
    real-world accuracy. OCR lines without a location are never auto markers.
    """
    if image is None or not line.box:
        return False
    try:
        import cv2
        import numpy as np
        x0, y0, x1, y1 = line.box
        height, width = image.shape[:2]
        h = max(1, y1-y0)
        if x0 < 0 or y0 < 0 or x1 > width or y1 > height or x1 <= x0 or y1 <= y0:
            return False
        patch = image[max(0,y0-h):min(height,y1+h), max(0,x0-h):min(width,x1+h)]
        gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY) if patch.ndim == 3 else patch
        # A separate light label gives a bright margin around contrasting print.
        # Dark garment text or a metal scale cannot pass on syntax alone.
        bright = gray >= 195
        margin = np.concatenate([bright[0,:], bright[-1,:], bright[:,0], bright[:,-1]])
        light_patch = bool(float(bright.mean()) >= 0.60 and float(margin.mean()) >= 0.75 and int(gray.min()) < 150)
        scale_lines = [other for other in lines if other.classification in {"measurement_scale", "measuring_tool_branding", "tool_identifier"} and other.box]
        if light_patch and not any(_near(line, other, factor=12) for other in scale_lines):
            return True
        # OCR detection boxes can include extra vertical padding. A real label
        # may end inside the expanded patch, so localize its actual boundary
        # instead of requiring that arbitrary patch edge to remain white.
        # Near a scale, its component must also exclude ALL nearby tool text.
        full_gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        if int(full_gray[y0:y1, x0:x1].min()) >= 150:
            return False
        _, mask = cv2.threshold(full_gray, 195, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        text_area = max(1, (x1-x0)*(y1-y0))
        for contour in contours:
            x,y,w,label_h = cv2.boundingRect(contour)
            if x == 0 or y == 0 or x+w >= width or y+label_h >= height:
                continue  # A frame-filling white surface has no proven label edge.
            if not (x <= x0-h/4 and y <= y0-h/4 and x+w >= x1+h/4 and y+label_h >= y1+h/4):
                continue
            if not (1.3*text_area <= w*label_h <= 20*text_area) or not (1 <= w/max(1,label_h) <= 12):
                continue
            if cv2.contourArea(contour) < .7*w*label_h:
                continue
            contains_scale = any(x <= (other.box[0]+other.box[2])/2 <= x+w and y <= (other.box[1]+other.box[3])/2 <= y+label_h for other in scale_lines)
            if not contains_scale:
                return True
        return False
    except Exception:
        return False
