"""The operator-approved 6P shorts mapping for catalogs without petite sizes."""
import re


def petite_size_base(item, department):
    kind = re.sub(r'[^a-z]', '', str(item.get('itemType') or '').lower())
    if department != 'Women' or not kind.endswith('shorts') or not re.fullmatch(r'\s*6p\s*', str(item.get('size') or ''), re.I):
        return None
    # Depop6 and Mercari S(4-6) are approved only with the actual petite sizing
    # clearly retained in both pieces of buyer-facing copy.
    for field in ['title', 'description']:
        text = str(item.get(field) or '')
        if not re.search(r'\b6p\b', text, re.I) or not re.search(r'\bpetite\b', text, re.I):
            raise ValueError('Keep 6P and petite in both title and description before using a standard size option')
    return '6'
