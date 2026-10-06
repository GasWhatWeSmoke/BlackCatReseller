"""Prepared listing export — `python -m black_cat_worker.export <spec.json>`.

Reads a JSON spec produced by the Next.js side and writes a clean export folder:
  ready/<sku>/listing_photos/<sku>_NN.jpg   (rotation baked in, cover first)
  ready/<sku>/internal/<sku>_sku_marker.jpg (never a listing photo)
  ready/<sku>/notes.txt
  ready/<sku>/item.json

Spec shape:
  { "sku","readyDir","notes":{...},"itemJson":{...},
    "listingPhotos":[{"src","destName","rotation"}], "marker":{"src","destName"} }
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
from .photo_snapshot import file_receipt


def _copy_rotated(src: str, dst: str, rotation: int) -> None:
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise ValueError("Photo rotation must be 0, 90, 180, or 270 degrees")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if rotation == 0:
        shutil.copy2(src, dst)
        return
    from PIL import Image, ImageOps  # lazy; an unavailable decoder is an export failure
    with Image.open(src) as image:
        oriented = ImageOps.exif_transpose(image)
        # PIL rotates counter-clockwise; negate to rotate clockwise.
        rotated = oriented.rotate(-rotation, expand=True)
        output_format = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}[Path(dst).suffix.lower()]
        if output_format == "JPEG" and rotated.mode not in ("RGB", "L"):
            rotated = rotated.convert("RGB")
        rotated.save(dst, output_format, **({"quality": 92} if output_format != "PNG" else {}))


def run(spec: dict) -> int:
    ready_dir = spec["readyDir"]
    sku = spec["sku"]
    if not isinstance(sku, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", sku):
        raise ValueError("Export requires a path-safe SKU")
    photos = spec.get("listingPhotos", [])
    if not isinstance(photos, list) or not photos:
        raise ValueError("Export requires selected listing photos")
    own_photo = re.compile(re.escape(sku) + r"_\d+\.(?:jpe?g|png|webp)", re.I)
    expected = set()
    for photo in photos:
        name = photo.get("destName")
        if not isinstance(name, str) or not own_photo.fullmatch(name) or name.casefold() in expected:
            raise ValueError("Export photo names must uniquely identify this SKU")
        expected.add(name.casefold())
    recipe = spec.get('photoRecipe')
    sources = None
    if recipe is not None:
        if (type(spec.get('itemId')) is not int or spec['itemId'] < 1 or not isinstance(recipe, list)
                or len(recipe) != len(photos) or any(not isinstance(entry, dict) or
                    (entry.get('sourcePath'), entry.get('name'), entry.get('rotation')) !=
                    (photo['src'], photo['destName'], photo.get('rotation', 0)) for entry, photo in zip(recipe, photos))):
            raise ValueError('Photo recipe does not match the requested export')
        sources = [file_receipt(photo['src']) for photo in photos]
    listing_dir = os.path.join(ready_dir, "listing_photos")
    internal_dir = os.path.join(ready_dir, "internal")
    root = Path(ready_dir).resolve()
    for directory in (listing_dir, internal_dir):
        if not Path(directory).resolve().is_relative_to(root):
            raise ValueError("Export directory escaped the ready folder")
    os.makedirs(listing_dir, exist_ok=True)
    os.makedirs(internal_dir, exist_ok=True)

    with TemporaryDirectory(prefix="export-stage-", dir=internal_dir) as staging:
        for ph in photos:
            if Path(listing_dir, ph["destName"]).is_symlink():
                raise ValueError("Refusing to overwrite a linked export photo")
            _copy_rotated(ph["src"], os.path.join(staging, ph["destName"]),
                          ph.get("rotation", 0))
        if sources is not None and sources != [file_receipt(photo['src']) for photo in photos]:
            raise ValueError('Selected photos changed during export; review and approve again')
        for ph in photos:
            Path(staging, ph["destName"]).replace(Path(listing_dir, ph["destName"]))

    # A smaller/reordered selection can leave old _06/_07 files behind. Archive
    # only this SKU's obsolete photos after EVERY current photo copied correctly.
    # Foreign files remain visible to the publisher's stray-photo guard.
    stale = [photo for photo in Path(listing_dir).iterdir()
             if photo.is_file() and own_photo.fullmatch(photo.name) and photo.name.casefold() not in expected]
    if stale:
        archive = Path(internal_dir, "superseded-exports", uuid4().hex)
        if not archive.resolve().is_relative_to(root) or any(photo.is_symlink() or photo.resolve().parent != Path(listing_dir).resolve() for photo in stale):
            raise ValueError("Refusing to move an export photo outside its ready folder")
        archive.mkdir(parents=True)
        for photo in stale:
            photo.replace(archive / photo.name)

    marker = spec.get("marker")
    if marker and marker.get("src") and os.path.exists(marker["src"]):
        shutil.copy2(marker["src"], os.path.join(internal_dir, marker["destName"]))

    notes = spec.get("notes", {})
    notes_txt = "\n".join(f"{k}: {v}" for k, v in notes.items())
    with open(os.path.join(ready_dir, "notes.txt"), "w", encoding="utf-8") as f:
        f.write(notes_txt + "\n")

    item_json = dict(spec.get("itemJson", {}))
    if recipe is not None:
        item_json['photoSnapshot'] = {'version': 1, 'itemId': spec['itemId'], 'sku': sku,
            'directory': ready_dir, 'recipe': recipe, 'sources': sources,
            'files': [file_receipt(Path(listing_dir, photo['destName'])) for photo in photos]}
    with open(os.path.join(ready_dir, "item.json"), "w", encoding="utf-8") as f:
        json.dump(item_json, f, indent=2)

    print(json.dumps({"ok": True, "readyDir": ready_dir}))
    return 0


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print(json.dumps({"ok": False, "error": "missing spec path"}))
        return 2
    with open(argv[0], "r", encoding="utf-8") as f:
        spec = json.load(f)
    return run(spec)


if __name__ == "__main__":
    raise SystemExit(main())
