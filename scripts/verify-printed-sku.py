"""Exercise the installed PaddleOCR engine on generated text-only BC stickers.

This is a recognition smoke check, separate from the mocked unit tests. It does
not measure accuracy on a tester's photographs or promise missing-marker detection.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
from black_cat_worker.decode import Decoder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    font_path = Path(os.environ.get("SystemRoot", "C:/Windows")) / "Fonts/arial.ttf"
    font = ImageFont.truetype(str(font_path), 92)
    decoder = Decoder({"ocrEnabled": True, "ocrSmartGate": True})
    status = decoder.engine_status()
    if not status.get("ocr_paddle"):
        raise RuntimeError("The actual PaddleOCR engine is unavailable")
    results = []
    for text, expected in [("BC-000042", "BC-000042"), ("BC-120987", "BC-120987"), ("BC-00004", None), ("32 33 34", None)]:
        image = Image.new("RGB", (1400, 1000), (42, 55, 63))
        draw = ImageDraw.Draw(image)
        draw.rectangle((270, 370, 1130, 630), fill="white")
        bounds = draw.textbbox((0, 0), text, font=font)
        width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
        draw.text(((1400-width)//2, (1000-height)//2-bounds[1]), text, font=font, fill="black")
        filename = args.output / (text.replace(" ", "_") + ".jpg")
        image.save(filename, quality=96)
        result = decoder.decode(str(filename))
        results.append({"text": text, "expected": expected, "result": asdict(result)})
        (args.output / "printed-sku-proof.json").write_text(json.dumps({"engine": status, "cases": results}, indent=2), encoding="utf-8")
        if result.sku != expected:
            raise AssertionError("Printed sticker %r: expected %r, got %r; evidence=%r" % (text, expected, result.sku, result.evidence))
        print("Printed SKU recognition:", text, "=>", result.sku, flush=True)


if __name__ == "__main__":
    main()
