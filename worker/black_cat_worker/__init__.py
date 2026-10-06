"""Black Cat Agent — Python intake worker.

Pipeline: stability check -> EXIF chronological sort -> per-photo QR/OCR decode
cascade -> strict end-marker grouping -> SKU normalize -> SHA-256 dedup ->
copy-forward + thumbnails -> emit structured JSON result (persisted by Next.js
via Prisma).  See SPEC: writing_room/Nick/spec_black-cat-agent.md
"""

__version__ = "0.1.0"
