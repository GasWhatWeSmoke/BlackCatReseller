"""Reliability regressions: real synthetic JPEG I/O plus deterministic OCR doubles.

No synthetic test establishes recognition accuracy on the absent beta images.
"""
from dataclasses import asdict
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker import decode, dedup, intake_manifest as manifest, regions, sku, tag_ocr, props
from black_cat_worker.grouping import DecodedPhoto, group_photos
from black_cat_worker.exif_sort import order_photos
from black_cat_worker.ocr_engine import OcrLine, extract_lines


def photo(index, value=None, **kwargs):
    return DecodedPhoto(f"/incoming/IMG_{index}.jpg", f"IMG_{index}.jpg", sku=value,
                        photo_id=str(index), sequence_index=index, **kwargs)


class MarkerTests(unittest.TestCase):
    def test_exact_candidate_preserves_prefix(self):
        for value in ("BC-000042", " bc – 000042 ", "BC-00 00 42"):
            self.assertEqual(sku.normalize(value), "BC-000042")
        for value in ("000042", "SKU: 000042", "SKU: BC-000042", "ABC-000042", "BC-00004299", "XBC-000042", "BC-00004O", "BC-12345", "MODEL 123456", "12.3456", "W32 L30", "BC-000042 END"):
            self.assertIsNone(sku.coerce_to_sku(value), value)

    def decoder(self, lines, physical=True, qrs=()):
        worker = decode.Decoder({"ocrSmartGate": True})
        worker._qr = mock.Mock()
        worker._paddle = object()
        context = mock.patch.multiple(worker, _load_work_image=mock.Mock(return_value=object()),
                                      _ensure_pyzbar=mock.Mock(return_value=False),
                                      _opencv_qr=mock.Mock(return_value=list(qrs)),
                                      _qr_pattern_present=mock.Mock(return_value=False))
        with context, mock.patch.object(decode.ocr_engine, "read_lines", return_value=lines), mock.patch.object(regions, "sticker_context", return_value=physical):
            return worker.decode("mixed.jpg")

    def test_printed_sticker_does_not_need_qr_pattern(self):
        outcome = self.decoder([OcrLine("BC-000042", .99, (10,10,200,40)), OcrLine("JAMES PERSE", .99, (200,200,400,250))])
        self.assertEqual(outcome.sku, "BC-000042")
        self.assertEqual(outcome.method, "ocr")
        self.assertFalse(outcome.qr_pattern_detected)

    def test_syntax_without_context_does_not_establish_boundary(self):
        self.assertIsNone(self.decoder([OcrLine("BC-000042", .99)], physical=False).sku)
        self.assertIsNone(self.decoder([OcrLine("BC-000042", .70)], physical=True).sku)

    def test_conflicting_candidates_quarantine(self):
        result = self.decoder([OcrLine("BC-000042", .99), OcrLine("BC-000043", .99)])
        self.assertIsNone(result.sku)
        self.assertIn("multiple", result.review_reason)

    def test_qr_requires_strict_complete_inventory_value(self):
        self.assertIsNone(self.decoder([], qrs=["000042"]).sku)
        self.assertEqual(self.decoder([], qrs=["BC-000042"]).sku, "BC-000042")
        self.assertIsNone(self.decoder([], qrs=["BC-000042", "BC-000043"]).sku)

    def test_character_ambiguity_does_not_invent_digits(self):
        outcome = self.decoder([OcrLine("BC-00004O", .99)])
        self.assertIsNone(outcome.sku)
        self.assertTrue(outcome.review_reason)


class GroupingTests(unittest.TestCase):
    def test_200_photos_end_markers_close_preceding_items(self):
        photos = [photo(i, f"BC-{i//5:06d}" if i % 5 == 4 else None) for i in range(200)]
        result = group_photos(photos)
        self.assertEqual(len(result.items), 40)
        self.assertFalse(result.needs_review)
        self.assertEqual([p.photo_id for p in result.items[0].members], ["0","1","2","3"])
        self.assertEqual(result.items[0].marker.photo_id, "4")
        self.assertEqual(result.items[1].members[0].photo_id, "5")

    def test_exact_32_photo_cap_includes_terminal_marker(self):
        result = group_photos([photo(i) for i in range(31)] + [photo(31,"BC-000042")])
        self.assertEqual(len(result.items), 1)
        result = group_photos([photo(i) for i in range(32)] + [photo(32,"BC-000042"), photo(33),photo(34,"BC-000043")])
        self.assertEqual([item.sku for item in result.items], ["BC-000043"])
        self.assertEqual(len(result.needs_review), 33)
        self.assertIn("32-photo", result.problems[0].message)

    def test_thousand_reference_batch_has_no_batch_wide_cap(self):
        result = group_photos([photo(i, f"BC-{i//5:06d}" if i%5==4 else None) for i in range(1000)])
        self.assertEqual(len(result.items),200)

    def test_unknown_marker_quarantines_through_next_verified_boundary(self):
        photos = [photo(0),photo(1, marker_review_reason="BC-00004O"),photo(2),photo(3,"BC-000043"),photo(4),photo(5,"BC-000044")]
        result = group_photos(photos)
        self.assertEqual([i.sku for i in result.items],["BC-000044"])
        self.assertEqual([p.photo_id for p in result.needs_review],["0","1","2","3"])

    def test_duplicates_quarantine_all_assignments(self):
        result = group_photos([photo(0),photo(1,"BC-000042"),photo(2),photo(3,"BC-000042"),photo(4),photo(5,"BC-000043")])
        self.assertEqual([i.sku for i in result.items],["BC-000043"])
        self.assertEqual(len(result.needs_review),4)

    def test_trailing_and_consecutive_markers_never_create_empty_or_synthetic_items(self):
        result = group_photos([photo(0,"BC-000041"),photo(1),photo(2,"BC-000042"),photo(3,"BC-000043"),photo(4)])
        self.assertEqual([i.sku for i in result.items],["BC-000042"])
        self.assertEqual({p.photo_id for p in result.needs_review},{"0","3","4"})
        self.assertEqual(len(result.items[0].members),1)

    def test_under_limit_missing_boundary_uses_available_evidence_not_invented_sku(self):
        result = group_photos([photo(0,ts=0),photo(1,"BC-000041",ts=5),photo(2,ts=10),photo(3,ts=100),photo(4,"BC-000043",ts=105)])
        self.assertEqual([i.sku for i in result.items],["BC-000041"])
        self.assertEqual(len(result.needs_review),3)
        self.assertEqual(result.problems[0].type,"MERGED_GROUP_SUSPECTED")

    def test_unobservable_missing_boundary_is_not_claimed_detectable(self):
        result = group_photos([photo(0),photo(1),photo(2),photo(3,"BC-000042")])
        self.assertEqual(len(result.items),1)  # No evidence to distinguish one item from two.

    def test_order_uncertainty_prevents_committing_guesses(self):
        result = group_photos([photo(0),photo(1,"BC-000042")], order_review_required=True)
        self.assertFalse(result.items)
        self.assertEqual(len(result.needs_review),2)


class RegionTests(unittest.TestCase):
    def mixed(self):
        return [OcrLine("HOME DEPOT",.99,(0,30,110,50),"mixed.jpg"),
                OcrLine("30",.99,(0,60,20,80),"mixed.jpg"), OcrLine("31",.99,(40,60,60,80),"mixed.jpg"), OcrLine("32",.99,(80,60,100,80),"mixed.jpg"),
                OcrLine("JAMES PERSE",.99,(300,250,480,280),"mixed.jpg"), OcrLine("SIZE M",.99,(300,300,350,320),"mixed.jpg"),
                OcrLine("BC-000042",.99,(600,250,780,280),"mixed.jpg")]

    def test_sticker_size_tag_and_ruler_share_photo_without_contamination(self):
        reading = tag_ocr.interpret(self.mixed())
        self.assertEqual(reading.brand_candidates,["JAMES PERSE"])
        self.assertEqual(reading.size_candidates,["M"])
        self.assertIn("32",reading.props_ignored)
        self.assertIn("BC-000042",reading.props_ignored)
        self.assertEqual(reading.to_json()["lines"][0]["box"],[300,250,480,280])

    def test_brand_and_sticker_do_not_invent_size(self):
        reading = tag_ocr.interpret([self.mixed()[4], self.mixed()[-1]])
        self.assertEqual(reading.brand_candidates,["JAMES PERSE"])
        self.assertEqual(reading.size_candidates,[])

    def test_same_word_on_garment_is_not_globally_blacklisted(self):
        reading = tag_ocr.interpret([OcrLine("EMPIRE",.99,(200,200,300,230),"garment.jpg"),OcrLine("SIZE M",.99,(200,240,300,260),"garment.jpg")])
        self.assertIn("EMPIRE",reading.brand_candidates)
        parsed={"brand":"Empire"}
        props.scrub_vision(parsed)
        self.assertEqual(parsed["brand"],"Empire")

    def test_tool_prose_and_size_are_filtered_in_model_output(self):
        reading=tag_ocr.interpret(self.mixed())
        parsed={"brand":"Home Depot","size":"32","description":"Home Depot shirt. Soft cotton."}
        mapped={"brand":"Home Depot","size":"32"}
        props.cross_check(parsed,reading,mapped)
        self.assertIsNone(parsed["brand"])
        self.assertIsNone(parsed["size"])
        self.assertEqual(parsed["description"],"Soft cotton.")

    def test_paddle_numpy_polygons_keep_locations(self):
        import numpy as np
        lines=extract_lines({"rec_texts":["BC-000042"],"rec_scores":np.array([.99]),"rec_polys":np.array([[[1,2],[30,2],[30,10],[1,10]]])})
        self.assertEqual(lines[0].box,(1,2,30,10))
        self.assertAlmostEqual(lines[0].confidence,.99)

    def test_real_synthetic_label_patch_contrast(self):
        import numpy as np
        import cv2
        image=np.zeros((200,500,3),dtype=np.uint8)
        image[30:150,30:450]=255
        cv2.putText(image,"BC-000042",(60,100),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),2)
        self.assertTrue(regions.sticker_context(image,OcrLine("BC-000042",.99,(60,75,260,105))))
        self.assertFalse(regions.sticker_context(np.zeros_like(image),OcrLine("BC-000042",.99,(60,75,260,105))))

    def test_white_ruler_code_requires_independent_sticker_boundary(self):
        import numpy as np
        import cv2
        image=np.zeros((220,650,3),dtype=np.uint8)
        image[20:180,10:640]=240  # one bright physical ruler, including its code
        cv2.putText(image,"BC-000042",(250,95),cv2.FONT_HERSHEY_SIMPLEX,.6,(0,0,0),1)
        marker=OcrLine("BC-000042",.99,(250,80,375,100),"shared.jpg")
        scales=[OcrLine(str(value),.99,(x,120,x+20,140),"shared.jpg", "measurement_scale") for value,x in [(30,200),(31,250),(32,300)]]
        self.assertFalse(regions.sticker_context(image,marker,scales+[marker]))
        # A separate white label on a grey ruler has an independently bounded
        # component that excludes scale text and remains a usable END marker.
        image[20:180,10:640]=140
        image[55:125,230:400]=255
        cv2.putText(image,"BC-000042",(250,95),cv2.FONT_HERSHEY_SIMPLEX,.6,(0,0,0),1)
        self.assertTrue(regions.sticker_context(image,marker,scales+[marker]))



class ManifestTests(unittest.TestCase):
    def test_natural_order_never_uses_mutable_mtime(self):
        photos=[photo(10),photo(2),photo(1)]
        with mock.patch("os.path.getmtime",side_effect=AssertionError("mtime must not be read")):
            self.assertEqual(order_photos(photos),"filename")
        self.assertEqual([p.photo_id for p in photos],["1","2","10"])

    def test_real_files_freeze_and_checkpoints_survive_resume(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"job";root.mkdir()
            incoming=Path(tmp)/"incoming";incoming.mkdir()
            photos=[];hashes={}
            for i in [10,2,1]:
                source=incoming/f"IMG_{i}.jpg"
                Image.new("RGB",(10,10),(i,0,0)).save(source)
                photos.append(DecodedPhoto(str(source),source.name,width=10,height=10))
                hashes[str(source)]=dedup.sha256_of_file(str(source))
            saved,ordered,_,revision=manifest.freeze(root,photos,hashes,lambda:None)
            self.assertEqual([p.filename for p in ordered],["IMG_1.jpg","IMG_2.jpg","IMG_10.jpg"])
            self.assertEqual(revision,0)
            self.assertTrue(all(Path(row["storedPath"]).is_file() for row in saved["photos"]))
            outcome=decode.DecodeOutcome("BC-000042","BC-000042","ocr")
            manifest.save_decode(root,ordered[0],hashes[ordered[0].path],outcome)
            self.assertEqual(manifest.decode_cache(root,ordered[0],hashes[ordered[0].path]),asdict(outcome))
            _,resumed,_,_=manifest.freeze(root,list(reversed(photos)),hashes,lambda:None)
            self.assertEqual([p.photo_id for p in resumed],[p.photo_id for p in ordered])
            self.assertIsNone(manifest.decode_cache(root,ordered[0],"changed"))
            self.assertIsNone(manifest.decode_cache(root,ordered[0],hashes[ordered[0].path], {"ocr_paddle":True}))
            hashes[ordered[0].path]="changed"
            with self.assertRaisesRegex(RuntimeError,"Frozen batch bytes changed"):
                manifest.freeze(root,photos,hashes,lambda:None)

    def test_invalid_and_duplicate_manual_order_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            manifest.atomic_json(root/"manifest.json",{"version":2,"photos":[],"orderSource":"filename","orderReviewRequired":False})
            manifest.atomic_json(root/"corrections.json",{"revision":1,"order":["invented"]})
            with self.assertRaisesRegex(RuntimeError,"every frozen photo"):
                manifest.freeze(root,[],{},lambda:None)

    def test_equal_capture_times_with_unrelated_names_need_review(self):
        photos=[DecodedPhoto("/a","front.jpg",ts=10),DecodedPhoto("/b","back.jpg",ts=10)]
        self.assertTrue(manifest.order_needs_review(photos,"exif"))


if __name__ == "__main__":
    unittest.main()
