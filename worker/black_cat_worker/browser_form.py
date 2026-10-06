"""Shared native form discovery, prepared listing files, and parcel capacities."""
import os
import json
from typing import Optional

_LABEL_FN = r"""
  function labelText(el){
    let t = el.getAttribute('aria-label') || '';
    if(!t){ const lb = el.getAttribute('aria-labelledby'); if(lb){ const r = document.getElementById(lb); if(r) t = r.innerText; } }
    if(!t) t = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if(!t && el.id){ try{ const l = document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(l) t = l.innerText; }catch(e){} }
    if(!t){ const p = el.closest('label'); if(p) t = p.innerText; }
    if(!t){
      let node = el;
      for(let up=0; up<5 && node; up++){
        let sib = node.previousElementSibling;
        while(sib){
          const txt = (sib.innerText || sib.textContent || '').trim();
          if(txt && txt.length <= 45){ t = txt; break; }
          sib = sib.previousElementSibling;
        }
        if(t) break;
        node = node.parentElement;
      }
    }
    // Strip zero-width chars (Nifty pads some labels, e.g. the size field's
    // "US" + zero-width space) so label matching is reliable.
    return (t || '').replace(/[​‌‍﻿]/g,'').replace(/\s+/g,' ').trim();
  }
"""

_DISCOVER_JS = r"""
() => {
""" + _LABEL_FN + r"""
  const sel = (el) => {
    if (el.id && !/^_r_/.test(el.id)) return '#' + CSS.escape(el.id);
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
    if (el.getAttribute('placeholder')) return el.tagName.toLowerCase() + '[placeholder="' + el.getAttribute('placeholder') + '"]';
    return el.tagName.toLowerCase();
  };
  const out = [];
  document.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach((el) => {
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      label: labelText(el).slice(0, 80),
      selector: sel(el),
    });
  });
  return { url: location.href, title: document.title, fields: out };
}
"""

def _ready_dir(settings: dict, sku: str, override: Optional[str]) -> str:
    return override or os.path.join(settings["readyPath"], sku)

def _load_item_json(ready_dir: str) -> dict:
    path = os.path.join(ready_dir, "item.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _parse_capacity_oz(text: str):
    """Pull a weight capacity (oz) from an option like 'Small (up to 1 lb)'."""
    import re
    m = re.search(r"(\d+(?:\.\d+)?)\s*(lbs?|pounds?|oz|ounces?|kg|grams?|g)\b", (text or "").lower())
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2)
    if unit.startswith("lb") or unit.startswith("pound"):
        return val * 16
    if unit.startswith("oz") or unit.startswith("ounce"):
        return val
    if unit == "kg":
        return val * 35.274
    return val / 28.3495

_FIND_BUTTONS_JS = r"""
(args) => {
  const wants = args.wants.map(w => (w||'').toLowerCase());
  const avoid = (args.avoid||[]).map(w => (w||'').toLowerCase());
  const incDisabled = !!args.includeDisabled;
  const sel = 'button,[role=button],input[type=submit],input[type=button],a[class*=btn],[class*=Button]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // The Save/Publish button is briefly DISABLED while Nifty uploads the images /
    // revalidates. Optionally include disabled buttons so the caller can WAIT for it.
    if (!incDisabled && (el.disabled || el.getAttribute('aria-disabled') === 'true')) continue;
    const t = ((el.innerText || el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t || t.length > 42) continue;
    if (avoid.some(a => a && t.includes(a))) continue;
    if (wants.some(w => w && t.includes(w))) out.push(el);
  }
  return out;
}
"""

def _find_button(page, wants, avoid=None, include_disabled=False):
    """Return the first visible button matching `wants` in PRIORITY order (earliest
    want wins), excluding any whose text contains an `avoid` term. With
    include_disabled=True it also returns a currently-disabled button so the caller
    can wait for it to become enabled."""
    for w in wants:
        try:
            h = page.evaluate_handle(
                _FIND_BUTTONS_JS,
                {"wants": [w], "avoid": avoid or [], "includeDisabled": include_disabled})
            for _, x in h.get_properties().items():
                el = x.as_element()
                if el:
                    try:
                        if el.is_visible():
                            return el
                    except Exception:
                        continue
        except Exception:
            continue
    return None
