"""The reviewed listing sent by the app, including its ordered export photos."""
import json
import math
import os
import re

MAX_INPUT_BYTES = 1_000_000


def read_listing_input(stream):
    raw = stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("The direct listing input is too large")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("The direct listing must be an object")
    return value


def canonical_item_and_photos(value, expected_sku):
    if not isinstance(value, dict) or value.get("sku") != expected_sku:
        raise ValueError("The direct listing SKU does not match the requested item")
    for field in ("title", "description", "condition"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f"The direct listing is missing {field}")
    price = value.get("price")
    if isinstance(price, bool) or not isinstance(price, (float, int)) or not math.isfinite(price) or price <= 0:
        raise ValueError("The direct listing price must be positive")
    quantity = value.get("quantity")
    if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 1:
        raise ValueError("The direct listing quantity must be a positive whole number")
    entries = value.get("photos")
    if not isinstance(entries, list) or not entries:
        raise ValueError("The direct listing has no photos")
    name_pattern = re.compile(rf"^{re.escape(expected_sku)}_\d+\.(?:jpe?g|png|webp)$", re.I)
    photos = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("A direct listing photo is invalid")
        filename, photo_path = entry.get("name"), entry.get("path")
        if not isinstance(filename, str) or not name_pattern.fullmatch(filename):
            raise ValueError("A direct listing photo belongs to another SKU")
        if not isinstance(photo_path, str) or not os.path.isabs(photo_path) or os.path.basename(photo_path) != filename:
            raise ValueError("A direct listing photo path does not match its filename")
        if not os.path.isfile(photo_path):
            raise ValueError(f"Listing photo {filename} is missing; export the item again")
        identity = os.path.normcase(os.path.realpath(photo_path))
        if identity in seen:
            raise ValueError("The direct listing includes a duplicate photo")
        seen.add(identity)
        photos.append(photo_path)
    # Preserve nulls and explicit empty optional fields from the current reviewed
    # copy. A stale item.json must never fill them back in.
    item = {key: val for key, val in value.items() if key != "photos"}
    item["listingPhotos"] = photos
    item["sizeless"] = not item.get("size")
    return item, photos
