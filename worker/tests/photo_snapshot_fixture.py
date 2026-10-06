"""A real prepared export for isolated publication tests; never production data."""
import contextlib
import hashlib
import importlib
import io
import json
from pathlib import Path
from uuid import uuid4
from black_cat_worker.photo_snapshot import recipe_from_database


def attach_photo_snapshot(connection, root, item):
    if 'readyFolderPath' not in {row[1] for row in connection.execute('PRAGMA table_info(Item)')}:
        connection.execute('ALTER TABLE Item ADD COLUMN readyFolderPath TEXT')
    connection.execute('''CREATE TABLE IF NOT EXISTS Photo(
        id INTEGER PRIMARY KEY,itemId INTEGER,storedPath TEXT,sha256 TEXT,rotation INTEGER,
        isCover INTEGER,sortOrder INTEGER,includeInListing INTEGER,isMarker INTEGER)''')
    for index, photo in enumerate(item['photos']):
        connection.execute('INSERT INTO Photo VALUES(?,?,?,?,?,?,?,?,?)',
            (index + 1, item['itemId'], photo['path'], hashlib.sha256(Path(photo['path']).read_bytes()).hexdigest(),
             0, int(index == 0), index, 1, 0))
    return prepare_current_photos(connection, root, item)


def prepare_current_photos(connection, root, item):
    directory = Path(root) / ('prepared-' + uuid4().hex)
    recipe = recipe_from_database(connection, item['itemId'], item['sku'])
    spec = {'sku': item['sku'], 'itemId': item['itemId'], 'readyDir': str(directory), 'photoRecipe': recipe,
            'listingPhotos': [{'src': entry['sourcePath'], 'destName': entry['name'], 'rotation': entry['rotation']} for entry in recipe]}
    with contextlib.redirect_stdout(io.StringIO()):
        importlib.import_module('black_cat_worker.export').run(spec)
    item['photoSnapshot'] = json.loads((directory / 'item.json').read_text())['photoSnapshot']
    item['photos'] = [{'name': entry['name'], 'path': str(directory / 'listing_photos' / entry['name'])} for entry in recipe]
    connection.execute('UPDATE Item SET readyFolderPath=? WHERE id=?', (str(directory), item['itemId']))
    connection.commit()
    return directory
