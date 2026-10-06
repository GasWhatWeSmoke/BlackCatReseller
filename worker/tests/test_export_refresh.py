import importlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
export = importlib.import_module('black_cat_worker.export')


class ExportRefreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root/'source.jpg'; self.source.write_bytes(b'original source')
        self.ready = self.root/'ready'; self.listing = self.ready/'listing_photos'; self.listing.mkdir(parents=True)

    def tearDown(self): self.temporary.cleanup()

    def spec(self):
        return {'sku':'000001','readyDir':str(self.ready),'listingPhotos':[{'src':str(self.source),'destName':'000001_01.jpg'}],
                'itemJson':{'listingPhotos':['listing_photos/000001_01.jpg']}}

    def test_smaller_export_archives_stale_photos_and_preserves_originals(self):
        (self.listing/'000001_02.jpg').write_bytes(b'old second photo')
        export.run(self.spec())
        self.assertEqual([p.name for p in self.listing.iterdir()],['000001_01.jpg'])
        archived=list((self.ready/'internal/superseded-exports').rglob('000001_02.jpg'))
        self.assertEqual(len(archived),1);self.assertEqual(archived[0].read_bytes(),b'old second photo')
        self.assertEqual(self.source.read_bytes(),b'original source')

    def test_changed_extension_does_not_leave_two_copies_of_photo_one(self):
        (self.listing/'000001_01.png').write_bytes(b'old png')
        export.run(self.spec())
        self.assertEqual([p.name for p in self.listing.iterdir()],['000001_01.jpg'])

    def test_failed_copy_does_not_archive_previous_export(self):
        (self.listing/'000001_01.jpg').write_bytes(b'previous cover')
        (self.listing/'000001_02.jpg').write_bytes(b'keep old export')
        spec=self.spec();spec['listingPhotos'].append({'src':str(self.root/'missing.jpg'),'destName':'000001_02.jpg'})
        with self.assertRaises(FileNotFoundError): export.run(spec)
        self.assertEqual((self.listing/'000001_01.jpg').read_bytes(),b'previous cover')
        self.assertTrue((self.listing/'000001_02.jpg').exists())
        self.assertFalse((self.ready/'internal/superseded-exports').exists())

    def test_foreign_files_are_not_silently_removed(self):
        (self.listing/'000002_01.jpg').write_bytes(b'foreign')
        export.run(self.spec())
        self.assertTrue((self.listing/'000002_01.jpg').exists())

    def test_duplicate_or_escaping_names_are_rejected_before_writing(self):
        for name in ('../outside.jpg','000002_01.jpg'):
            spec=self.spec();spec['listingPhotos'][0]['destName']=name
            with self.assertRaises(ValueError):export.run(spec)
        spec=self.spec();spec['listingPhotos']*=2
        with self.assertRaises(ValueError):export.run(spec)
        self.assertEqual(list(self.listing.iterdir()),[])

    def test_empty_selection_cannot_remove_existing_export(self):
        (self.listing/'000001_01.jpg').write_bytes(b'previous cover')
        spec=self.spec();spec['listingPhotos']=[]
        with self.assertRaises(ValueError):export.run(spec)
        self.assertEqual((self.listing/'000001_01.jpg').read_bytes(),b'previous cover')


if __name__=='__main__':unittest.main()
