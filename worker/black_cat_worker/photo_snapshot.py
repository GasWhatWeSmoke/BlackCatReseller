"""Bind approved photo inputs and immutable export bytes to automatic posting."""
import hashlib
import os
from pathlib import Path
import re


def file_receipt(filename):
    path = Path(filename)
    before = path.stat()
    if not path.is_file():
        raise ValueError("A selected photo is not a file")
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("A selected photo changed while being read")
    return {'size': str(after.st_size), 'mtimeNs': str(after.st_mtime_ns), 'sha256': digest.hexdigest()}


def recipe_from_database(connection, item_id, sku):
    if not isinstance(sku, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', sku):
        raise ValueError("Invalid photo SKU")
    rows = connection.execute(
        'SELECT id,storedPath,sha256,rotation FROM Photo WHERE itemId=? '
        'AND includeInListing=1 AND isMarker=0 ORDER BY isCover DESC,sortOrder,id', (item_id,),
    ).fetchall()
    recipe = []
    for index, (photo_id, source, digest, rotation) in enumerate(rows, 1):
        extension = Path(source).suffix.lower()
        if extension not in {'.jpg', '.jpeg', '.png', '.webp'} or rotation not in (0, 90, 180, 270):
            raise ValueError("Invalid selected photo")
        recipe.append({'id': photo_id, 'sourcePath': source, 'sourceHash': digest,
                       'rotation': rotation, 'name': f'{sku}_{index:02d}{extension}'})
    return recipe


def assert_photo_snapshot(connection, item_id, sku, snapshot, photo_paths):
    message = "Prepared photos changed or are unverified. Review and approve this item again before publishing."
    try:
        folder = connection.execute('SELECT readyFolderPath FROM Item WHERE id=?', (item_id,)).fetchone()
        recipe = recipe_from_database(connection, item_id, sku)
        if (not isinstance(snapshot, dict) or type(snapshot.get('version')) is not int or snapshot['version'] != 1
                or snapshot.get('itemId') != item_id or snapshot.get('sku') != sku or not recipe
                or not folder or not folder[0] or snapshot.get('directory') != folder[0]
                or snapshot.get('recipe') != recipe):
            raise ValueError(message)
        directory = Path(folder[0])
        if not directory.is_absolute():
            raise ValueError(message)
        listing = directory / 'listing_photos'
        if listing.resolve() != directory.resolve() / 'listing_photos':
            raise ValueError(message)
        expected_paths = [str(listing / entry['name']) for entry in recipe]
        if not isinstance(photo_paths, list) or [os.path.normcase(os.path.abspath(p)) for p in photo_paths] != [os.path.normcase(p) for p in expected_paths]:
            raise ValueError(message)
        for key in ('sources', 'files'):
            if not isinstance(snapshot.get(key), list) or len(snapshot[key]) != len(recipe):
                raise ValueError(message)
        for index, entry in enumerate(recipe):
            output = Path(expected_paths[index])
            if output.is_symlink() or output.resolve().parent != listing.resolve():
                raise ValueError(message)
            if (file_receipt(entry['sourcePath']) != snapshot['sources'][index]
                    or file_receipt(output) != snapshot['files'][index]):
                raise ValueError(message)
        # Recheck after file reads, which can take time for full-resolution sets.
        if (connection.execute('SELECT readyFolderPath FROM Item WHERE id=?', (item_id,)).fetchone() != folder
                or recipe_from_database(connection, item_id, sku) != recipe):
            raise ValueError(message)
    except (OSError, TypeError, KeyError, ValueError) as error:
        raise ValueError(message) from error
