import ast
import copy
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import photo_snapshot
from black_cat_worker.publish_guard import assert_publish_authorized
from photo_snapshot_fixture import attach_photo_snapshot, prepare_current_photos


class PhotoSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='blackcat-photo-snapshot-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / 'test.db'
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        self.db.executescript("""
          CREATE TABLE Item(id INTEGER,sku TEXT,status TEXT);
          CREATE TABLE PublishRun(id INTEGER,status TEXT);
          CREATE TABLE PublishJob(itemId INTEGER,marketplace TEXT,runId INTEGER,status TEXT);
          CREATE TABLE MarketplaceListing(itemId INTEGER,marketplace TEXT,status TEXT);
          INSERT INTO Item VALUES(1,'SNAP','Ready'); INSERT INTO PublishRun VALUES(1,'running');
        """)
        for market in ['depop', 'ebay', 'etsy', 'poshmark', 'mercari']:
            self.db.execute('INSERT INTO PublishJob VALUES(1,?,1,?)', (market, 'publishing'))
            self.db.execute('INSERT INTO MarketplaceListing VALUES(1,?,?)', (market, 'unknown'))
        self.item = {'itemId': 1, 'sku': 'SNAP', 'photos': []}
        for index, color in enumerate(['red', 'blue'], 1):
            filename = self.root / f'source-{index}.png'
            Image.new('RGB', (40, 20), color).save(filename)
            self.item['photos'].append({'name': filename.name, 'path': str(filename)})
        attach_photo_snapshot(self.db, self.root, self.item)

    def authorize(self, market='depop', item=None):
        item = item or self.item
        assert_publish_authorized(1, 'SNAP', market, self.database,
            photo_snapshot=item.get('photoSnapshot'), photo_paths=[p['path'] for p in item['photos']])

    def test_current_snapshot_is_authorized_on_every_marketplace(self):
        for market in ['depop', 'ebay', 'etsy', 'poshmark', 'mercari']:
            with self.subTest(market=market): self.authorize(market)

    def test_same_count_edits_and_empty_selection_invalidate_publication(self):
        for sql in ['UPDATE Photo SET rotation=90', 'UPDATE Photo SET isCover=1-isCover',
                    'UPDATE Photo SET isCover=0,sortOrder=-sortOrder', 'UPDATE Photo SET includeInListing=0',
                    'UPDATE Photo SET itemId=2 WHERE id=1', "UPDATE Photo SET sha256='changed'"]:
            with self.subTest(sql=sql):
                self.db.execute('SAVEPOINT edit'); self.db.execute(sql); self.db.commit()
                with self.assertRaisesRegex(ValueError, 'Prepared photos'): self.authorize()
                # Restore only the synthetic rows to test another independent edit.
                self.db.execute('UPDATE Photo SET rotation=0,isCover=(id=1),sortOrder=id-1,includeInListing=1,itemId=1')
                for entry in self.item['photoSnapshot']['recipe']:
                    self.db.execute('UPDATE Photo SET sha256=? WHERE id=?', (entry['sourceHash'], entry['id']))
                self.db.commit()

    def test_changed_bytes_are_rejected_even_when_file_size_and_timestamp_are_preserved(self):
        for filename in [self.item['photoSnapshot']['recipe'][0]['sourcePath'], self.item['photos'][0]['path']]:
            with self.subTest(path=filename):
                target = Path(filename); original = target.read_bytes(); stamp = target.stat()
                target.write_bytes(bytes(byte ^ 1 for byte in original))
                os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                with self.assertRaisesRegex(ValueError, 'Prepared photos'): self.authorize()
                target.write_bytes(original); os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))

    def test_reapproval_keeps_old_export_bytes_but_revokes_the_previous_snapshot(self):
        previous = copy.deepcopy(self.item)
        originals = {p['path']: Path(p['path']).read_bytes() for p in previous['photos']}
        self.db.execute('UPDATE Photo SET rotation=90'); self.db.commit()
        prepare_current_photos(self.db, self.root, self.item)
        self.authorize()
        with self.assertRaisesRegex(ValueError, 'Prepared photos'): self.authorize(item=previous)
        for filename, content in originals.items(): self.assertEqual(Path(filename).read_bytes(), content)

    def test_legacy_receipts_and_reordered_upload_paths_are_not_automatic_post_authority(self):
        for item in [{**self.item, 'photoSnapshot': None}, {**self.item, 'photos': self.item['photos'][::-1]}]:
            with self.assertRaisesRegex(ValueError, 'Prepared photos'): self.authorize(item=item)

    def test_changes_during_hashing_are_rechecked_before_returning_authority(self):
        original = photo_snapshot.file_receipt
        changed = False
        def read(filename):
            nonlocal changed
            receipt = original(filename)
            if not changed:
                changed = True; self.db.execute('UPDATE Photo SET rotation=90'); self.db.commit()
            return receipt
        with patch.object(photo_snapshot, 'file_receipt', side_effect=read):
            with self.assertRaisesRegex(ValueError, 'Prepared photos'): self.authorize()

    def test_every_native_posting_call_explicitly_requires_the_snapshot_and_upload_paths(self):
        root = Path(__file__).resolve().parents[1] / 'black_cat_worker'
        for market in ['depop', 'ebay', 'etsy', 'poshmark', 'mercari']:
            tree = ast.parse((root / f'post_{market}.py').read_text(encoding='utf-8'))
            calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                     and node.func.id == 'assert_publish_authorized']
            self.assertTrue(calls, market)
            for call in calls: self.assertTrue({'photo_snapshot', 'photo_paths'} <= {keyword.arg for keyword in call.keywords})


if __name__ == '__main__': unittest.main()
