"""Owned camera-batch fixture: EXIF order intentionally opposes filename order."""
import argparse
import hashlib
import json
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw
import qrcode


def generate(folder: Path, count: int):
    folder = folder.resolve()
    if (folder.parent != Path(tempfile.gettempdir()).resolve()
            or not folder.name.startswith('blackcat-workflow-')
            or not json.loads((folder / 'fixture-owner.json').read_text())['fixture']):
        raise ValueError('An explicitly owned workflow fixture is required')
    if count not in (50, 100):
        raise ValueError('Use 50 or 100 items')
    camera = folder / 'camera'
    camera.mkdir()
    files = []
    for item in range(1, count + 1):
        sku = str(900000 + item)
        for angle in range(4):
            sequence = (item - 1) * 4 + angle
            image = Image.new('RGB', (900, 1200), (70 + item % 120, 60 + angle * 40, 160))
            if angle == 3:
                image = Image.new('RGB', (900, 1200), 'white')
                qr = qrcode.make('BC-' + sku).convert('RGB').resize((700, 700), Image.Resampling.NEAREST)
                image.paste(qr, (100, 250))
            else:
                draw = ImageDraw.Draw(image)
                draw.text((60, 80), f'SYNTHETIC GARMENT {sku}\nView {angle + 1}', fill='white')
                draw.rectangle((130 + angle * 15, 230, 740, 990), outline='white', width=12)
            exif = Image.Exif()
            exif[36867] = (datetime(2026, 9, 1, 10) + timedelta(seconds=sequence * 2)).strftime('%Y:%m:%d %H:%M:%S')
            filename = f'IMG_{count * 4 - sequence:04}.jpg'
            destination = camera / filename
            image.save(destination, quality=90, exif=exif)
            files.append({'filename': filename, 'sku': sku, 'angle': angle, 'marker': angle == 3,
                          'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})
    result = {'items': count, 'files': files, 'dimensions': [900, 1200], 'ordering': 'exif',
              'listingPhotosPerItem': 3, 'markersPerItem': 1}
    (folder / 'camera-manifest.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'items': count, 'photos': len(files), 'markers': count}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('count', type=int)
    args = parser.parse_args()
    generate(args.folder, args.count)
