"""Real local JPEG -> OpenCV QR -> grouping -> durable worker receipt tests.

Printed OCR accuracy remains unverified: these use synthetic encoded markers.
"""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import process, decode, intake_manifest


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="blackcat-pipeline-")
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()
        self.settings={key:str(self.root/folder) for key,folder in [
            ("incomingPath","incoming"),("processingPath","processing"),("needsReviewPath","review"),
            ("archivePath","archive"),("readyPath","ready"),("exportsPath","exports"),("logsPath","logs"),("backupsPath","backups")]}
        self.settings.update(dataRoot=str(self.root),visionEnabled=False,ocrEnabled=False,fileStabilitySeconds=0)
        self.incoming=Path(self.settings["incomingPath"]);self.incoming.mkdir()
        self.job=self.root/"intake-jobs"/"job-fixture";self.job.mkdir(parents=True)
        self.db=self.root/"fixture.db"
        with sqlite3.connect(str(self.db)) as db:
            db.executescript("CREATE TABLE AppSettings(id INTEGER,data TEXT);CREATE TABLE Item(sku TEXT);CREATE TABLE FileHash(sha256 TEXT);")
            db.execute("INSERT INTO AppSettings VALUES(1,?)",(json.dumps(self.settings),))
        self.env={"BLACKCAT_DB_PATH":str(self.db),"BLACKCAT_DATA_ROOT":str(self.root),
                  "BLACKCAT_INTAKE_JOB_DIR":str(self.job),"BLACKCAT_INTAKE_JOB_ID":"job-fixture"}

    def photo(self,index,sku=None):
        from PIL import Image, ImageDraw
        import qrcode
        source=self.incoming/f"IMG_{index:04d}.jpg"
        if sku:
            qr=qrcode.make(sku).convert("RGB")
            image=Image.new("RGB",(qr.width+80,qr.height+120),"white")
            image.paste(qr,(40,40))
            ImageDraw.Draw(image).text((40,qr.height+65),sku,fill="black")
        else:
            image=Image.new("RGB",(240,320),(index%250,40,100))
            ImageDraw.Draw(image).text((20,20),f"garment photograph {index}",fill="white")
        image.save(source,quality=95)
        return source

    def run_worker(self):
        output=StringIO()
        with mock.patch.dict(os.environ,self.env),redirect_stdout(output):
            code=process.main([])
        events=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(code,0,events[-1])
        return events[-1]["payload"]

    def test_actual_200_jpeg_batch_and_completed_detection_resume(self):
        for i in range(200):self.photo(i,f"BC-{i//5+1:06d}" if i%5==4 else None)
        result=self.run_worker()
        self.assertEqual(len(result["items"]),40)
        self.assertEqual(result["counts"]["photosProcessed"],200)
        self.assertEqual(len(list(self.incoming.glob("*.jpg"))),200)  # Node archives only after commit.
        self.assertEqual(len(list((self.job/"sources").glob("*.jpg"))),200)
        self.assertEqual(json.loads((self.job/"result-revision.json").read_text()),{"revision":0})
        self.assertEqual(json.loads((self.job/"result.json").read_text())["batchId"],"job-fixture")
        for item in result["items"]:
            self.assertEqual(len(item["photos"]),5)
            self.assertTrue(item["photos"][-1]["isMarker"])
            self.assertFalse(item["photos"][-1]["includeInListing"])
            self.assertTrue(Path(item["photos"][-1]["storedPath"]).is_file())
        verification=json.loads((self.job/"verification.json").read_text())
        self.assertEqual(len(verification["groups"]),40)
        # Retry consumes immutable manifest and all completed decode checkpoints.
        with mock.patch.object(decode.Decoder,"decode",side_effect=AssertionError("completed OCR must not rerun")):
            resumed=self.run_worker()
        self.assertEqual([i["sku"] for i in resumed["items"]],[i["sku"] for i in result["items"]])

    def test_oversized_range_remains_accessible_and_clean_group_continues(self):
        for i in range(38):self.photo(i,"BC-000042" if i==32 else "BC-000043" if i==36 else None)
        before={p.name:p.read_bytes() for p in self.incoming.glob("*.jpg")}
        result=self.run_worker()
        self.assertEqual([i["sku"] for i in result["items"]],["BC-000043"])
        self.assertEqual(len(result["needsReview"]),34)
        self.assertEqual({p.name:p.read_bytes() for p in self.incoming.glob("*.jpg")},before)
        self.assertTrue(any(p["type"]=="OVERSIZED_GROUP" for p in result["problems"]))

    def test_committed_group_with_historical_correction_does_not_block_retry(self):
        self.photo(0);self.photo(1,"BC-000042");self.photo(2)
        first=self.run_worker()
        verification=json.loads((self.job/"verification.json").read_text())
        group=verification["groups"][0]
        intake_manifest.atomic_json(self.job/"committed.json",{"revision":1,"groups":[group]})
        intake_manifest.atomic_json(self.job/"corrections.json",{"revision":2,"markers":{group["markerPhotoId"]:"BC-000042"}})
        # Simulate the server's successful commit/archive of the verified group.
        archive=self.root/"archive";archive.mkdir(exist_ok=True)
        for source in first["items"][0]["originalPaths"]:
            Path(source).rename(archive/Path(source).name)
        result=self.run_worker()
        self.assertEqual(result["items"],[])
        self.assertEqual(len(result["needsReview"]),1)
        self.assertTrue(all(Path(p["storedPath"]).is_file() for p in json.loads((self.job/"manifest.json").read_text())["photos"]))

    def test_missing_original_restores_verified_snapshot_without_reupload(self):
        original=self.photo(0)
        expected=original.read_bytes()
        self.run_worker()  # unresolved photo still has a durable batch snapshot
        original.unlink()
        result=self.run_worker()
        self.assertEqual(original.read_bytes(),expected)
        self.assertEqual(len(result["needsReview"]),1)

    def test_changed_existing_original_is_never_replaced(self):
        original=self.photo(0)
        self.run_worker()
        original.write_bytes(b"new different bytes")
        with mock.patch.dict(os.environ,self.env),redirect_stdout(StringIO()):
            with self.assertRaises(RuntimeError):
                process.run(SimpleNamespace(incoming=None,dry_run=False),cancel_check=lambda:None)
        self.assertEqual(original.read_bytes(),b"new different bytes")

    def test_corrupt_snapshot_cannot_restore_missing_original(self):
        original=self.photo(0)
        self.run_worker()
        frozen=json.loads((self.job/"manifest.json").read_text())["photos"][0]
        original.unlink()
        Path(frozen["storedPath"]).write_bytes(b"damaged snapshot")
        with self.assertRaisesRegex(RuntimeError,"Reselect this original photo"):
            intake_manifest.existing_workset(self.job,str(self.incoming))
        self.assertFalse(original.exists())

    def test_snapshot_cannot_restore_outside_current_incoming_folder(self):
        original=self.photo(0)
        self.run_worker()
        frozen=json.loads((self.job/"manifest.json").read_text())
        frozen["photos"][0]["originalPath"]=str(self.root/"outside.jpg")
        intake_manifest.atomic_json(self.job/"manifest.json",frozen)
        with self.assertRaisesRegex(RuntimeError,"outside the current Incoming"):
            intake_manifest.existing_workset(self.job,str(self.incoming))
        self.assertFalse((self.root/"outside.jpg").exists())



if __name__=="__main__":unittest.main()
