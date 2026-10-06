"""Strict END-marker grouping with boundary safeguards + a per-item audit log.

A photo is a *marker* iff its decode (QR or OCR-corrected) yields a valid SKU.
Walking photos in chronological order, everything accumulated since the last
marker belongs to the SKU on the marker that closes the run.

v1.3 reliability semantics (after two live 50-item runs):
  - ONLY a decoded marker ends an item. "QR-like pattern detected but not
    decoded" is NOT a boundary — OpenCV false-positives constantly on garment
    graphics, and splitting on it shredded a real batch into bogus shells. The
    pattern flag is kept as CORROBORATING evidence only.
  - OCR-decoded marker SKUs that are numeric OUTLIERS vs the batch's QR-decoded
    SKUs are DEMOTED to ordinary photos (a misread like 100040 in a
    000001-000050 batch must never become an item or explode the gap check).
  - RECOVERY ("the numbers update themselves"): when a number is missing from
    the sticker sequence AND the group that absorbed it contains exactly one
    run of undecoded QR-pattern photos, the group is split there and the new
    item gets the missing number automatically. FIX-xxxx names are a last
    resort (trailing photos with no marker at end of batch).
  - A marker with no photos before it keeps its number as an EMPTY item
    (operator moves photos in) instead of being dropped.
  - Large EXIF time gaps inside a group only lower confidence (real shoots
    pause for minutes mid-item); sequence gaps are reported once per RANGE.
  - Every item carries {confidence, reasons, per-photo log} so a grouping
    mistake is diagnosable and the UI can triage high vs low confidence.

Problem severities are assigned downstream (src/lib/problemMeta.ts) from the
problem `type`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# Floor for the "this gap looks like an item boundary" threshold (seconds).
MIN_BOUNDARY_GAP_S = 45.0

# A sequence gap wider than this is reported as one summary line, not per-SKU.
MAX_GAP_RANGE_REPORT = 5


@dataclass
class DecodedPhoto:
    """A photo plus its decode outcome (filled in by the decode cascade)."""
    path: str
    filename: str
    sku: Optional[str] = None          # normalized SKU if this is a marker
    decoded_raw: Optional[str] = None  # raw decoded/OCR'd value
    decode_method: Optional[str] = None  # "qr-opencv" | "qr-pyzbar" | "ocr" | None
    exif_dto: Optional[str] = None
    exif_subsec: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    # A QR-like pattern was located in the image even if it didn't decode —
    # i.e. this LOOKS like a sticker shot (set by the decode cascade).
    qr_pattern_detected: bool = False
    # EXIF timestamp as epoch seconds (set by exif_sort.parse_exif_ts); None if absent.
    ts: Optional[float] = None
    # If an outlier OCR read was demoted, the SKU it originally decoded to.
    demoted_from: Optional[str] = None
    # Set for a failed sticker shot that stays with its item (retried marker).
    exclude_from_listing: bool = False

    @property
    def is_marker(self) -> bool:
        return self.sku is not None


@dataclass
class GroupedItem:
    sku: str                       # real SKU, or "" for a placeholder shell
    original_qr_value: Optional[str]
    members: List[DecodedPhoto]    # listing-candidate photos (in order)
    marker: Optional[DecodedPhoto]  # None only for end-of-batch shells
    placeholder: bool = False      # True = shell (unreadable/missing sticker)
    confidence: str = "high"       # high | medium | low
    reasons: List[str] = field(default_factory=list)
    closed_by: str = "qr-marker"   # qr-marker | ocr-marker | unreadable-sticker | end-of-batch
    log: List[Dict] = field(default_factory=list)  # per-photo audit entries

    def add_reason(self, reason: str, level: str) -> None:
        """Attach a reason and lower confidence (never raise it)."""
        if reason not in self.reasons:
            self.reasons.append(reason)
        order = {"high": 0, "medium": 1, "low": 2}
        if order[level] > order[self.confidence]:
            self.confidence = level


@dataclass
class Problem:
    type: str
    sku: Optional[str] = None
    photo_path: Optional[str] = None
    message: str = ""


@dataclass
class GroupingResult:
    items: List[GroupedItem] = field(default_factory=list)
    needs_review: List[DecodedPhoto] = field(default_factory=list)  # legacy; shells replace it
    problems: List[Problem] = field(default_factory=list)
    order_source: str = "exif"     # exif | filename | filename-mixed (from exif_sort)


def _gap(a: Optional[DecodedPhoto], b: Optional[DecodedPhoto]) -> Optional[float]:
    if a is None or b is None or a.ts is None or b.ts is None:
        return None
    return b.ts - a.ts


def _median(values: List[float]) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    return s[(len(s) - 1) // 2]


def demote_outlier_markers(photos: List[DecodedPhoto], result: GroupingResult) -> None:
    """An OCR-read SKU wildly outside the batch's decoded-SKU range is a misread
    (e.g. '100040' in a 000001-000050 batch). Demote it to an unreadable sticker:
    the boundary is kept (a shell is created) but the bogus number never becomes
    an item and never feeds the sequence-gap check.

    QR decodes anchor the expected range when available (they are near-perfect);
    with too few QR reads we fall back to a median-distance check across all
    numeric markers.
    """
    numeric = [(int(p.sku), p) for p in photos if p.is_marker and p.sku and p.sku.isdigit()]
    if len(numeric) < 3:
        return
    qr_nums = [n for n, p in numeric if (p.decode_method or "").startswith("qr")]

    def demote(p: DecodedPhoto, why: str) -> None:
        p.demoted_from = p.sku
        result.problems.append(Problem(
            type="OCR_SKU_OUTLIER",
            sku=p.sku,
            photo_path=p.path,
            message=(f"OCR read '{p.decoded_raw}' as SKU {p.sku} on {p.filename}, but {why} — "
                     f"rejected as a misread (the photo stays an ordinary photo)."),
        ))
        p.sku = None
        # Keep the sticker hint: if a sequence number is missing here, the
        # recovery pass can still split on this photo and auto-assign it.
        p.qr_pattern_detected = True

    if len(qr_nums) >= 3:
        lo, hi = min(qr_nums), max(qr_nums)
        pad = max(10, len(qr_nums))
        for n, p in numeric:
            if (p.decode_method or "") == "ocr" and (n < lo - pad or n > hi + pad):
                demote(p, f"the batch's QR-decoded SKUs span {lo}-{hi}")
    else:
        med = _median([float(n) for n, _ in numeric]) or 0.0
        for n, p in numeric:
            if (p.decode_method or "") == "ocr" and abs(n - med) > 50:
                demote(p, f"the batch's marker SKUs center around {int(med)}")


def group_photos(photos: List[DecodedPhoto], order_source: str = "exif") -> GroupingResult:
    """Group an already chronologically-sorted list of decoded photos."""
    result = GroupingResult(order_source=order_source)
    demote_outlier_markers(photos, result)

    current: List[DecodedPhoto] = []
    seen_skus: set[str] = set()

    # Map each photo to the photo right before it (for gap logging).
    photo_prev_map: Dict[str, Optional[DecodedPhoto]] = {}
    prev = None
    for p in photos:
        photo_prev_map[p.path] = prev
        prev = p

    def photo_log(p: DecodedPhoto, role: str) -> Dict:
        g = _gap(photo_prev_map.get(p.path), p)
        return {
            "file": p.filename,
            "role": role,
            "time": p.exif_dto,
            "gapBeforeSec": round(g, 1) if g is not None else None,
            "decode": p.decode_method,
            "raw": (p.decoded_raw[:60] if p.decoded_raw else None),
        }

    def close_group(marker: Optional[DecodedPhoto], placeholder: bool, closed_by: str) -> GroupedItem:
        item = GroupedItem(
            sku=marker.sku if (marker and marker.sku) else "",
            original_qr_value=marker.decoded_raw if marker else None,
            members=list(current),
            marker=marker,
            placeholder=placeholder,
            closed_by=closed_by,
        )
        for m in item.members:
            item.log.append(photo_log(m, "photo" if not m.exclude_from_listing else "sticker-retry (excluded)"))
        if marker is not None:
            item.log.append(photo_log(marker, "sku-sticker" if not placeholder else "sticker-unreadable"))
        result.items.append(item)
        current.clear()
        return item

    # How many times each SKU was decoded (for the empty-marker case below).
    marker_counts: Dict[str, int] = {}
    for p in photos:
        if p.is_marker:
            marker_counts[p.sku] = marker_counts.get(p.sku, 0) + 1

    # ONLY a decoded marker ends an item. A photo that merely LOOKS like a QR
    # (qr_pattern_detected) must never split by itself — OpenCV localizes "QR-like"
    # squares in graphic tees constantly, and v1.2's split-on-suspected-sticker
    # shredded a real 50-item batch into a dozen bogus FIX shells. The pattern flag
    # is only corroborating evidence for _recover_missing_skus() below.
    for photo in photos:
        if photo.is_marker:
            if not current:
                # Sticker with no photos before it. If it's the sku's ONLY decode,
                # keep the number as an EMPTY item (the operator moves photos in) —
                # dropping it is what made numbers vanish from batches. A repeat
                # decode of the same sticker is just a second shot: skip it.
                result.problems.append(Problem(
                    type="MARKER_NO_PHOTOS",
                    sku=photo.sku,
                    photo_path=photo.path,
                    message=(f"SKU marker {photo.sku} had no photos before it — "
                             + ("empty item created; move its photos in with Move/Split."
                                if marker_counts.get(photo.sku, 0) == 1 else "extra sticker shot skipped.")),
                ))
                if marker_counts.get(photo.sku, 0) == 1 and photo.sku not in seen_skus:
                    seen_skus.add(photo.sku)
                    item = close_group(photo, placeholder=False,
                                       closed_by="ocr-marker" if photo.decode_method == "ocr" else "qr-marker")
                    item.add_reason("sticker had no photos before it — this item is empty; move its photos in", "low")
                continue
            dup = photo.sku in seen_skus
            if dup:
                result.problems.append(Problem(
                    type="AMBIGUOUS_MARKER",
                    sku=photo.sku,
                    photo_path=photo.path,
                    message=f"SKU {photo.sku} decoded more than once in this batch.",
                ))
            seen_skus.add(photo.sku)
            item = close_group(photo, placeholder=False,
                               closed_by="ocr-marker" if photo.decode_method == "ocr" else "qr-marker")
            if dup:
                item.add_reason(f"SKU {photo.sku} appeared twice in this batch — possible duplicate", "low")
            if photo.decode_method == "ocr":
                item.add_reason("SKU read via OCR text fallback (QR would not decode) — double-check the number", "medium")
        else:
            current.append(photo)

    # Anything left after the final marker: keep it as ONE shell item so the
    # photos stay visible and fixable in-app (never dropped or orphaned).
    if current:
        item = close_group(None, placeholder=True, closed_by="end-of-batch")
        item.add_reason("no SKU sticker followed these photos (end of batch) — SKU unknown", "low")
        result.problems.append(Problem(
            type="UNTERMINATED_GROUP",
            photo_path=item.members[0].path if item.members else None,
            message=(f"{len(item.members)} photo(s) at end of batch had no SKU marker — "
                     f"created a shell item; assign a SKU or move the photos in Review."),
        ))

    _recover_missing_skus(result)
    _detect_anomalies(result)
    return result


def _item_log(item: GroupedItem) -> List[Dict]:
    """Rebuild an item's per-photo audit log from its own members (used after a
    recovery split re-partitions two items)."""
    entries: List[Dict] = []
    prev: Optional[DecodedPhoto] = None
    seq = item.members + ([item.marker] if item.marker else [])
    for p in seq:
        g = _gap(prev, p)
        if p is item.marker:
            role = "sku-sticker" if not item.placeholder and item.closed_by != "recovered-sticker" else "sticker-unreadable"
        elif p.exclude_from_listing:
            role = "sticker-extra (excluded)"
        else:
            role = "photo"
        entries.append({
            "file": p.filename, "role": role, "time": p.exif_dto,
            "gapBeforeSec": round(g, 1) if g is not None else None,
            "decode": p.decode_method,
            "raw": (p.decoded_raw[:60] if p.decoded_raw else None),
        })
        prev = p
    return entries


def _pattern_runs(members: List[DecodedPhoto]) -> List[List[int]]:
    """Maximal runs of consecutive indices whose photos LOOK like stickers
    (QR pattern located, nothing decoded)."""
    runs: List[List[int]] = []
    for i, m in enumerate(members):
        if m.qr_pattern_detected:
            if runs and runs[-1][-1] == i - 1:
                runs[-1].append(i)
            else:
                runs.append([i])
    return runs


def _recover_missing_skus(result: GroupingResult) -> None:
    """The numbers update themselves: a number missing from the sticker sequence
    PLUS exactly one run of unreadable-sticker photos inside the group that
    absorbed it = one dead sticker. Split there and assign the missing number
    directly — the operator just verifies, instead of renaming FIX shells.

    Requires BOTH signals; a QR-ish garment photo alone (frequent false
    positive) or a missing number alone never splits anything.
    """
    changed = True
    while changed:
        changed = False
        items = result.items
        by_sku = {int(it.sku): it for it in items if it.sku and it.sku.isdigit()}
        if len(by_sku) < 2:
            return
        width = max(len(it.sku) for it in items if it.sku and it.sku.isdigit())
        present = sorted(by_sku)
        for missing in range(present[0] + 1, present[-1]):
            # Single-number gaps only (both neighbors decoded) — wider gaps are
            # too ambiguous to auto-assign.
            if missing in by_sku or (missing - 1) not in by_sku or (missing + 1) not in by_sku:
                continue
            prev_item = by_sku[missing - 1]
            idx = items.index(prev_item)
            if idx + 1 >= len(items):
                continue
            cand = items[idx + 1]  # the group that chronologically absorbed `missing`
            if cand.placeholder or not cand.members:
                continue
            runs = _pattern_runs(cand.members)
            if len(runs) != 1:
                continue
            run = runs[0]
            sticker_run = [cand.members[i] for i in run]
            new_members = cand.members[: run[0]]
            rest = cand.members[run[-1] + 1:]
            marker_photo = sticker_run[0]
            for extra in sticker_run[1:]:
                extra.exclude_from_listing = True
            new_sku = str(missing).zfill(width)
            new_item = GroupedItem(
                sku=new_sku,
                original_qr_value=marker_photo.decoded_raw,
                members=new_members + sticker_run[1:],
                marker=marker_photo,
                placeholder=False,
                closed_by="recovered-sticker",
            )
            new_item.add_reason(
                f"sticker for {new_sku} couldn't be read — item auto-created from the sticker sequence; verify its photos", "low")
            cand.members = rest
            cand.add_reason(f"photos before its sticker were split out as {new_sku}", "medium")
            new_item.log = _item_log(new_item)
            cand.log = _item_log(cand)
            items.insert(idx + 1, new_item)
            result.problems.append(Problem(
                type="RECOVERED_SKU",
                sku=new_sku,
                photo_path=marker_photo.path,
                message=(f"Sticker for {new_sku} couldn't be read — the item was created "
                         f"automatically from the sticker sequence with {len(new_members)} photo(s); "
                         f"verify its photos and number."),
            ))
            changed = True
            break  # re-derive sku map after the insert, then scan again


def _detect_anomalies(result: GroupingResult) -> None:
    """Merge/boundary signals. These lower per-item confidence and emit capped,
    corroborated warnings — they never alter the grouping."""
    items = result.items

    # Ordering caveats apply to every item in the batch.
    if result.order_source == "filename-mixed":
        for it in items:
            it.add_reason("some photos had no EXIF time; batch ordered by filename", "medium")
    elif result.order_source == "filename":
        for it in items:
            it.add_reason("no EXIF times found; batch ordered by filename", "medium")

    # ---- Time-gap analysis (the strongest merge signal we have) -------------
    intra_gaps: List[float] = []
    for it in items:
        seq = it.members + ([it.marker] if it.marker else [])
        for a, b in zip(seq, seq[1:]):
            g = _gap(a, b)
            if g is not None and g >= 0:
                intra_gaps.append(g)
    med_gap = _median(intra_gaps)
    gap_threshold = max(MIN_BOUNDARY_GAP_S, (med_gap or 0) * 6)

    # Calibrate against THIS batch's own item boundaries, not just a multiple of
    # the intra-item median. A dead sticker merges two items, so the giveaway is
    # an internal pause that looks like one of this shoot's real boundaries. On a
    # fast shoot (short boundaries) `med_gap * 6` sails right over them: measured
    # on a real batch, 19s intra / 60s boundaries gave a 114s threshold and the
    # merge went unflagged. Half the median observed boundary catches that while
    # staying well above normal in-item pauses, and MIN_BOUNDARY_GAP_S still
    # floors it so a rapid-fire shoot can't drive the threshold into noise.
    boundary_gaps: List[float] = []
    for a, b in zip(items, items[1:]):
        last = (a.marker or (a.members[-1] if a.members else None))
        first = b.members[0] if b.members else b.marker
        g = _gap(last, first)
        if g is not None and g >= 0:
            boundary_gaps.append(g)
    med_boundary = _median(boundary_gaps) if len(boundary_gaps) >= 2 else None
    if med_boundary:
        gap_threshold = max(MIN_BOUNDARY_GAP_S, min(gap_threshold, med_boundary * 0.5))

    member_counts = sorted(len(it.members) for it in items) or [0]
    median_members = member_counts[(len(member_counts) - 1) // 2]
    # A merge of two typical items lands at ~2x the median, so the multiplier has
    # to sit AT that number to ever fire. The old 2.5x could not: on a real
    # 103-item batch (median 6 photos, largest legitimate item 11) it computed 15,
    # leaving 12-14 — bigger than any real item — silently unflagged. The floor of
    # 10 stays exactly where it was; honest 8-9 photo items were a routine false
    # positive, and this change never lowers the threshold below it.
    bloat_threshold = max(10, median_members * 2)

    suspects: Dict[str, GroupedItem] = {}
    for it in items:
        seq = it.members + ([it.marker] if it.marker else [])
        worst = None
        for a, b in zip(seq, seq[1:]):
            g = _gap(a, b)
            if g is not None and (worst is None or g > worst[0]):
                worst = (g, b)
        big_gap = worst is not None and worst[0] >= gap_threshold
        bloated = len(it.members) >= bloat_threshold

        # Time gaps and bloat are CONFIDENCE NOTES, never problem rows: real
        # shoots pause for minutes mid-item (the second live run had ten
        # multi-minute pauses inside perfectly good groups), so a row per gap
        # is exactly the noise the operator complained about. A gap only turns
        # into a warning when a missing sequence number corroborates it below.
        if big_gap:
            it.add_reason(
                f"{int(worst[0])}s pause inside this group before {worst[1].filename} — "
                f"double-check it isn't two items", "medium")
            if it.sku:
                suspects[it.sku] = it
        elif bloated:
            it.add_reason(
                f"{len(it.members)} photos vs a batch median of {median_members} — "
                f"double-check this is one item", "medium")

    # ---- Sequence gaps: one warning per RANGE, capped ------------------------
    nums = []
    for it in items:
        if it.sku and it.sku.isdigit():
            nums.append((int(it.sku), it))
    if len(nums) >= 2:
        width = max(len(it.sku) for _, it in nums)
        present = sorted(n for n, _ in nums)
        present_set = set(present)
        lo, hi = present[0], present[-1]
        missing = [n for n in range(lo + 1, hi) if n not in present_set]
        span = hi - lo + 1
        if missing and len(missing) > max(MAX_GAP_RANGE_REPORT, span // 5):
            # The batch clearly isn't a contiguous sticker range — per-number
            # warnings would be pure noise (this is what produced 99,990 rows).
            result.problems.append(Problem(
                type="SKU_SEQUENCE_INFO",
                message=(f"Batch SKUs span {str(lo).zfill(width)}-{str(hi).zfill(width)} with "
                         f"{len(missing)} numbers absent — sequence-gap warnings suppressed "
                         f"(batch doesn't look like one contiguous sticker range)."),
            ))
        elif missing:
            # Group consecutive missing numbers into ranges.
            ranges: List[List[int]] = []
            for n in missing:
                if ranges and n == ranges[-1][-1] + 1:
                    ranges[-1].append(n)
                else:
                    ranges.append([n])
            for r in ranges:
                after = min((it for n, it in nums if n > r[-1]),
                            key=lambda it: int(it.sku), default=None)
                label = (str(r[0]).zfill(width) if len(r) == 1
                         else f"{str(r[0]).zfill(width)}-{str(r[-1]).zfill(width)}")
                msg = (f"SKU {label} missing from this batch — its sticker was skipped or unreadable.")
                if after is not None:
                    corroborated = after.sku in suspects or len(after.members) >= bloat_threshold
                    msg += (f" Photos {'very likely' if corroborated else 'may have'} merged into "
                            f"{after.sku} ({len(after.members)} photos) — open it and use Split, "
                            f"or add the item by hand (Inventory → New item).")
                    # Always lower confidence, not only when corroborated. The
                    # problem row already says photos may have merged into this
                    # item; leaving it at "high" meant a confidence-ordered
                    # review queue showed the one item we actively suspect as
                    # clean, and an auto-run skipped straight past it.
                    after.add_reason(
                        f"SKU {label} is missing right before this item — photos may have merged in",
                        "low" if corroborated else "medium")
                result.problems.append(Problem(
                    type="MISSING_SKU",
                    sku=str(r[0]).zfill(width),
                    photo_path=after.marker.path if (after and after.marker) else None,
                    message=msg,
                ))
