"""Visible native Poshmark posting, using the app's reviewed listing over stdin."""
import argparse
import json
import os
import re
from contextlib import ExitStack
from .work_browser import keep_work_page_ready, verification_page
import sys
from urllib.parse import urlsplit

from .publish_progress import progress
from .publish_guard import assert_publish_authorized
from . import config
from .assisted_browser import AssistedSession
from .direct_listing import canonical_item_and_photos, read_listing_input
from .poshmark_form import attach_photos, fill_listing_fields, verify_quantity, whole_price, verify_reviewed_size_selection

CREATE_URL = "https://poshmark.com/create-listing"


def listing_url(value, expected_id):
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.hostname not in {"poshmark.com", "www.poshmark.com"} or url.port or url.username or url.password:
            return None
        if not re.fullmatch(r"[a-f0-9]{24}", expected_id): return None
        if not re.fullmatch(rf"/listing/(?:[^/]+-)?{expected_id}/?", url.path): return None
        return f"https://poshmark.com{url.path}"
    except (TypeError, ValueError): return None


def title_listing_url(title,expected_id):
    # The immutable ID identifies the resource; anonymous title verification
    # below is still required. The readable prefix avoids broken bare-ID routes.
    slug='-'.join(re.sub(r'[^A-Za-z0-9\s]','',str(title or '')).split())
    return listing_url(f'https://poshmark.com/listing/{slug}-{expected_id}',expected_id) if slug else None


def prepare_submission(page, item):
    from playwright.sync_api import expect
    verify_quantity(page, item)
    expect(page.get_by_placeholder("What are you selling? (required)", exact=True)).to_have_value(item["title"])
    expect(page.get_by_placeholder("Describe it! (required)", exact=True)).to_have_value(item["description"])
    expect(page.locator('input[data-vv-name="listingPrice"]')).to_have_value(whole_price(item["price"]))
    expect(page.get_by_role("textbox", name="sku", exact=True)).to_have_value(item["sku"])
    expected_id = page.locator('[data-et-name="listingEditorImageSection"]').get_attribute("data-et-prop-listing_id")
    if not re.fullmatch(r"[a-f0-9]{24}", expected_id or ""):
        raise ValueError("Poshmark did not identify the new listing before submission")
    page.get_by_role("button", name="Next", exact=True).click()
    return final_review_button(page, item['title'], expected_id), expected_id


def final_review_button(page, title, expected_id):
    """Both new listings and edits finish on this same native review screen."""
    from playwright.sync_api import expect
    panel = page.locator(".listing-editor__share--body")
    final = panel.get_by_role("button", name="List This Item", exact=True)
    expect(final).to_be_visible(timeout=60_000)
    expect(final).to_have_attribute("data-et-prop-listing_id", expected_id)
    expect(panel.get_by_role("heading", name=title, exact=True)).to_be_visible()
    # These switches cover optional promotions, social networks and Posh Parties.
    # Inputs are visually hidden; their native labels are the clickable controls.
    switches = panel.locator('input[data-test="toggle-input"]')
    for index in range(switches.count()):
        switch = switches.nth(index)
        if switch.is_checked(): switch.locator("..").click()
        expect(switch).not_to_be_checked()
    return final


def verify_public_listing(page, expected_id, title, publication_timeout=45000):
    from playwright.sync_api import expect, TimeoutError as BrowserTimeout
    known = listing_url(f"https://poshmark.com/listing/{expected_id}", expected_id)
    if not known: raise ValueError("Poshmark did not identify the submitted listing")
    def rendered_url():
        links=page.locator('a[href*="/listing/"]').evaluate_all('els=>els.map(e=>e.href)')
        matching={value for link in links if (value:=listing_url(link,expected_id))}
        return next(iter(matching)) if len(matching)==1 else None
    # Prefer the actual published permalink. Poshmark can return404 for the
    # bare item-number URL while its title-prefixed permalink works normally.
    url = rendered_url() or known
    # A private draft can be visible to its owner. Check the returned URL in a
    # separate context with no signed-in cookies before reporting publication.
    browser = page.context.browser
    if browser is None: raise ValueError("Cannot verify the Poshmark listing publicly")
    with verification_page(page, anonymous=True) as check:
        response = check.goto(url, wait_until="domcontentloaded", timeout=30_000)
        if response and response.status==404 and url==known and urlsplit(page.url).hostname in {"poshmark.com","www.poshmark.com"}:
            # The successful post may still be navigating back to its closet.
            # Keep that page alive and wait for its exact new item link.
            keep_work_page_ready(page)
            try:
                page.wait_for_function('''id=>[...document.querySelectorAll('a[href*="/listing/"]')].some(e=>{
                  try{const u=new URL(e.href);return ['poshmark.com','www.poshmark.com'].includes(u.hostname)&&
                    new RegExp('^/listing/(?:[^/]+-)?'+id+'/?$').test(u.pathname)}catch{return false}})''',arg=expected_id,timeout=15000)
            except BrowserTimeout:pass
            linked=rendered_url() or title_listing_url(title,expected_id)
            if linked and linked!=known:
                keep_work_page_ready(check)
                response=check.goto(linked,wait_until='domcontentloaded',timeout=30000)
        if response and response.status==404 and urlsplit(page.url).hostname in {"poshmark.com","www.poshmark.com"}:
            from time import monotonic
            deadline=monotonic()+publication_timeout/1000
            # An optimistic item link can precede the actual save. Keep the
            # submitting page alive and responsive; retry only the public read.
            while response.status==404 and monotonic()<deadline:
                keep_work_page_ready(page)
                page.wait_for_timeout(min(1000,max(1,int((deadline-monotonic())*1000))))
                target=rendered_url() or title_listing_url(title,expected_id) or known
                keep_work_page_ready(check)
                response=check.goto(target,wait_until='domcontentloaded',timeout=30000)
                if response is None:break
        if not response or response.status != 200:
            raise ValueError("Poshmark's public listing page did not load successfully")
        expect(check.get_by_role("heading", name=title, level=1, exact=True)).to_be_visible(timeout=30_000)
        verified = listing_url(check.url, expected_id)
        if not verified: raise ValueError("Poshmark redirected away from the submitted listing")
        return verified


def native_write_error(response, expected_id):
    """Read only the current listing's native save/publish error, never headers."""
    location = urlsplit(response.url)
    if not expected_id or location.scheme != 'https' or location.hostname not in {'poshmark.com', 'www.poshmark.com'} or location.port not in {None, 443} or location.username or location.password:
        return None
    if location.path not in {f'/vm-rest/posts/{expected_id}', f'/vm-rest/posts/{expected_id}/status/published'}:
        return None
    if response.request.method not in {'POST', 'PUT'}:
        return None
    data = response.json()
    error = data.get('error') if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return None
    kind = error.get('errorType')
    if not isinstance(kind, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', kind):
        return None
    params = error.get('params')
    if kind == 'PostValidationError' and isinstance(params, dict) and params.get('certify_action') is True and params.get('certify_reason') == 'not_allowed':
        return 'Poshmark requires seller certification: this listing was flagged as potentially prohibited. Review its Certify Listing prompt before retrying.'
    code = error.get('statusCode')
    operation = 'publication' if location.path.endswith('/status/published') else 'saving'
    return f'Poshmark rejected {operation}: {kind}' + (f' ({code})' if type(code) is int and 400 <= code <= 599 else '')


def run_on_page(page, item, photos, mode, verify=verify_public_listing):
    submitted = False
    expected_id = None
    photo_lifetime = ExitStack()
    native_errors = []
    def observe(response):
        try:
            message = native_write_error(response, expected_id)
            if message and message not in native_errors: native_errors.append(message)
        except Exception: pass  # Diagnostics must not change publication uncertainty.
    page.on('response', observe)
    try:
        if mode == "post":
            assert_publish_authorized(item.get("itemId"), item.get("sku"), "poshmark", photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
        progress('opening')
        page.goto(CREATE_URL, wait_until="domcontentloaded", timeout=30_000)
        page.get_by_placeholder("What are you selling? (required)", exact=True).wait_for(timeout=30_000)
        progress('details')
        filled = fill_listing_fields(page, item)
        progress('photos', len(photos))
        attached = attach_photos(page, photos, lifetime=photo_lifetime)
        verify_reviewed_size_selection(page, filled)
        progress('checking')
        final, expected_id = prepare_submission(page, item)
        if mode == "fill":
            return {"outcome": "filled", "submissionStarted": False, "filled": filled,
                    "attachedPhotos": attached, "message": "Verified final review; closed without clicking List This Item."}
        assert_publish_authorized(item.get("itemId"), item.get("sku"), "poshmark", photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
        submitted = True  # A click timeout may still have published. Never auto-retry it.
        progress('publishing')
        final.click()
        progress('verifying')
        url = verify(page, expected_id, item["title"])
        return {"outcome": "posted", "submissionStarted": True, "url": url, "attachedPhotos": attached}
    except Exception as error:
        return {"outcome": "failed", "submissionStarted": submitted,
                **({"url": title_listing_url(item['title'],expected_id) or f"https://poshmark.com/listing/{expected_id}"} if submitted and expected_id else {}),
                "reason": '; '.join(native_errors + [f"{type(error).__name__}: {str(error)[:1500]}"])}
    finally:
        page.remove_listener('response', observe)
        photo_lifetime.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sku", required=True)
    parser.add_argument("--mode", choices=["post", "fill"], default="fill")
    parser.add_argument("--listing-stdin", action="store_true", required=True)
    args = parser.parse_args()
    report = {"outcome": "failed", "submissionStarted": False}
    try:
        item, photos = canonical_item_and_photos(read_listing_input(sys.stdin.buffer), args.sku)
        if len(photos) > 16: raise ValueError("Poshmark accepts at most 16 photos; choose the listing photos in Review")
        if args.mode == "post":
            assert_publish_authorized(item.get("itemId"), item["sku"], "poshmark", photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
        settings = config.load_settings()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            session = AssistedSession(pw, os.path.join(settings["dataRoot"], "poshmark-profile"), port_hint=9337)
            try: report = run_on_page(session.page, item, photos, args.mode)
            finally: session.close()
    except Exception as error:
        report = {**report, "outcome": "failed", "reason": f"{type(error).__name__}: {str(error)[:1500]}"}
    print("POSHMARK_DONE " + json.dumps(report), flush=True)
    return 0 if report["outcome"] in {"posted", "filled"} else 1


if __name__ == "__main__": sys.exit(main())
