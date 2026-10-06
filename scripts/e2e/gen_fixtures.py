"""Generate a synthetic mixed intake batch for the E2E test.

For each (sku, label) pair: 3 "item photos" (solid-color JPEGs with the label
drawn on; the injected managed-adapter test double supplies identification)
followed by 1 QR sticker photo encoding BC-<sku>, named in shoot order so the
worker's filename-order fallback groups them exactly like a real batch
(photos accumulate, the sticker CLOSES the item).

Usage: python gen_fixtures.py --out <incoming-dir>
Requires the worker venv (Pillow + qrcode are installed there).
"""
from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw
import qrcode

ITEMS = [
    ("900001", "SHIRT", (70, 110, 180)),
    ("900002", "JEANS", (40, 60, 120)),
    ("900003", "HANDBAG", (140, 90, 50)),
    ("900004", "BELT", (60, 40, 25)),
    ("900005", "SCARF", (170, 40, 60)),
    ("900006", "NECKLACE", (200, 170, 60)),
    ("900007", "BUCKET HAT", (60, 130, 90)),
]


def photo(label: str, color, idx: int) -> Image.Image:
    img = Image.new("RGB", (900, 1200), color)
    d = ImageDraw.Draw(img)
    d.text((60, 80), f"{label}\nangle {idx}", fill=(255, 255, 255))
    return img


def sticker(payload: str) -> Image.Image:
    qr = qrcode.make(payload).convert("RGB").resize((700, 700), Image.NEAREST)
    img = Image.new("RGB", (900, 1200), (245, 245, 245))
    img.paste(qr, (100, 250))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    n = 0
    for sku, label, color in ITEMS:
        for i in range(1, 4):
            n += 1
            photo(label, color, i).save(os.path.join(args.out, f"IMG_{9000 + n:05d}.jpg"), quality=88)
        n += 1
        sticker(f"BC-{sku}").save(os.path.join(args.out, f"IMG_{9000 + n:05d}.jpg"), quality=92)
    print(f"wrote {n} fixture photos for {len(ITEMS)} items into {args.out}")


if __name__ == "__main__":
    main()
