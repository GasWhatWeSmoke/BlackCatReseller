"""Temporary, full-resolution JPEG copies for Mercari's per-photo byte limit."""
from contextlib import contextmanager
import io
from pathlib import Path
import tempfile

from PIL import Image, ImageOps

MAX_PHOTO_BYTES = 10 * 1024 * 1024


@contextmanager
def upload_photo_copies(photos, max_bytes=MAX_PHOTO_BYTES):
    from .mercari_native_form import image_matches
    directory = None
    created = []
    prepared = []
    try:
        for index, value in enumerate(photos):
            source = Path(value)
            if source.stat().st_size <= max_bytes:
                prepared.append(str(source))
                continue
            with Image.open(source) as raw:
                if raw.mode in {'RGBA','LA'} or 'transparency' in raw.info:
                    raise ValueError('An oversized transparent photo needs review before Mercari upload')
                picture = ImageOps.exif_transpose(raw).convert('RGB')
            contents = None
            for quality in [95,90,85]:
                buffer = io.BytesIO()
                picture.save(buffer, 'JPEG', quality=quality, subsampling=0, optimize=True)
                candidate = buffer.getvalue()
                if len(candidate) <= max_bytes and image_matches(source, candidate):
                    contents = candidate
                    break
            if contents is None:
                raise ValueError('Photo cannot meet Mercari size limit with verified image fidelity')
            if directory is None:
                directory = Path(tempfile.mkdtemp(prefix='blackcat-mercari-photos-'))
            target = directory / f'{index:02d}-upload.jpg'
            created.append(target)
            target.write_bytes(contents)
            prepared.append(str(target))
        yield prepared
    finally:
        # Only files made by this call are removed; originals are never changed.
        # Cleanup failure must not turn a verified publication into a retry.
        for target in created:
            try: target.unlink(missing_ok=True)
            except OSError: pass
        if directory is not None:
            try: directory.rmdir()
            except OSError: pass
