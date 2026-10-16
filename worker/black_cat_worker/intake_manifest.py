"""Atomic local intake snapshots and checkpoints owned by the server's job lease."""
from __future__ import annotations

from dataclasses import asdict
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from uuid import uuid4

from . import dedup
from .grouping import DecodedPhoto
from .exif_sort import order_photos
from .sku import is_valid_sku

VERSION = 2


def job_directory():
    value = os.environ.get("BLACKCAT_INTAKE_JOB_DIR")
    if not value:
        return None
    root = Path(value)
    if not root.is_absolute() or root.is_symlink():
        raise RuntimeError("Intake job directory must be an absolute, unlinked path")
    root.mkdir(parents=True, exist_ok=True)
    return root


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    try:
        with open(temp, "x", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        deadline = time.monotonic() + 2.0
        while True:
            try:
                os.replace(temp, path)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EPERM, errno.EBUSY) or time.monotonic() >= deadline:
                    raise
                # Preserve the old checkpoint while Windows releases a transient
                # scanner/reader lock. Replacement remains atomic throughout.
                time.sleep(0.025)
        if hasattr(os, "O_DIRECTORY"):
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temp.exists():
            temp.unlink()


def committed_ids(root):
    record = read_json(root / "committed.json", {})
    return {photo_id for group in record.get("groups", []) for photo_id in group.get("photoIds", [])}


def copy_fsynced(source, destination):
    """Flush copied bytes while the destination handle is still writable.

    Windows cannot fsync a read-only handle. Copy metadata only after flushing,
    so a read-only source never prevents its new snapshot from being flushed.
    """
    with open(source, "rb") as reader, open(destination, "xb") as writer:
        shutil.copyfileobj(reader, writer, length=1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())
    shutil.copystat(source, destination)


def existing_workset(root, incoming=None, cancel_check=lambda: None, recovered=None):
    manifest = read_json(root / "manifest.json") if root else None
    if not manifest:
        return None
    done = committed_ids(root)
    paths = []
    for row in manifest["photos"]:
        if row["id"] in done:
            continue
        source = row["originalPath"]
        cancel_check()
        if not os.path.exists(source):
            target = Path(source)
            incoming_root = Path(incoming).resolve() if incoming else None
            if incoming_root is None or target.parent != incoming_root or target.is_symlink():
                raise RuntimeError(f"Cannot restore {row['originalFilename']}: its original path is outside the current Incoming folder")
            ident = row.get("id")
            if not isinstance(ident,str) or not re.fullmatch(r"[0-9a-f]{32}",ident):
                raise RuntimeError("Invalid frozen photo identity; restore cancelled")
            snapshot = root / "sources" / (ident + ".jpg")
            if str(snapshot) != row.get("storedPath") or snapshot.is_symlink() or snapshot.resolve() != root.resolve() / "sources" / (ident + ".jpg"):
                raise RuntimeError(f"Cannot restore {row['originalFilename']}: snapshot path failed verification")
            if not snapshot.is_file() or dedup.sha256_of_file(str(snapshot),cancel_check=cancel_check) != row.get("sha256"):
                raise RuntimeError(f"Original and verified snapshot are unavailable for {row['originalFilename']}. Reselect this original photo; the batch has not been discarded.")
            # A complete file is installed with an exclusive hard link. Unlike
            # replace/rename, this cannot overwrite a concurrently arrived file.
            target.parent.mkdir(parents=True,exist_ok=True)
            temp = target.parent / (".restore-" + uuid4().hex + ".tmp")
            try:
                copy_fsynced(snapshot,temp)
                if dedup.sha256_of_file(str(temp),cancel_check=cancel_check) != row["sha256"]:
                    raise RuntimeError("Recovery snapshot changed while copying")
                cancel_check()
                try:
                    os.link(temp,target)
                except FileExistsError:
                    if target.is_symlink() or dedup.sha256_of_file(str(target),cancel_check=cancel_check) != row["sha256"]:
                        raise RuntimeError(f"{row['originalFilename']} arrived during recovery with different bytes; it was preserved untouched") from None
                if recovered:
                    recovered(row)
            finally:
                if temp.exists():
                    temp.unlink()
        if not os.path.isfile(source):
            raise RuntimeError(f"Original {row['originalFilename']} is not an accessible file; its snapshot remains in the batch")
        paths.append(source)
    return paths


def order_needs_review(photos, source):
    if len(photos) < 2:
        return False
    cameras = {(p.capture_metadata.get("cameraMake"),p.capture_metadata.get("cameraModel")) for p in photos if p.capture_metadata.get("cameraModel")}
    offsets = {p.capture_metadata.get("offsetTimeOriginal") for p in photos if p.capture_metadata.get("offsetTimeOriginal")}
    if len(cameras) > 1 or len(offsets) > 1:
        return True
    names = [(p.source_filename or p.filename).casefold() for p in photos]
    if len(set(names)) != len(names):
        return True
    # Filenames must form one camera counter series when EXIF is unavailable.
    patterns = [re.fullmatch(r"(.*?)([0-9]+)(\.[^.]+)", name) for name in names]
    consistent = all(patterns) and len({(m.group(1),m.group(3)) for m in patterns if m}) == 1
    if source != "exif":
        if not consistent:
            return True
        times = [p.ts for p in photos if p.ts is not None]
        return any(b < a for a,b in zip(times,times[1:]))
    times = [p.ts for p in photos]
    # Equal capture times without a consistent counter cannot prove chronology.
    if len(set(times)) != len(times) and not consistent:
        return True
    if consistent:
        counters = [int(m.group(2)) for m in patterns]
        if any(b < a for a,b in zip(counters,counters[1:])):
            return True
    return False


def freeze(root, photos, hashes, cancel_check):
    saved = read_json(root / "manifest.json") if root else None
    if saved is None:
        imports = {}
        if root:
            journal = root.parent.parent / "intake-imports.jsonl"
            try:
                with open(journal, encoding="utf-8") as handle:
                    wanted = {os.path.abspath(photo.path) for photo in photos}
                    for raw in handle:
                        try:
                            row = json.loads(raw)
                            path = row.get("storedPath")
                            if isinstance(path,str) and os.path.abspath(path) in wanted:
                                imports[os.path.abspath(path)] = {key:row.get(key) for key in ("originalFilename","sourcePath","sourceRelativePath","importedAt") if row.get(key) is not None}
                        except (ValueError,TypeError):
                            continue
            except FileNotFoundError:
                pass
        for photo in photos:
            metadata = imports.get(os.path.abspath(photo.path), {})
            photo.source_filename = metadata.get("originalFilename") or photo.filename
        source = order_photos(photos)
        review = order_needs_review(photos, source)
        rows = []
        for index, photo in enumerate(photos):
            cancel_check()
            sha = hashes[os.path.abspath(photo.path)]
            ident = hashlib.sha256(f"{index}:{photo.filename}:{sha}".encode()).hexdigest()[:32]
            snapshot = photo.path
            if root:
                snapshot = str(root / "sources" / (ident + ".jpg"))
                Path(snapshot).parent.mkdir(exist_ok=True)
                if not os.path.exists(snapshot):
                    temp = snapshot + "." + uuid4().hex + ".tmp"
                    copy_fsynced(photo.path, temp)
                    if dedup.sha256_of_file(temp, cancel_check=cancel_check) != sha:
                        os.unlink(temp)
                        raise RuntimeError("Photo changed while preserving the intake snapshot")
                    os.replace(temp, snapshot)
            rows.append({"id": ident, "sequenceIndex": index, "originalFilename": photo.filename,
                         "storedPath": snapshot, "originalPath": photo.path, "sha256": sha,
                         "exifDateTimeOriginal": photo.exif_dto, "exifSubSec": photo.exif_subsec,
                         "width": photo.width, "height": photo.height, "ts": photo.ts,
                         "captureMetadata": photo.capture_metadata, "importedMetadata": imports.get(os.path.abspath(photo.path)),
                         "originalSourceFilename": photo.source_filename})
        saved = {"version": VERSION, "revision": 0, "orderSource": source,
                 "orderReviewRequired": review, "photos": rows}
        if root:
            atomic_json(root / "manifest.json", saved)
    by_path = {os.path.abspath(p.path): p for p in photos}
    done = committed_ids(root) if root else set()
    ordered = []
    for row in saved["photos"]:
        if row["id"] in done:
            continue
        path = os.path.abspath(row["originalPath"])
        if path not in by_path or hashes.get(path) != row["sha256"]:
            raise RuntimeError("Frozen batch bytes changed; originals and saved manifest were retained for review")
        photo = by_path[path]
        photo.photo_id, photo.sequence_index = row["id"], row["sequenceIndex"]
        photo.ts = row.get("ts")
        photo.source_filename = row.get("originalSourceFilename")
        photo.capture_metadata = row.get("captureMetadata", {})
        photo.exif_dto, photo.exif_subsec = row.get("exifDateTimeOriginal"), row.get("exifSubSec")
        ordered.append(photo)
    correction = read_json(root / "corrections.json", {}) if root else {}
    revision = correction.get("revision", 0)
    if type(revision) is not int or revision < 0:
        raise RuntimeError("Invalid batch correction revision")
    ids = [r["id"] for r in saved["photos"]]
    order = correction.get("order")
    if order is not None:
        if len(order) != len(ids) or set(order) != set(ids):
            raise RuntimeError("Corrected order must contain every frozen photo exactly once")
        positions = {ident: index for index,ident in enumerate(order)}
        ordered.sort(key=lambda p: positions[p.photo_id])
    markers = correction.get("markers", {})
    if not isinstance(markers, dict) or any(k not in ids or (v is not None and not is_valid_sku(v)) for k,v in markers.items()):
        raise RuntimeError("Invalid manual marker correction")
    # Historical corrections are retained as provenance after their groups
    # commit. Committed IDs are already excluded from the resumed workset.
    return saved, ordered, correction, revision


def decode_cache(root, photo, sha, engine_signature=None):
    if not root:
        return None
    row = read_json(root / "decode" / (photo.photo_id + ".json"))
    if row and row.get("version") == VERSION and row.get("sha256") == sha and row.get("engineSignature") == engine_signature:
        return row.get("outcome")
    return None


def save_decode(root, photo, sha, outcome, engine_signature=None):
    if root:
        atomic_json(root / "decode" / (photo.photo_id + ".json"), {"version": VERSION,"sha256":sha,"engineSignature":engine_signature,"outcome":asdict(outcome)})


def group_key(item, hashes, settings):
    body = {"version": VERSION, "sku": item.sku,
            "photos": [hashes[os.path.abspath(p.path)] for p in item.members + ([item.marker] if item.marker else [])],
            "settings": {k:v for k,v in settings.items() if k.startswith(("vision", "tagOcr"))}}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def verification(root, manifest, photos, grouping, revision, correction):
    by_id = {p.photo_id:p for p in photos}
    previous = read_json(root / "verification.json", {}) if root else {}
    previous_photos = {row["id"]:row for row in previous.get("photos", [])}
    done = committed_ids(root) if root else set()
    rows = []
    order = correction.get("order") or [p["id"] for p in manifest["photos"]]
    positions = {ident:i for i,ident in enumerate(order)}
    for saved in manifest["photos"]:
        photo = by_id.get(saved["id"])
        prior = previous_photos.get(saved["id"], {})
        rows.append({**saved,"sequenceIndex":positions[saved["id"]],
                     "sku": photo.sku if photo else prior.get("sku"), "markerEvidence":photo.marker_evidence if photo else prior.get("markerEvidence", []),
                     "markerReviewReason":photo.marker_review_reason if photo else prior.get("markerReviewReason")})
    rows.sort(key=lambda row:row["sequenceIndex"])
    groups = [{"sku":item.sku, "photoIds":[p.photo_id for p in item.members] + [item.marker.photo_id],
               "markerPhotoId":item.marker.photo_id,"status":"validated","reasons":item.reasons} for item in grouping.items]
    groups = [{**group,"status":"committed"} for group in previous.get("groups", []) if group.get("photoIds") and set(group["photoIds"]).issubset(done)] + groups
    value = {"version": VERSION,"revision":revision,"photos":rows,"groups":groups,
             "unresolved":grouping.unresolved,"orderSource":"manual" if correction.get("order") else manifest["orderSource"],
             "orderReviewRequired":manifest["orderReviewRequired"] and not bool(correction.get("orderVerified")),
             "detectionComplete":True,"markerPhotoCount":sum(bool(row.get("sku")) for row in rows),
             "photoLimit":32,"markerCountsTowardLimit":True}
    if root:
        atomic_json(root / "verification.json", value)
    return value
