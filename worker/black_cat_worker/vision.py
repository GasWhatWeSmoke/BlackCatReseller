"""Local vision-model enrichment: read an item's photos and propose field values.

Sends an item's photos (downscaled, base64) only to the app-managed, authenticated
llama.cpp loopback sidecar and asks for structured JSON: category (Clothing / Bag /
Jewelry / Hat / Shoes / Accessory), the MOST SPECIFIC item type (e.g. "Crossbody
Bag", "Bucket Hat", "Necklace" — not just "bag"/"accessory"), colors, pattern,
size (only if a size tag is legible in a photo), and brand.

Per-item failures are fail-soft — enrich() returns {"error": ...} and the batch
continues with the OTHER items — but errors are precise (HTTP status + server
message, e.g. "model has no vision support"), and after repeated endpoint-level
failures the enricher short-circuits the remaining items with the same error
instead of hammering a dead endpoint. Callers persist the error per item so the
UI can show which items failed and why (the silent blank-batch bug of 2026-08-05).
No photo ever leaves the machine — the endpoint is localhost.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request
from typing import Dict, List, Optional
from .photo_orientation import rotate_cv_image, validate_rotation

from . import normalize, props, tag_ocr


class _RejectLocalVisionRedirects(urllib.request.HTTPRedirectHandler):
    """Never let a fixed-loopback request follow a redirect off the machine."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, "local vision redirects are not allowed", headers, fp,
        )


def _build_local_vision_opener():
    """Return a proxy-free, redirect-free opener for private image payloads."""
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _RejectLocalVisionRedirects(),
    )

# Field name -> normalizer for the value the model returns. Capitalizes hyphen
# segments too: "t-shirt" -> "T-Shirt" (str.capitalize alone gives "T-shirt").
_TITLE = lambda s: " ".join("-".join(p.capitalize() for p in w.split("-")) for w in str(s).split())
# Canonical pattern labels (match on a loose key).
_PATTERNS = {
    "solid": "Solid", "plain": "Solid",
    "graphic": "Graphic", "print": "Graphic", "printed": "Graphic", "logo": "Graphic",
    "multicolor": "Multicolor", "multi-color": "Multicolor", "multi color": "Multicolor",
    "colorblock": "Multicolor", "color block": "Multicolor", "colorblocked": "Multicolor",
    "tie-dye": "Tie-Dye", "tie dye": "Tie-Dye", "tiedye": "Tie-Dye",
    "striped": "Striped", "stripe": "Striped", "stripes": "Striped",
    "camo": "Camo", "camouflage": "Camo",
    "plaid": "Plaid", "checkered": "Plaid", "check": "Plaid",
    "floral": "Floral",
}
# Canonical clothing itemType labels (loose key -> the garment noun buyers filter
# by). Unlisted values fall back to _TITLE so novel types ("Hair Accessory") are
# never lost.
_ITEM_TYPES = {
    "tee": "T-Shirt", "t shirt": "T-Shirt", "tshirt": "T-Shirt", "t-shirt": "T-Shirt",
    "graphic tee": "T-Shirt",
    "polo": "Polo Shirt",
    "button up": "Button-Up Shirt", "button-up": "Button-Up Shirt",
    "button down": "Button-Up Shirt", "button-down": "Button-Up Shirt",
    "button up shirt": "Button-Up Shirt", "button-up shirt": "Button-Up Shirt",
    "button down shirt": "Button-Up Shirt", "button-down shirt": "Button-Up Shirt",
    "long sleeve button down": "Button-Up Shirt", "long sleeve button up": "Button-Up Shirt",
    "long sleeve button-up shirt": "Button-Up Shirt",
    "flannel": "Flannel Shirt",
    "henley": "Henley Shirt",
    "tank": "Tank Top",
    "hooded sweatshirt": "Hoodie", "zip up hoodie": "Hoodie", "zip-up hoodie": "Hoodie",
    "pullover hoodie": "Hoodie",
    "crewneck sweatshirt": "Sweatshirt", "crew neck sweatshirt": "Sweatshirt",
    "jogger": "Joggers",
    "sweatpant": "Sweatpants",
    "trouser": "Pants", "trousers": "Pants", "slacks": "Pants",
    "duffle": "Duffel Bag", "duffle bag": "Duffel Bag",
    "baseball hat": "Baseball Cap", "ball cap": "Baseball Cap",
}
# Canonical size labels (loose key, matched after stripping periods/extra spaces).
# Numeric and waist forms ("32", "32x34", "7") are not keys — they keep the old
# upper()/_TITLE passthrough unchanged.
_SIZES = {
    "extra small": "XS", "x-small": "XS", "xsmall": "XS", "xs": "XS",
    "small": "S", "sm": "S", "s": "S",
    "medium": "M", "med": "M", "m": "M",
    "large": "L", "lg": "L", "l": "L",
    "x-large": "XL", "xlarge": "XL", "extra large": "XL", "xl": "XL",
    "xxl": "2XL", "xx-large": "2XL", "2xl": "2XL", "2x": "2XL",
    "xxxl": "3XL", "3xl": "3XL", "3x": "3XL",
    "xxxxl": "4XL", "4xl": "4XL", "4x": "4XL",
    "one size": "One Size", "os": "One Size", "osfa": "One Size",
    "one size fits all": "One Size",
}
# Era variants -> the closed prompt vocabulary (era is a raw-JSON passenger, not a
# mapped field; canonicalized in place so downstream sees one label per era).
_ERAS = {
    "y2k": "Y2K", "1990s": "90s", "90's": "90s", "1980s": "80s", "80's": "80s",
    "1970s": "70s", "70's": "70s", "1960s": "60s", "60's": "60s", "modern": "Modern",
}

_PROMPT = (
    "You are an expert fashion reseller cataloging ONE single item shown across the "
    "images (multiple angles, plus possibly a close-up of its size or brand tag). The item "
    "may be a garment OR an accessory (bag, belt, scarf, jewelry, hat, sunglasses, ...). "
    "Study the photos carefully — front, back, interior, tags, hardware — and return ONLY a "
    "JSON object with these keys:\n"
    '  "category": exactly one of "Clothing","Bag","Jewelry","Hat","Shoes","Accessory",\n'
    '  "itemType": the MOST SPECIFIC type you can reasonably determine — never just "Bag" or "Accessory" when the photos show which kind it is.\n'
    '    Clothing: ALWAYS ends with the garment noun a buyer filters by, picked from "T-Shirt","Long Sleeve Shirt","Polo Shirt","Button-Up Shirt","Flannel Shirt","Dress Shirt","Henley Shirt","Tank Top","Blouse","Hoodie","Sweatshirt","Sweater","Cardigan","Jacket","Coat","Blazer","Vest","Pants","Jeans","Sweatpants","Joggers","Leggings","Shorts","Dress","Skirt","Romper","Jumpsuit","Overalls". '
    'Cut/style words ("Bomber","Varsity","Cargo","Graphic") go in the "style" field, never in itemType — a bomber jacket is itemType "Jacket" + style "Bomber".\n'
    '    Bag: "Handbag","Shoulder Bag","Crossbody Bag","Tote Bag","Backpack","Clutch","Messenger Bag","Duffel Bag","Wallet","Pouch",\n'
    '    Jewelry: "Necklace","Bracelet","Ring","Earrings","Brooch","Watch",\n'
    '    Hat: "Baseball Cap","Snapback","Beanie","Bucket Hat","Cowboy Hat","Fedora","Visor","Sun Hat",\n'
    '    Shoes: "Sneakers","Boots","Sandals","Heels","Loafers",\n'
    '    Accessory: "Belt","Scarf","Tie","Gloves","Bandana","Sunglasses","Hair Accessory","Keychain",\n'
    '  "primaryColor": the single main color word ("Black","Navy","Red","Tan"),\n'
    '  "secondaryColor": a second color ONLY when it covers a large area of the item (colorblock panels, stripes, a contrast yoke or sleeves) — never stitching, buttons, rivets, zippers, labels, or a logo; null for a solid item,\n'
    '  "tertiaryColor": a third color under the same rule, else null,\n'
    '  "colorPattern": one of "solid","graphic","multicolor","colorblock","tie-dye","striped","camo","plaid","floral",\n'
    '  "size": the size ONLY if a size tag/label is clearly readable in an image ("M","Large","32x34"; belt length like "34"; ring size like "7"), else null. Most bags, jewelry, and scarves have no size — null,\n'
    '  "brand": the brand ONLY if clearly readable from a tag, label, logo, or engraving, else null,\n'
    '  "model": the model/product line ONLY if readable or unmistakable ("501","Detroit Jacket","Air Max 90","Polo Bear"), else null. This is what a buyer searches for after the brand — never guess it, and never repeat the brand in it ("501", not "Levi\'s 501"),\n'
    '  "styleNumber": a style/product number printed on a tag ("501-0000","CK1234") - never an RN, CA, or WPL registration number - else null,\n'
    '  "material": the main material if identifiable or labeled — fabric ("Cotton","Polyester","Nylon","Denim","Wool","Fleece","Corduroy","Knit"), or for accessories ("Leather","Suede","Canvas","Gold-Tone Metal","Silver-Tone Metal","Stainless Steel","Beaded"), else null,\n'
    '  "department": who it is styled for — "Men","Women","Unisex", or "Kids", else null,\n'
    '  "style": a short style descriptor — garments: "Bomber","Track Jacket","Varsity","Cargo","Polo","Crewneck","Henley"; accessories: "Quilted","Chain Strap","Western","Chunky","Minimalist","Trucker","Dad Hat", else null,\n'
    '  "fit": for CLOTHING only, the cut if evident — tops: "Slim","Regular","Relaxed","Oversized","Cropped"; bottoms: "Skinny","Straight","Bootcut","Wide Leg","Baggy","Flare"; null for non-clothing,\n'
    '  "closure": how it fastens if visible — garments: "Full Zip","Half Zip","Snap-Button","Button-Up","Pullover","Drawstring","Elastic Waist"; bags/jewelry: "Zip Top","Magnetic Snap","Flap","Buckle","Lobster Clasp","Toggle"; null if not visible,\n'
    '  "neckline": for CLOTHING only, collar/neck detail if visible ("Ribbed Collar","Crewneck","V-Neck","Hooded","Mock Neck","Spread Collar"); null for non-clothing,\n'
    '  "sleeveLength": for TOPS only - "Short Sleeve","Long Sleeve","Sleeveless","3/4 Sleeve"; null for bottoms, dresses, and non-clothing,\n'
    '  "lining": interior lining if visible ("Quilted","Fleece-Lined","Mesh-Lined","Flannel-Lined","Fabric-Lined"), else null,\n'
    '  "graphics": an array of SHORT phrases for each distinct graphic, print, embroidery, patch, engraving, or readable text you can actually SEE '
    "(e.g. \"embroidered fox mascot\",\"flame graphic on sleeve\",\"'No Ruls 1980' patch\",\"engraved floral band\"); [] if none,\n"
    '  "keyDetails": an array of 1-4 SHORT search keywords a buyer would actually type into eBay/Depop — garments: "Patches","Embroidered","Distressed","Quilted","Double Knee","Single Stitch","Sherpa Lined","Corduroy Collar"; accessories: "Gold-Tone","Adjustable Strap","Rhinestone","Braided". '
    'NEVER standard features every such item has (pockets, buttons, cuffs, seams, stitching, tags), never a color alone, never the item type or the style again ("Cargo Pockets" on cargo shorts says nothing new); "Leather" only if labeled or unmistakable; [] if none,\n'
    '  "aesthetic": an array of 1-5 style/aesthetic tags ("vintage racing","streetwear","varsity","Y2K","workwear","gorpcore","grunge","western","athletic","boho","minimalist"); [] if unsure,\n'
    '  "era": your best era estimate ONLY when a concrete visual cue supports it - tag typography/logo era, single-stitch hems, union or paper tag, era-specific wash or hardware; one of "Y2K","90s","80s","70s","60s","2000s","2010s","Modern"; null when unsure. This is a suggestion the seller verifies, not a fact claim,\n'
    '  "description": a FACTUAL, plain-language breakdown of the item in 30-55 words. Describe ONLY what is visible AND '
    "worth a buyer's attention: brand (if readable), item type, color(s), pattern, fit/silhouette or shape, graphics/embroidery/"
    "patches/prints/readable text, notable closure, hardware, strap type, or lining, and style/aesthetic keywords. For jewelry "
    "mention the metal tone and stone/pendant details you can see; for bags mention strap style and hardware color. Use short, "
    "direct, third-person sentences that read like an accurate item description for a resale buyer, NOT an advertisement. "
    "Do NOT state the garment size in the description - size is recorded separately. Do NOT start with the word \"Description\",\n"
    '  "confidence": a number 0.0-1.0.\n'
    "STRICT GROUNDING RULES: Describe ONLY what is actually visible. Do NOT invent or guess a brand, material, size, graphics, "
    "or any detail you cannot see. If the brand is not clearly readable, set \"brand\" to null and never name a brand in the "
    "description. Never claim a precious metal or gemstone is genuine — say \"gold-tone\"/\"silver-tone\" unless a hallmark is "
    "clearly readable. Do NOT mention condition, flaws, authenticity, or resale value. Do NOT use the word \"unknown\". "
    "PHOTO PROPS ARE NOT THE ITEM: a metal ruler or tape measure lies beside the item in the measurement photos for scale, and a hanger or backdrop may show. Never take a brand, model, style number, size, graphic, or text from a ruler, tape measure, hanger, or anything in the background - the studio ruler is printed \"Empire Model 403\", which is the ruler's own maker and model and never the item's - and never mention these props in the description. "
    "SKIP STANDARD FEATURES: never mention construction details that every such item has — belt loops on jeans, buttons on a "
    "button-up, a zipper on a zip-up, care/size tags, standard stitching, hems, or pockets unless they are genuinely unusual. "
    "MATERIAL: mention material in the description ONLY if it is clearly stated on a label or unmistakable AND a selling point "
    "(100% cotton, wool, cashmere, silk, linen, leather, suede) — never list generic blends or guesses. "
    "NO MARKETING LANGUAGE: never use sales/hype phrases such as \"perfect for\", \"elevate your wardrobe\", \"must-have\", "
    "\"standout addition\", \"statement piece\", \"turn heads\", \"effortlessly\", \"high-energy\", \"delivers a bold aesthetic\", "
    "\"go-to\", or any call to action. Do NOT tell the buyer how they will look or feel, or who the item is perfect for. "
    "State facts only. Return only the JSON object, no prose."
)

_LOCAL_VISION_API_URL = "http://127.0.0.1:1235/v1/chat/completions"
_LOCAL_VISION_MODEL = "blackcat-vision"
_LOCAL_VISION_API_KEY_FILE = (
    Path(__file__).resolve().parents[2] / ".local" / "vision" / "api-key.txt"
)


def local_vision_asset_root() -> Path:
    """Resolve the desktop-selected asset folder; endpoints and key names stay fixed."""
    project_root = Path(__file__).resolve().parents[2]
    override = os.environ.get("BLACKCAT_VISION_ROOT", "").strip()
    if not override:
        return project_root / ".local" / "vision"
    candidate = Path(override)
    if not candidate.is_absolute():
        raise RuntimeError("BLACKCAT_VISION_ROOT must be an absolute folder")
    resolved = candidate.resolve()
    if resolved == project_root or resolved == Path(resolved.anchor):
        raise RuntimeError("BLACKCAT_VISION_ROOT must be a dedicated asset folder")
    return resolved


def _read_local_vision_api_key() -> str:
    """Read the fixed setup-owned credential within the selected asset folder."""
    credential = local_vision_asset_root() / "api-key.txt" if os.environ.get("BLACKCAT_VISION_ROOT", "").strip() else _LOCAL_VISION_API_KEY_FILE
    try:
        value = credential.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(
            "local vision API credential is missing; run npm.cmd run vision:setup"
        ) from exc
    if not re.fullmatch(r"[0-9a-f]{64}\n", value):
        raise RuntimeError(
            "local vision API credential is invalid; run npm.cmd run vision:setup"
        )
    return value[:-1]

# Canonical top-level categories (loose key -> canonical label). Anything else the
# model emits falls back to Title-Case of itself so a novel value is never lost.
_CATEGORIES = {
    "clothing": "Clothing", "garment": "Clothing", "apparel": "Clothing",
    "bag": "Bag", "bags": "Bag", "purse": "Bag", "handbag": "Bag",
    "jewelry": "Jewelry", "jewellery": "Jewelry",
    "hat": "Hat", "hats": "Hat", "headwear": "Hat",
    "shoes": "Shoes", "shoe": "Shoes", "footwear": "Shoes",
    "accessory": "Accessory", "accessories": "Accessory",
}


class VisionEnricher:
    def __init__(self, settings: Dict):
        self.enabled = bool(settings.get("visionEnabled", False))
        # Default = the app-managed llama.cpp vision sidecar (src/lib/visionServer.ts),
        # NOT the general-purpose LLM on :1234 — that port's model changes with the
        # rest of the machine's AI stack and is not guaranteed to have vision support.
        # This compatibility class is also used for image/field helpers by the
        # managed transport. Never allow it to reintroduce a remote endpoint or
        # arbitrary model override if it is instantiated directly.
        self.url = _LOCAL_VISION_API_URL
        self.model = _LOCAL_VISION_MODEL
        self.max_photos = int(settings.get("visionMaxPhotos", 4))
        self.fields = set(settings.get("visionFields", ["size", "color", "pattern", "itemType", "brand"]))
        self.timeout = float(settings.get("visionTimeoutSeconds", 120))
        # Generation budget per item. Big enough for a thinking model to reason AND
        # still emit the full JSON (the answer alone is ~650 tokens).
        self.max_tokens = int(settings.get("visionMaxTokens", 1800))
        self._cv2 = None
        self._reachable: Optional[bool] = None
        self._opener = _build_local_vision_opener().open
        # Endpoint-level failure tracking: after this many CONSECUTIVE endpoint
        # failures (unreachable / rejected the request), stop calling and stamp the
        # remaining items with the same error instantly. Per-item soft issues
        # (unparseable output, no photos) never trip it.
        self._endpoint_failures = 0
        self._dead_reason: Optional[str] = None
    _DEAD_AFTER = 2

    # ---- public --------------------------------------------------------------
    def enrich(self, sku: str, photo_metas: List[Dict]) -> Dict:
        """Return {fields:{...}, aiFields:[...], raw:{...}} or {} / {error:...}.

        A returned {"error": ...} means THIS item has no AI data (callers persist
        the reason per item); the batch itself always continues.
        """
        if not self.enabled or not self.fields:
            return {}
        if self._dead_reason:
            return {"error": self._dead_reason, "skipped": True}
        paths = self._pick_images(photo_metas)
        if not paths:
            return {"error": "no listing photos to analyze"}
        images = [self._encode(p) for p in paths]
        images = [b for b in images if b]
        if not images:
            return {"error": "photos could not be read/encoded for analysis"}
        # Per-item soft failures (truncated/unparseable/empty output) get ONE
        # immediate retry — a reasoning model occasionally overruns its budget on a
        # complex item, and a second sample usually lands (2026-08-05 22:17 batch:
        # 6/23 items). Endpoint-level failures never retry here; they short-circuit.
        last_soft: Optional[Dict] = None
        for attempt in (1, 2):
            try:
                raw = self._call(images)
            except urllib.error.HTTPError as e:
                # MUST come before URLError (HTTPError is a subclass): the server WAS
                # reachable but rejected the request. The 2026-08-05 blank batch was a
                # text-only model returning 500 "image input is not supported" — that
                # used to be mislabeled "unreachable" and silently swallowed.
                return {"error": self._note_endpoint_failure(_describe_http_error(e))}
            except urllib.error.URLError as e:
                self._reachable = False
                return {"error": self._note_endpoint_failure(
                    f"vision endpoint unreachable at {self.url}: {e.reason} "
                    "(is the vision model server running?)")}
            except TimeoutError:
                return {"error": self._note_endpoint_failure(
                    f"vision call timed out after {self.timeout:.0f}s")}
            except Exception as e:  # empty answer / budget-exhausted-thinking / defensive
                last_soft = {"error": f"vision call failed: {e}"}
                continue
            self._endpoint_failures = 0
            parsed = _parse_json(raw)
            if not parsed:
                last_soft = {"error": "vision returned unparseable output", "raw": raw}
                continue
            fields, ai_fields = self._map_fields(parsed)
            return {"fields": fields, "aiFields": ai_fields, "raw": parsed}
        return last_soft or {"error": "vision returned no usable output"}

    def _note_endpoint_failure(self, reason: str) -> str:
        """Count consecutive endpoint-level failures; kill the run's remaining
        calls once the endpoint is clearly down so 20 items don't each wait out
        a timeout against a dead server."""
        self._endpoint_failures += 1
        if self._endpoint_failures >= self._DEAD_AFTER and not self._dead_reason:
            self._dead_reason = reason
        return reason

    # ---- helpers -------------------------------------------------------------
    def _ensure_cv2(self):
        if self._cv2 is None:
            try:
                import cv2  # type: ignore
                self._cv2 = cv2
            except Exception:
                self._cv2 = False
        return self._cv2

    def _pick_images(self, photo_metas: List[Dict]) -> List[str]:
        # Listing photos only (skip the SKU/QR marker), keep display order.
        listing = [p for p in photo_metas if not p.get("isMarker") and p.get("storedPath")]
        if len(listing) <= self.max_photos:
            chosen = listing
        else:
            # Even spread so the first AND last shots (tags often come last) are seen.
            n, m = len(listing), self.max_photos
            idxs = sorted({round(i * (n - 1) / (m - 1)) for i in range(m)})
            chosen = [listing[i] for i in idxs]
        return [p["storedPath"] for p in chosen]

    def _encode(self, path: str, max_side: int = 1024, rotation: int = 0) -> Optional[str]:
        validate_rotation(rotation)
        cv2 = self._ensure_cv2()
        if not cv2:
            return None
        img = cv2.imread(path)
        if img is None:
            return None
        longest = max(img.shape[0], img.shape[1])
        if longest > max_side:
            s = max_side / float(longest)
            img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        img = rotate_cv_image(cv2, img, rotation)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            return None
        return base64.b64encode(buf.tobytes()).decode()

    def _call(self, images_b64: List[str]) -> str:
        content = [{"type": "text", "text": _PROMPT}]
        for b in images_b64:
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}"}})
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.0,
            # Budget covers THINKING models too: under llama.cpp's jinja template the
            # model may reason first (routed to reasoning_content), THEN emit the JSON.
            # The old 650 cap was fully consumed by reasoning and content came back
            # empty — the answer itself needs ~650, so leave real headroom on top.
            "max_tokens": self.max_tokens,
        }
        req = urllib.request.Request(
            self.url, data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {_read_local_vision_api_key()}",
            },
        )
        with self._opener(req, timeout=self.timeout) as r:
            out = json.load(r)
        self._reachable = True
        choice = out["choices"][0]
        msg = choice["message"]
        text = msg.get("content") or ""
        if not text.strip():
            # A reasoning model that hit the token cap mid-think returns empty content
            # with the whole budget in reasoning_content — surface that precisely
            # instead of the misleading "unparseable output".
            if msg.get("reasoning_content"):
                raise RuntimeError(
                    f"the model spent its whole token budget reasoning and never answered "
                    f"(finish_reason={choice.get('finish_reason')}) — raise visionMaxTokens "
                    f"(currently {self.max_tokens})")
            raise RuntimeError("the model returned an empty answer")
        return text

    def _map_fields(self, parsed: Dict):
        # The ruler in the measurement photos comes back as the brand, the model,
        # and the style number when the model reads its print; it leaves here,
        # before anything is mapped or stored. See props.py.
        scrubbed = props.scrub_vision(parsed)
        if scrubbed:
            parsed["propsScrubbed"] = scrubbed
        for key in ("model", "styleNumber"):
            # "WPL 10167" is the label's wool-products registration, not a product line.
            if tag_ocr.is_registration_number(parsed.get(key)):
                parsed[key] = None
        fields: Dict[str, str] = {}
        ai: List[str] = []
        # Near-miss spellings worth an operator's eye, recorded but never applied.
        suggestions: Dict[str, str] = {}

        def put(key: str, value):
            fields[key] = value
            ai.append(key)

        if "itemType" in self.fields:
            v = _clean(parsed.get("itemType"))
            if v:
                put("itemType", _ITEM_TYPES.get(v.lower().strip(), _TITLE(v)))
        # Top-level category always rides along when the model provides one (it is
        # not gated by visionFields — it exists to route the itemType downstream).
        cv = _clean(parsed.get("category"))
        if cv:
            put("category", _CATEGORIES.get(cv.lower().strip(), _TITLE(cv)))
        if "color" in self.fields:
            v = _clean(parsed.get("primaryColor"))
            if v:
                put("color", _TITLE(v))
        if "pattern" in self.fields:
            v = _clean(parsed.get("colorPattern"))
            if v:
                put("pattern", _PATTERNS.get(v.lower().strip(), _TITLE(v)))
        if "size" in self.fields:
            v = _clean(parsed.get("size"))
            if v:
                # Canonicalize letter sizes ("Large" -> "L", "xxl" -> "2XL"); numeric/
                # waist forms ("32", "32x34", "7") miss the map and pass through.
                canon = _SIZES.get(" ".join(v.replace(".", " ").lower().split()))
                put("size", canon or (v.strip().upper() if len(v.strip()) <= 4 else _TITLE(v)))
        if "brand" in self.fields:
            v = _clean(parsed.get("brand"))
            if v and v.lower() not in ("unknown", "n/a", "none", "no brand", "unbranded",
                                       "unknown brand", "no label", "not applicable", "na",
                                       "nil", "generic"):
                # Canonicalize a KNOWN spelling; an almost-match is only recorded
                # as a suggestion for review. Silently rewriting a near miss is
                # how an item gets confidently mislabelled.
                result = normalize.normalize_value("brand", v)
                put("brand", result.value)
                if result.suggestion:
                    suggestions["brand"] = result.suggestion
        # Material and fit are not gated fields -- they ride the raw JSON into
        # persist.ts -- but they are stored, so they get canonicalized in place.
        for raw_key, family in (("material", "material"), ("fit", "fit"),
                                ("secondaryColor", "color"), ("tertiaryColor", "color")):
            rv = _clean(parsed.get(raw_key))
            if rv:
                canon = normalize.normalize_value(family, rv)
                parsed[raw_key] = canon.value
                if canon.suggestion:
                    suggestions[raw_key] = canon.suggestion
        # Era rides the raw JSON (not a mapped field); still canonicalize obvious
        # variants ("y2k" -> "Y2K", "1990s" -> "90s") in place.
        ev = _clean(parsed.get("era"))
        if ev:
            parsed["era"] = _ERAS.get(ev.lower().strip(), ev)
        if suggestions:
            # Rides the raw JSON so Review can offer "did you mean...?" without
            # anything downstream having silently changed the stored value.
            parsed["normalizationSuggestions"] = suggestions
        return fields, ai


def _describe_http_error(e: "urllib.error.HTTPError") -> str:
    """Turn an HTTP error from the vision endpoint into an actionable message,
    including the server's own error text when it has one."""
    detail = ""
    try:
        body = e.read().decode(errors="replace").strip()
        detail = body[:200]
        try:
            parsed = json.loads(body)
            err = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(err, dict):
                detail = str(err.get("message") or "") or detail
            elif isinstance(err, str):
                detail = err
        except Exception:
            pass  # non-JSON body — keep the raw text
    except Exception:
        pass
    detail = (detail or "").strip()
    if "image input is not supported" in detail.lower() or "mmproj" in detail.lower():
        return (f"the model at the vision endpoint has NO VISION SUPPORT "
                f"(HTTP {e.code}: {detail or e.reason}) — a text-only model is "
                "loaded where a vision model is expected")
    if e.code == 404:
        return (f"vision endpoint rejected the request (HTTP 404): "
                f"{detail or 'model not found'} — is the configured model loaded?")
    return f"vision endpoint rejected the request (HTTP {e.code}): {detail or e.reason}"


def _clean(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() in ("null", "none", "n/a", "unknown", "unclear", "not visible", ""):
        return None
    return s


def _parse_json(text: str) -> Optional[Dict]:
    """Read one item object, tolerating ```json fences and surrounding prose."""
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```(?:json)?", "", t).strip()
    t = re.sub(r"```$", "", t).strip()
    try:
        parsed = json.loads(t)
        # Valid JSON can still be a list or scalar. Never pass it to field
        # mapping, or select an arbitrary nested item from an array answer.
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass
    m = re.search(r"\{.*\}", t, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group(0))
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None
    return None
