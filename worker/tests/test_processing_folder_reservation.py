"""Fresh folders protect retained photos and incomplete attempts during intake."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import process


class ProcessingFolderReservationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="blackcat-reserved-photos-")
        self.root = Path(self.directory.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("blackcat-reserved-photos-"))
        self.addCleanup(self.directory.cleanup)
        self.batch = "20260919-200000"

    def test_a_new_item_cannot_reuse_a_retained_sku_folder(self):
        retained = self.root / "000001"
        retained.mkdir()
        image = retained / "000001_01.jpg"
        image.write_bytes(b"photo still referenced by another item")
        collision, folder = process._processing_target("000001", self.batch, str(self.root), set(), set(), {}, create=True)
        self.assertFalse(collision)
        self.assertNotEqual(retained, Path(folder))
        self.assertTrue(Path(folder).is_dir())
        self.assertRegex(Path(folder).name, r"^000001__intake-20260919-200000-[a-f0-9]{32}$")
        self.assertEqual(b"photo still referenced by another item", image.read_bytes())

    def test_repeated_collision_groups_keep_separate_reserved_folders(self):
        existing, emitted, ordinals = {"000001"}, set(), {}
        folders = [process._processing_target("000001", self.batch, str(self.root), existing, emitted, ordinals, create=True)
                   for _ in range(3)]
        self.assertTrue(all(collision for collision, _ in folders))
        self.assertEqual(3, len({folder for _, folder in folders}))
        for index, (_, folder) in enumerate(folders, 1):
            suffix = "" if index == 1 else f"__{index}"
            self.assertRegex(Path(folder).name, rf"^000001__incoming-{self.batch}{suffix}-[a-f0-9]{{32}}$")

    def test_same_second_parallel_attempts_never_share_a_directory(self):
        def reserve(_index):
            return process._processing_target("000001", self.batch, str(self.root), set(), set(), {}, create=True)[1]
        with ThreadPoolExecutor(max_workers=8) as pool:
            folders = list(pool.map(reserve, range(16)))
        self.assertEqual(16, len(set(folders)))
        self.assertTrue(all(Path(folder).is_dir() and Path(folder).parent == self.root for folder in folders))

    def test_an_existing_reservation_is_preserved_and_a_fresh_name_is_tried(self):
        prefix = f"000001__intake-{self.batch}-"
        previous = self.root / (prefix + "0" * 32)
        previous.mkdir()
        (previous / "photo.jpg").write_bytes(b"incomplete previous attempt")
        with patch.object(process, "uuid4", side_effect=[SimpleNamespace(hex="0" * 32), SimpleNamespace(hex="1" * 32)]) as token:
            actual = process._reserve_processing_folder(str(self.root), prefix)
        self.assertEqual(self.root / (prefix + "1" * 32), Path(actual))
        self.assertEqual(2, token.call_count)
        self.assertEqual(b"incomplete previous attempt", (previous / "photo.jpg").read_bytes())

    def test_repeated_name_collisions_fail_without_reusing_the_existing_folder(self):
        prefix = f"000001__intake-{self.batch}-"
        previous = self.root / (prefix + "0" * 32)
        previous.mkdir()
        with patch.object(process, "uuid4", return_value=SimpleNamespace(hex="0" * 32)) as token:
            with self.assertRaisesRegex(RuntimeError, "Could not reserve"):
                process._reserve_processing_folder(str(self.root), prefix)
        self.assertEqual(10, token.call_count)
        self.assertEqual([previous], list(self.root.iterdir()))

    def test_dry_run_keeps_its_non_mutating_directory_preview(self):
        with patch.object(process, "_reserve_processing_folder") as reserve:
            collision, folder = process._processing_target("000001", self.batch, str(self.root), set(), set(), {}, create=False)
        self.assertFalse(collision)
        self.assertEqual(self.root / "000001", Path(folder))
        self.assertEqual([], list(self.root.iterdir()))
        reserve.assert_not_called()


if __name__ == "__main__": unittest.main()
