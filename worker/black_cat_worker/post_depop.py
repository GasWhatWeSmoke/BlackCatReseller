"""Post one app-reserved item DIRECTLY to Depop from its reviewed stdin payload.

Black Cat as its own publisher (§45): Depop has no public listing API, so this is
user-authorized ASSISTED posting, the exact contract the Nifty assist has always run
under: a normal, VISIBLE Chromium on the operator's own manually-logged-in profile
(var/depop-profile — separate from the Nifty profile, credentials isolated per
provider). No cookie/session extraction, no login or CAPTCHA bypass, no stealth,
nothing headless. It fills the same form the operator would fill and clicks the same
button they would click, while they watch.

  --mode post (default): fill the sell form, then click Depop's own Post button.
  --mode fill          : fill and STOP — the operator reads the form and posts it
                         themselves. The proving mode for a new/changed Depop UI.
  --login-only         : open installed Chrome WITHOUT Playwright/debugging so the
                          operator can complete Depop's security verification normally.

Automatic posting requires a current app publication reservation. Standalone
ready-folder calls can still use --mode fill for a manual form rehearsal.

The form is found LABEL-FIRST (visible text, not brittle CSS paths), and when a
required control cannot be found the run fails LOUDLY with a screenshot and a dump of
every control it could see (var/logs/depop-<sku>-controls.json) — so a Depop redesign
costs one supervised tuning run, not a mystery.

Output protocol (read by src/lib/publish/adapters/depop): progress lines, then one
  DEPOP_DONE {"outcome":"posted|filled|failed","url":...,"reason":...,...}
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

from .publish_progress import progress
from .publish_guard import assert_publish_authorized
from . import config
from .browser_form import (
    _find_button,
    _load_item_json,
    _ready_dir,
    _DISCOVER_JS,
)
from .assisted_browser import AssistedSession, run_manual_login
from .direct_listing import canonical_item_and_photos, read_listing_input
from .depop_form import fill_listing_fields
from .depop_sales import product_identity

# ---------------------------------------------------------------------------
# Pure helpers — no Playwright, no network. Tested in worker/tests/test_depop_logic.py.
# ---------------------------------------------------------------------------

# Depop allows at most 8 photos on a listing.
DEPOP_MAX_PHOTOS = 8
# Depop descriptions cap at 1000 characters.
DEPOP_DESC_MAX = 1000
# Depop convention: up to 5 hashtags carry search weight.
DEPOP_MAX_TAGS = 5

# Black Cat condition -> Depop's condition names, best candidate first. Depop's exact
# strings drift ("Used - Good" vs "Good"), so every mapping is a candidate LIST the
# picker tries in order — a vocabulary drift downgrades gracefully instead of failing.
DEPOP_CONDITION: Dict[str, List[str]] = {
    "New with tags": ["Brand new", "New"],
    "New without tags": ["Brand new", "New"],
    "Like new": ["Like new", "Excellent", "Used - Excellent"],
    "Good": ["Used - Good", "Good"],
    "Fair": ["Used - Fair", "Fair"],
    "Pre-owned": ["Used - Good", "Good"],
}


def build_hashtags(item: dict) -> List[str]:
    """Depop-style tags from what the item actually is — brand, type, style, color.
    Lowercased, alphanumeric only, deduped, capped at DEPOP_MAX_TAGS."""
    raw = [item.get("brand"), item.get("itemType"), item.get("style"),
           item.get("color"), item.get("pattern")]
    tags: List[str] = []
    for value in raw:
        if not value or str(value).strip().lower() == "unknown":
            continue
        tag = re.sub(r"[^a-z0-9]", "", str(value).lower())
        if len(tag) >= 2 and tag not in tags:
            tags.append(tag)
    return tags[:DEPOP_MAX_TAGS]


def build_description(item: dict) -> str:
    """Depop listings are description-led: the TITLE is the first line (that is what
    shows in search), the body follows, hashtags close. Trimmed to Depop's 1000-char
    cap — the title and tags always survive; only the body is shortened."""
    title = (item.get("title") or "").strip()
    body = (item.get("description") or "").strip()
    tags = " ".join(f"#{t}" for t in build_hashtags(item))
    fixed = len(title) + (len(tags) + 2 if tags else 0) + 2
    room = DEPOP_DESC_MAX - fixed
    if room < 0:
        room = 0
    if len(body) > room:
        body = body[: max(0, room - 1)].rstrip() + "…" if room > 20 else ""
    parts = [p for p in (title, body, tags) if p]
    return "\n\n".join(parts)[:DEPOP_DESC_MAX]


def build_depop_fields(item: dict) -> dict:
    """Everything the form needs, derived once and testable: the driver below only
    moves these values into controls."""
    return {
        "description": build_description(item),
        "brand": item.get("brand") if (item.get("brand") or "").lower() != "unknown" else None,
        "category_words": [w for w in [item.get("itemType"), item.get("categoryGroup")] if w],
        "size": item.get("size"),
        "condition_candidates": DEPOP_CONDITION.get(item.get("condition") or "", []),
        "color": item.get("color"),
        "price": item.get("price"),
    }


def photo_paths(ready_dir: str, listing_photos: List[str]) -> List[str]:
    """Absolute photo paths, cover first, capped at Depop's limit. The item.json
    order IS the export order (cover first), so [:8] keeps the right eight."""
    out = []
    for rel in listing_photos[:DEPOP_MAX_PHOTOS]:
        p = os.path.join(ready_dir, rel.replace("/", os.sep))
        if os.path.isfile(p):
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------

CREATE_URL = os.environ.get("BLACKCAT_DEPOP_CREATE_URL", "https://www.depop.com/products/create/")
LOGIN_URL = "https://www.depop.com/login/"


def _emit(line: str) -> None:
    print(line, flush=True)


def _done(payload: dict) -> None:
    _emit("DEPOP_DONE " + json.dumps(payload))


def _logs_dir(settings: dict) -> str:
    d = os.path.join(settings["dataRoot"], "logs")
    os.makedirs(d, exist_ok=True)
    return d


def _save_failure_artifacts(page, settings: dict, sku: str) -> None:
    """A screenshot + a dump of every visible control: the tuning kit for a Depop
    UI change. Saved next to the other worker logs; never fatal."""
    logs = _logs_dir(settings)
    try:
        page.screenshot(path=os.path.join(logs, f"depop-{sku}-fail.png"), full_page=True)
    except Exception:
        pass
    try:
        controls = page.evaluate(_DISCOVER_JS)
        with open(os.path.join(logs, f"depop-{sku}-controls.json"), "w", encoding="utf-8") as f:
            json.dump(controls, f, indent=1)
    except Exception:
        pass


def _looks_logged_out(page) -> bool:
    url = (page.url or "").lower()
    if "/login" in url or "/signup" in url:
        return True
    try:
        return page.evaluate("() => !!document.querySelector('input[type=password]')")
    except Exception:
        return False



def _photo_state(page):
    return page.evaluate("""() => {
      const images = [...document.querySelectorAll('[class*="thumbnailContainer"] img')];
      const ready = images.filter(image => {
        try { return image.complete && image.naturalWidth > 0 &&
          new URL(image.currentSrc || image.src).hostname === 'media-photos.depop.com'; }
        catch { return false; }
      }).length;
      return { total: images.length, ready };
    }""")


def _wait_for_photos(page, expected):
    deadline = time.time() + 90
    retries = {}
    while time.time() < deadline:
        state = _photo_state(page)
        if state['ready'] == expected and state['total'] == expected:
            return expected
        if state['total'] == expected:
            _retry_failed_photos(page, expected, retries)
        page.wait_for_timeout(500)
    raise ValueError(f"Only {_photo_state(page)['ready']} of {expected} Depop photos finished uploading")


def _retry_failed_photos(page, expected, retries):
    from playwright.sync_api import TimeoutError as BrowserTimeout
    images = page.locator('[class*="thumbnailContainer"] img')
    if images.count() != expected:
        return
    for index in range(expected):
        # Retry only a failed existing image, never set_input_files again or
        # repeat a successful attachment. Limit each tile to two native retries.
        tile = images.nth(index).locator('xpath=ancestor::*[count(.//img)=1 and .//button[normalize-space()="Retry"]][1]')
        if tile.count() != 1 or retries.get(index, 0) >= 2:
            continue
        retry = tile.get_by_role('button', name='Retry', exact=True)
        try:
            if retry.count() == 1 and retry.is_visible() and retry.is_enabled(timeout=1000) and 'Upload failed' in tile.inner_text(timeout=1000):
                page.wait_for_timeout(1000)
                if retry.count() != 1 or not retry.is_visible() or 'Upload failed' not in tile.inner_text(timeout=1000):
                    continue  # Depop may have completed its own retry during the pause.
                retries[index] = retries.get(index, 0) + 1
                retry.click(timeout=2000)
        except BrowserTimeout:
            # The native upload may finish between any two locator reads, not
            # just during the delay or click. The outer loop still requires
            # every expected image to finish uploading before publication.
            if retry.count() and retry.is_visible():
                raise


def _upload_photos(page, paths: List[str]) -> int:
    from playwright.sync_api import TimeoutError as BrowserTimeout
    inputs = page.query_selector_all("input[type=file]")
    if not inputs:
        return 0
    if _photo_state(page)['total']:
        raise ValueError("The Depop form already contains photos; open a fresh listing before retrying")
    # Confirm each original before adding the next. Bulk selections can stall
    # together or exceed the remote transport limit; this also fixes cover order.
    for count, filename in enumerate(paths, 1):
        try: page.query_selector("input[type=file]").set_input_files(filename)
        # A timed-out selection may still finish. Check it, never reattach it.
        except BrowserTimeout: pass
        _wait_for_photos(page, count)
    return len(paths)


def run_login_only(settings: dict) -> int:
    profile_dir = os.path.join(settings["dataRoot"], "depop-profile")
    try:
        run_manual_login(profile_dir, LOGIN_URL)
    except Exception as exc:
        _done({"outcome": "failed", "reason": str(exc)})
        return 1
    _done({
        "outcome": "filled",
        "reason": "manual-login-window-closed",
        "message": "login window closed — confirm in Black Cat that you finished signing in",
    })
    return 0


def posted_product_identity(value):
    location = urlsplit(value)
    match = re.fullmatch(r'/products/([a-z0-9][a-z0-9-]*)/manage/?', location.path, re.I)
    if match: value = location._replace(path=f'/products/{match[1]}/', query='', fragment='').geturl()
    return product_identity(value)


def submitted_listing_url(page):
    """Follow Depop's success-page View listing control, never its Post button."""
    from playwright.sync_api import expect
    identity = posted_product_identity(page.url)
    if identity: return identity['url']
    location = urlsplit(page.url)
    if location.scheme != 'https' or location.hostname not in {'www.depop.com','depop.com'} or location.port or location.username or location.password or location.path.rstrip('/') != '/products/create/success':
        return None
    product_ids = parse_qs(location.query).get('productId', [])
    if len(product_ids) != 1 or not re.fullmatch(r'\d+', product_ids[0]):
        raise ValueError('Depop success page did not identify the submitted item')
    expect(page.get_by_role('heading', name="Nice! It's listed", exact=True)).to_be_visible(timeout=15000)
    view = page.get_by_role('link', name='View listing', exact=True).or_(page.get_by_role('button', name='View listing', exact=True))
    expect(view).to_have_count(1)
    view.click()
    page.wait_for_url(lambda value: posted_product_identity(value) is not None, timeout=30000, wait_until='domcontentloaded')
    identity = posted_product_identity(page.url)
    if not identity: raise ValueError('Depop did not open the submitted listing')
    return identity['url']


def run_post(settings: dict, sku: str, ready_override: Optional[str], mode: str, canonical: Optional[dict] = None) -> int:
    from playwright.sync_api import sync_playwright

    submission_started = False

    def report(payload: dict) -> None:
        _done({**payload, "submissionStarted": submission_started})

    try:
        if canonical is not None:
            item, all_photos = canonical_item_and_photos(canonical, sku)
            photos = all_photos[:DEPOP_MAX_PHOTOS]
        else:
            # Keep standalone fill-mode loading compatible; app jobs pass the
            # current canonical listing through stdin.
            ready = _ready_dir(settings, sku, ready_override)
            item = _load_item_json(ready)
            photos = photo_paths(ready, item.get("listingPhotos") or [])
        if mode == "post":
            assert_publish_authorized(item.get("itemId"), sku, "depop", photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
    except Exception as exc:
        report({"outcome": "failed", "reason": str(exc)})
        return 1
    fields = build_depop_fields(item)
    total_photos = len(item.get("listingPhotos") or [])
    if not photos:
        report({"outcome": "failed", "reason": "no listing photos found in the ready folder"})
        return 1
    if fields["price"] is None:
        report({"outcome": "failed", "reason": "item.json carries no price"})
        return 1

    profile_dir = os.path.join(settings["dataRoot"], "depop-profile")

    with sync_playwright() as pw:
        session = AssistedSession(pw, profile_dir, port_hint=9333, start_url=CREATE_URL)
        page = session.page
        try:
            progress('opening')
            _emit(f"[depop] {sku}: opening the sell form")
            try:
                page.goto(CREATE_URL, wait_until="domcontentloaded")
            except Exception:
                pass  # real Chrome already opened start_url; a re-nav can race harmlessly
            page.wait_for_timeout(2500)

            if _looks_logged_out(page):
                report({"outcome": "failed", "reason": "not-logged-in",
                       "message": "Depop wants a login — use Log in to Depop on the Publish page, then retry"})
                return 1

            _emit(f"[depop] {sku}: uploading {len(photos)} photo(s)"
                  + (f" (Depop's limit is {DEPOP_MAX_PHOTOS}; item has {total_photos})"
                     if total_photos > DEPOP_MAX_PHOTOS else ""))
            progress('photos', len(photos))
            uploaded = _upload_photos(page, photos)
            if uploaded == 0:
                _save_failure_artifacts(page, settings, sku)
                report({"outcome": "failed", "reason": "no file input found on the sell page — see the controls dump"})
                return 1

            progress('details')
            filled = fill_listing_fields(page, item, fields,
                                         publish_options=(settings.get("publish") or {}).get("depop") or {})
            progress('checking')
            _emit(f"[depop] {sku}: verified {json.dumps(filled)}")

            if mode == "fill":
                submission_started = True  # The operator can now press Post.
                report({"outcome": "filled", "filled": filled,
                       "uploadedPhotos": uploaded, "totalPhotos": total_photos,
                       "message": "form filled — review the window and press Post yourself"})
                # Leave the window open for the operator; they close it when done.
                session.wait_until_closed(1800)
                return 0

            # mode post: click Depop's own Post button and wait to land on the listing.
            btn = _find_button(page, ["post your item", "post item", "post", "publish", "list item"],
                               avoid=["draft", "save"])
            if not btn:
                _save_failure_artifacts(page, settings, sku)
                report({"outcome": "failed", "reason": "no Post button found — see the controls dump", "filled": filled})
                return 1
            _emit(f"[depop] {sku}: posting")
            assert_publish_authorized(item.get("itemId"), sku, "depop", photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
            submission_started = True  # A click timeout may still have submitted.
            progress('publishing')
            btn.click()
            progress('verifying')

            listing_url = None
            deadline = time.time() + 120
            while time.time() < deadline:
                page.wait_for_timeout(1500)
                listing_url = submitted_listing_url(page)
                if listing_url: break
                # A validation error surfacing on the form means Depop refused it.
                try:
                    err = page.evaluate(
                        "() => { const e = document.querySelector('[role=alert], [class*=error]');"
                        " return e && e.textContent ? e.textContent.trim().slice(0, 300) : null; }")
                except Exception:
                    err = None
                if err:
                    _save_failure_artifacts(page, settings, sku)
                    report({"outcome": "failed", "reason": f"Depop rejected the listing: {err}", "filled": filled})
                    return 1

            if listing_url:
                report({"outcome": "posted", "url": listing_url,
                       "uploadedPhotos": uploaded, "totalPhotos": total_photos,
                       "message": (f"{uploaded} of {total_photos} photos (Depop's {DEPOP_MAX_PHOTOS}-photo limit)"
                                   if total_photos > uploaded else None)})
                return 0
            _save_failure_artifacts(page, settings, sku)
            report({"outcome": "failed",
                   "reason": "clicked Post but never landed on a listing page — check the window/screenshot",
                   "filled": filled})
            return 1
        except Exception as exc:
            _save_failure_artifacts(page, settings, sku)
            report({"outcome": "failed", "reason": str(exc)})
            return 1
        finally:
            session.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sku")
    ap.add_argument("--ready-dir")
    ap.add_argument("--mode", choices=["post", "fill"], default="post")
    ap.add_argument("--login-only", action="store_true")
    ap.add_argument("--listing-stdin", action="store_true")
    args = ap.parse_args()

    try:
        settings = config.load_settings()
    except Exception as e:  # pragma: no cover - config failure is environmental
        _done({"outcome": "failed", "reason": f"could not load settings: {e}"})
        return 1

    try:
        if args.login_only:
            return run_login_only(settings)
        if not args.sku:
            _done({"outcome": "failed", "reason": "--sku is required (or --login-only)"})
            return 1
        canonical = None
        if args.listing_stdin:
            try:
                canonical = read_listing_input(sys.stdin.buffer)
            except Exception as exc:
                _done({"outcome": "failed", "reason": f"Invalid direct listing: {exc}", "submissionStarted": False})
                return 1
        return run_post(settings, args.sku, args.ready_dir, args.mode, canonical)
    except ModuleNotFoundError as e:
        _done({"outcome": "failed", "reason": f"Playwright is not installed for the worker: {e}"})
        return 1
    except Exception as e:
        _done({"outcome": "failed", "reason": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
