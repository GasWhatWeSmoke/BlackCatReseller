"""Ten-item native intake/export acceptance with an explicitly chosen worker Python.

No application server, marketplace operation, real photo, OCR or AI model is used.
Run after worker setup succeeds:
  python tests/workflow/ten-item-beta.py --worker-python <absolute-new-python.exe>
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def owned(folder: Path) -> Path:
    folder = folder.resolve()
    if (folder.parent != Path(tempfile.gettempdir()).resolve()
            or not folder.name.startswith("blackcat-workflow-ten-")
            or folder.is_symlink()
            or json.loads((folder / "fixture-owner.json").read_text())["fixture"] is not True):
        raise ValueError("An explicitly owned ten-item temporary fixture is required")
    return folder


def generate(folder: Path) -> None:
    from PIL import Image, ImageDraw
    import qrcode

    folder = owned(folder)
    camera = folder / "camera"
    camera.mkdir()
    photos = []
    for number in range(1, 11):
        sku = f"{number:06d}"
        for angle in range(4):
            sequence = (number - 1) * 4 + angle
            image = Image.new("RGB", (900, 1200), (60 + number * 10, 70 + angle * 30, 150))
            if angle == 3:
                image = Image.new("RGB", (900, 1200), "white")
                qr = qrcode.make("BC-" + sku).convert("RGB").resize((700, 700), Image.Resampling.NEAREST)
                image.paste(qr, (100, 250))
            else:
                draw = ImageDraw.Draw(image)
                draw.text((60, 80), f"SYNTHETIC GARMENT {sku}\nView {angle + 1}", fill="white")
                draw.rectangle((130 + angle * 15, 230, 740, 990), outline="white", width=12)
            exif = Image.Exif()
            exif[36867] = (datetime(2026, 10, 3, 10) + timedelta(seconds=sequence * 2)).strftime("%Y:%m:%d %H:%M:%S")
            filename = f"IMG_{40 - sequence:04}.jpg"
            destination = camera / filename
            image.save(destination, quality=90, exif=exif)
            photos.append({"filename": filename, "sku": sku, "angle": angle, "marker": angle == 3,
                           "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
    (folder / "camera-manifest.json").write_text(json.dumps({"files": photos, "python": sys.executable}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-python", type=Path)
    parser.add_argument("--generate", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.generate is not None:
        generate(args.generate)
        return
    if args.worker_python is None or not args.worker_python.is_absolute() or not args.worker_python.is_file():
        parser.error("--worker-python must name an existing absolute interpreter path after setup succeeds")
    root = Path(__file__).resolve().parents[2]
    worker = args.worker_python.resolve()
    base = Path(tempfile.mkdtemp(prefix="blackcat-ten-item-proof-"))
    print(str(base), flush=True)
    proof = {"workerPython": str(worker), "syntheticPhotos": True, "recognition": "disabled; manual fields supplied by fixture",
             "marketplaceActions": "none", "backupHook": "substituted", "cases": []}
    environment = {**os.environ, "PYTHONPATH": "", "PYTHONHOME": "", "PYTHONIOENCODING": "utf-8", "BLACKCAT_PREVIEW": "1"}
    for case in ("complete", "missing-marker"):
        with tempfile.TemporaryDirectory(prefix="blackcat-workflow-ten-") as directory:
            folder = Path(directory)
            (folder / "fixture-owner.json").write_text('{"fixture":true}')
            owned(folder)
            log = base / f"{case}.log"
            with log.open("w", encoding="utf-8") as output:
                subprocess.run([str(worker), str(Path(__file__).resolve()), "--generate", str(folder)],
                               cwd=root, env=environment, stdout=output, stderr=subprocess.STDOUT,
                               timeout=60, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                subprocess.run(["node", str(root / "tests/workflow/ten-item-beta.mjs"), str(folder), str(worker), case],
                               cwd=root, env=environment, stdout=output, stderr=subprocess.STDOUT,
                               timeout=240, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
            result = json.loads((folder / "proof.json").read_text())
            proof["cases"].append(result)
            (base / "proof.json").write_text(json.dumps(proof, indent=2))
            print(json.dumps(result), flush=True)
            owned(folder)  # Recheck containment immediately before owned fixture cleanup.
    print(json.dumps({"ok": True, "proof": str(base / "proof.json")}), flush=True)


if __name__ == "__main__":
    main()
