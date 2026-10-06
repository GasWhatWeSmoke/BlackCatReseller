"""Thumbnail generation (Pillow, lazy). Returns the thumb path or None."""
from __future__ import annotations

import os
from typing import Optional


def make_thumbnail(src: str, dst: str, max_px: int = 400) -> Optional[str]:
    try:
        from PIL import Image, ImageOps  # lazy
    except Exception:
        return None
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with Image.open(src) as img:
            img = ImageOps.exif_transpose(img)  # respect orientation
            img.thumbnail((max_px, max_px))
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.save(dst, "JPEG", quality=82)
        return dst
    except Exception:
        return None
