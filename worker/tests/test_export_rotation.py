import contextlib
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
export = importlib.import_module('black_cat_worker.export')


class ExportRotationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='blackcat-export-rotation-')
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source.png'
        image = Image.new('RGB', (80, 40), 'blue')
        ImageDraw.Draw(image).rectangle((0, 0, 39, 39), fill='red')
        image.save(self.source)
        self.original = self.source.read_bytes()
        self.ready = self.root / 'ready'

    def tearDown(self):
        self.temporary.cleanup()

    def spec(self, rotation=90, suffix='.png'):
        return {'sku': 'ROTATE', 'readyDir': str(self.ready),
                'listingPhotos': [{'src': str(self.source), 'destName': f'ROTATE_01{suffix}', 'rotation': rotation}]}

    def test_clockwise_rotation_and_real_format_match_the_export_filename(self):
        for suffix, expected_format in [('.png', 'PNG'), ('.jpg', 'JPEG'), ('.webp', 'WEBP')]:
            with self.subTest(suffix=suffix), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(export.run(self.spec(suffix=suffix)), 0)
                self.assertTrue(json.loads(output.getvalue())['ok'])
                with Image.open(self.ready / f'listing_photos/ROTATE_01{suffix}') as rotated:
                    self.assertEqual(rotated.format, expected_format)
                    self.assertEqual(rotated.size, (40, 80))
                    self.assertGreater(rotated.getpixel((20, 15))[0], 220)
                    self.assertGreater(rotated.getpixel((20, 65))[2], 220)
                self.assertEqual(self.source.read_bytes(), self.original)

    def test_rotation_failure_preserves_previous_photos_and_metadata_without_success_receipt(self):
        folder = self.ready / 'listing_photos'; folder.mkdir(parents=True)
        previous = folder / 'ROTATE_01.png'; previous.write_bytes(b'previous cover')
        stale = folder / 'ROTATE_02.png'; stale.write_bytes(b'previous second photo')
        metadata = self.ready / 'item.json'; metadata.write_text('{"previous":true}')
        with patch.object(Image.Image, 'rotate', side_effect=RuntimeError('injected rotation failure')):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaisesRegex(RuntimeError, 'injected rotation failure'):
                    export.run(self.spec())
                self.assertEqual(output.getvalue(), '')
        self.assertEqual(previous.read_bytes(), b'previous cover')
        self.assertEqual(stale.read_bytes(), b'previous second photo')
        self.assertEqual(metadata.read_text(), '{"previous":true}')
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_corrupt_image_does_not_become_a_successful_rotated_export(self):
        self.source.write_bytes(b'not an image')
        with self.assertRaises(OSError):
            export.run(self.spec())
        self.assertFalse((self.ready / 'listing_photos/ROTATE_01.png').exists())

    def test_invalid_rotation_is_rejected_instead_of_truncated_or_ignored(self):
        for rotation in [45, 90.5, -90, '90', True, None]:
            with self.subTest(rotation=rotation), self.assertRaisesRegex(ValueError, 'Photo rotation'):
                export.run(self.spec(rotation=rotation))
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertFalse((self.ready / 'listing_photos/ROTATE_01.png').exists())

    def test_zero_rotation_keeps_original_bytes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            export.run(self.spec(rotation=0))
        self.assertEqual((self.ready / 'listing_photos/ROTATE_01.png').read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
