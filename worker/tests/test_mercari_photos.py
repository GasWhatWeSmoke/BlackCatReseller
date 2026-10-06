from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import contextmanager
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.mercari_photos import upload_photo_copies
from black_cat_worker import post_mercari


class MercariPhotoCopyTests(unittest.TestCase):
    def test_cleanup_error_preserves_known_publication_instead_of_permitting_retry(self):
        @contextmanager
        def broken_cleanup(photos):
            yield photos
            raise RuntimeError('Cleanup failed')
        published={'outcome':'posted','submissionStarted':True,'url':'https://www.mercari.com/us/item/m12345678901/'}
        with patch.object(post_mercari,'upload_photo_copies',broken_cleanup),patch.object(post_mercari,'_run_on_page',return_value=published):
            result=post_mercari.run_on_page(None,{},[],{}, {},'post',lambda:None)
        self.assertEqual(result['outcome'],'posted');self.assertTrue(result['submissionStarted'])
        self.assertEqual(result['url'],published['url'])

    def test_oversized_copy_keeps_dimensions_order_and_original_bytes_then_cleans_up(self):
        with tempfile.TemporaryDirectory() as folder:
            small=Path(folder,'small.jpg');large=Path(folder,'large.jpg')
            Image.new('RGB',(16,16),'blue').save(small)
            Image.effect_noise((256,256),75).convert('RGB').save(large,quality=100,subsampling=0)
            original=large.read_bytes();limit=len(original)-1
            with upload_photo_copies([small,large],max_bytes=limit) as prepared:
                self.assertEqual(prepared[0],str(small))
                copy=Path(prepared[1]);self.assertNotEqual(copy,large)
                self.assertLessEqual(copy.stat().st_size,limit)
                with Image.open(copy) as image:self.assertEqual(image.size,(256,256))
                self.assertEqual(large.read_bytes(),original)
            self.assertFalse(copy.exists());self.assertTrue(small.exists());self.assertEqual(large.read_bytes(),original)

    def test_unverified_copy_is_rejected_without_changing_the_original(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder,'photo.jpg');Image.new('RGB',(80,80),'blue').save(source,quality=100)
            original=source.read_bytes()
            with patch('black_cat_worker.mercari_native_form.image_matches',return_value=False):
                with self.assertRaisesRegex(ValueError,'verified image fidelity'):
                    with upload_photo_copies([source],max_bytes=len(original)-1):self.fail('Must not yield an unverified copy')
            self.assertEqual(source.read_bytes(),original)
