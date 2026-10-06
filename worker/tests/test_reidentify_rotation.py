"""Native image bytes at the retry boundary; no model, OCR engine or DB is started."""
import base64
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from PIL import Image, ImageChops, ImageDraw, ImageOps, ImageStat

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import managed_vision, reenrich_batch, tag_ocr
from black_cat_worker.ocr_engine import OcrLine


class Client:
    def __init__(self): self.images = []
    def ask(self, messages, **_options):
        self.images = [Image.open(io.BytesIO(base64.b64decode(part['image_url']['url'].split(',', 1)[1]))).convert('RGB')
                       for part in messages[0]['content'] if part['type'] == 'image_url']
        return '{"itemType":"Shirt","brand":"Reference","size":"M"}', {}


class ReidentifyRotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='blackcat-ai-rotation-')
        self.root = Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temp.cleanup)
        self.image = Image.new('RGB', (96, 64), 'red')
        draw = ImageDraw.Draw(self.image)
        draw.rectangle((48, 0, 95, 31), fill='lime')
        draw.rectangle((0, 32, 47, 63), fill='blue')
        draw.rectangle((48, 32, 95, 63), fill='yellow')
        self.path = self.root / 'tag.jpg'
        self.image.save(self.path, quality=98, subsampling=0)

    def photo(self, rotation=None):
        value = {'photoId': 1, 'storedPath': str(self.path), 'isMarker': False,
                 'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}
        if rotation is not None: value['rotation'] = rotation
        return value

    def assert_pixels(self, actual, expected):
        self.assertEqual(actual.size, expected.size)
        self.assertLess(max(ImageStat.Stat(ImageChops.difference(actual, expected)).mean), 7)

    def test_managed_vision_applies_saved_clockwise_rotation_after_exif(self):
        for exif_orientation in range(1, 9):
            exif = Image.Exif(); exif[274] = exif_orientation
            self.image.save(self.path, quality=98, subsampling=0, exif=exif)
            original = self.path.read_bytes()
            for rotation in [0, 90, 180, 270]:
                with self.subTest(exif=exif_orientation, rotation=rotation):
                    client = Client()
                    result = managed_vision.ManagedVisionEnricher({'visionEnabled': True}, client).enrich('ROTATE', [self.photo(rotation)])
                    self.assertNotIn('error', result)
                    with Image.open(self.path) as image:
                        expected = ImageOps.exif_transpose(image).convert('RGB').rotate(-rotation, expand=True)
                    self.assert_pixels(client.images[0], expected)
                    self.assertEqual(self.path.read_bytes(), original)

    def test_batch_passes_the_same_reviewed_orientation_to_ocr_and_vision(self):
        import cv2
        client = Client(); ocr_images = []
        @contextlib.contextmanager
        def session(_label): yield client
        def read(image, _engine):
            ocr_images.append(Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
            return [OcrLine('100% COTTON', confidence=0.99)]
        spec = {'items': [{'requestId': 'one', 'sku': 'ROTATE', 'photos': [self.photo(90)]}]}
        original = self.path.read_bytes()
        with mock.patch.object(tag_ocr.ocr_engine, 'shared_engine', return_value=object()), \
             mock.patch.object(tag_ocr.ocr_engine, 'read_lines', side_effect=read):
            result = reenrich_batch.run_batch(reenrich_batch.validate_batch_spec(spec),
                settings={'visionEnabled': True, 'tagOcrEnabled': True, 'processingPath': str(self.root)}, session_factory=session)
        with Image.open(self.path) as image: expected = image.convert('RGB').rotate(-90, expand=True)
        self.assert_pixels(ocr_images[0], expected)
        self.assert_pixels(client.images[0], expected)
        self.assertEqual(result['items'][0]['enrichment']['raw']['ocr']['photosRead'], [str(self.path)])
        self.assertEqual(self.path.read_bytes(), original)

    def test_large_exif_tag_is_oriented_within_the_existing_pixel_budget(self):
        import cv2
        image = self.image.resize((1920, 1280), Image.Resampling.NEAREST)
        exif = Image.Exif(); exif[274] = 6
        image.save(self.path, quality=98, subsampling=0, exif=exif)
        original = self.path.read_bytes()
        client = Client()
        managed_vision.ManagedVisionEnricher({'visionEnabled': True}, client).enrich('ROTATE', [self.photo(270)])
        ocr = Image.fromarray(cv2.cvtColor(tag_ocr._load_for_ocr(str(self.path), rotation=270), cv2.COLOR_BGR2RGB))
        with Image.open(self.path) as image:
            expected = ImageOps.exif_transpose(image).convert('RGB').rotate(-270, expand=True).resize((1024, 683), Image.Resampling.BOX)
        self.assert_pixels(client.images[0], expected)
        self.assert_pixels(ocr, expected)
        self.assertEqual(self.path.read_bytes(), original)

    def test_protocol_accepts_optional_quarter_turns_and_rejects_other_values(self):
        def validate(photo):
            return reenrich_batch.validate_batch_spec({'items': [{'requestId': 'one', 'sku': 'ROTATE', 'photos': [photo]}]})
        self.assertNotIn('rotation', validate(self.photo())[0]['photos'][0])
        for angle in [0, 90, 180, 270]:
            self.assertEqual(validate(self.photo(angle))[0]['photos'][0]['rotation'], angle)
        for angle in [-90, 45, 360, True, '90', None]:
            with self.subTest(angle=angle), self.assertRaises(ValueError):
                validate({**self.photo(), 'rotation': angle})
        with self.assertRaises(ValueError): validate({**self.photo(), 'rotation': 90, 'model': 'override'})

    def test_rotated_ocr_never_falls_back_to_an_unrotated_path(self):
        missing = str(self.root / 'missing.jpg')
        with self.assertRaises(ValueError): tag_ocr._load_for_ocr(missing, rotation=45)
        with self.assertRaises(Exception): tag_ocr._load_for_ocr(missing, rotation=90)
        self.assertEqual(tag_ocr._load_for_ocr(missing), missing)


if __name__ == '__main__': unittest.main()
