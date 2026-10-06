"""Per-item enrichment extension hook.

No-op in Version A. Version B registers analyzers here (local VLM brand guess,
flaw detection, price hint, and a last-resort SKU-read escalation), all GPU-local
on the RTX 6000, writing *suggestions* the operator confirms — never auto-applied.
"""
from __future__ import annotations

from typing import Dict, List


def enrich_item(item: Dict, photos: List[Dict]) -> Dict:
    """Return suggested enrichments for an item. Version A returns nothing."""
    return {}
