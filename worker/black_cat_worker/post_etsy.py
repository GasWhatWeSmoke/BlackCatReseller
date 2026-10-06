"""Native Etsy publishing through the user's persistent, authorized Chrome session."""
import argparse
import json
import re
import sys
from urllib.parse import urlsplit

from .publish_progress import progress
from . import config
from .chrome_editor import new_chrome_editor
from .direct_listing import canonical_item_and_photos, read_listing_input
from .etsy_form import (reviewed_core, fill_category, fill_size, fill_reviewed_core,
                        fill_shipping_profile, fill_package, set_renewal, attach_photos,
                        verify_filled_listing)
from .publish_guard import assert_publish_authorized

CREATE_URL = "https://www.etsy.com/your/shops/me/listing-editor/create"


def listing_url(value):
    if not isinstance(value, str): return None
    try:
        url = urlsplit(value)
        match = re.fullmatch(r"/listing/(\d+)(?:/[^/]+)?/?", url.path)
        if url.scheme != "https" or url.hostname not in {"www.etsy.com", "etsy.com"} or url.port or url.username or url.password or not match:
            return None
        return f"https://www.etsy.com{url.path}"
    except (TypeError, ValueError):
        return None


def listing_id(value):
    valid = listing_url(value)
    return urlsplit(valid).path.split("/")[2] if valid else None


def image_id(value):
    if not isinstance(value, str): return None
    try:
        url = urlsplit(value)
        match = re.search(r"/(\d+)/il_[^/]+$", url.path)
        return match[1] if url.scheme == "https" and url.hostname == "i.etsystatic.com" and match else None
    except (TypeError, ValueError):
        return None


def wait_published_url(page, title, before_url):
    candidate = page.wait_for_function("""({title,before})=>{
      const valid=value=>{try{const u=new URL(value);return u.protocol==='https:'&&
        ['www.etsy.com','etsy.com'].includes(u.hostname)&&/^\\/listing\\/\\d+(?:\\/[^/]+)?\\/?$/.test(u.pathname)}catch{return false}};
      if(location.href!==before){
        if(valid(location.href))return location.href;
        const edit=location.pathname.match(/^\\/your\\/shops\\/[^/]+\\/listing-editor\\/edit\\/(\\d+)$/);
        if(edit)return 'https://www.etsy.com/listing/'+edit[1];
        if(/^\\/your\\/shops\\/[^/]+\\/tools\\/listings/.test(location.pathname))return 'seller-listings';
      }
      const links=[...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length &&
        (a.textContent.trim()===title||/^(view listing|view on etsy)$/i.test(a.textContent.trim())||
         a.closest('.wt-alert--success'))).map(a=>a.href).filter(valid);
      const unique=[...new Set(links)];return unique.length===1?unique[0]:false;
    }""", arg={"title": title, "before": before_url}, timeout=120000).json_value()
    if candidate == "seller-listings": return None
    result = listing_url(candidate)
    if not result:
        raise ValueError("Etsy did not identify one published listing")
    return result


def verify_product_page(page, url, title, cover_id, timeout=30000):
    from playwright.sync_api import expect
    response = page.goto(url, wait_until="domcontentloaded", timeout=timeout)
    if not response or response.status != 200 or listing_id(page.url) != listing_id(url):
        raise ValueError("Etsy's public listing did not load at the confirmed URL")
    expect(page.get_by_role("heading", name=title, level=1, exact=True)).to_be_visible(timeout=timeout)
    expect(page.locator(f'img.carousel-image[src*="/{cover_id}/il_"]')).not_to_have_count(0, timeout=timeout)
    form = page.locator("form.add-to-cart-form")
    expect(form).to_have_count(1, timeout=timeout)
    expect(form.locator('input[name="listing_id"]')).to_have_value(listing_id(url), timeout=timeout)
    expect(form.get_by_role("button", name=re.compile(r"^Add to cart$", re.I))).to_be_enabled(timeout=timeout)
    return listing_url(page.url)


def verify_live_listing(page, url, title, cover_id, sku, timeout=30000, item=None):
    """Require both Active inventory and the matching purchasable product page.

    Etsy blocks this machine's signed-out browsers. This uses the authorized
    seller session and does not mistake an owner-only draft preview for Active.
    """
    from playwright.sync_api import expect
    expected_id = listing_id(url) if url else None
    page.goto("https://www.etsy.com/your/shops/me/tools/listings", wait_until="domcontentloaded", timeout=timeout)
    active = page.locator('input[name="item_status"][value="active"]')
    expect(active).to_be_checked(timeout=timeout)
    search = page.get_by_placeholder("Search by title, tag, or SKU", exact=True)
    # A newly published SKU may not be indexed yet. Read the active card and
    # its uploaded cover, then verify the actual stored SKU in the editor.
    search.fill('')
    search.press("Enter")
    expect(search).to_have_value('')
    cards = page.locator('main a[href*="/listing-editor/edit/"]:visible').filter(has=page.get_by_text(title, exact=True))
    if expected_id:
        cards = cards.and_(page.locator(f'a[href$="/listing-editor/edit/{expected_id}"]'))
    try:
        expect(cards).to_have_count(1, timeout=timeout)
    except AssertionError:
        if cards.count() != 0:
            raise  # Duplicate titles are ambiguous, not a refresh problem.
        # Etsy can return stale seller inventory immediately after Publish.
        # Refresh that read once; never repeat either publication click.
        page.reload(wait_until="domcontentloaded", timeout=timeout)
        expect(active).to_be_checked(timeout=timeout)
        expect(search).to_have_value('', timeout=timeout)
        expect(cards).to_have_count(1, timeout=timeout)
    expect(cards.locator("img").first).to_have_attribute("src", re.compile(r"/" + re.escape(cover_id) + r"/il_"), timeout=timeout)
    match = re.search(r"/listing-editor/edit/(\d+)(?:\?|$)", cards.get_attribute("href") or "")
    if not match or expected_id and match[1] != expected_id:
        raise ValueError("Etsy did not identify the expected Active listing")
    expect(active).to_be_checked()
    # Read the stored private SKU as well: a search input echo is not proof that
    # its results finished updating. No fields or listing settings are changed.
    page.goto(f"https://www.etsy.com/your/shops/me/listing-editor/edit/{match[1]}", wait_until="domcontentloaded", timeout=timeout)
    expect(page.locator("#listing-sku-input")).to_have_value(sku, timeout=timeout)
    if item is not None:
        from .etsy_custom_size import custom_size_value, custom_size_in_use, verify_custom_size
        if custom_size_value(item) is not None:
            if custom_size_in_use(page, item): verify_custom_size(page, item)
            else:
                from .etsy_form import verify_native_size
                verify_native_size(page, item)
    return verify_product_page(page, f"https://www.etsy.com/listing/{match[1]}", title, cover_id, timeout=timeout)


def run_on_page(page, item, photos, options, mode, authorize, verify):
    submitted = False
    candidate_url = None
    try:
        if mode not in {"fill", "post"}:
            raise ValueError("Invalid Etsy publishing mode")
        reviewed_core(item)
        if not isinstance(options.get("shippingProfileName"), str) or not options["shippingProfileName"].strip() or type(options.get("autoRenew")) is not bool:
            raise ValueError("Etsy shipping and renewal settings are missing")
        if mode == "post": authorize()
        progress('opening')
        page.locator("#listing-title-input").wait_for(timeout=30000)
        progress('details')
        fill_category(page, item)
        fill_reviewed_core(page, item)
        fill_shipping_profile(page, options["shippingProfileName"])
        fill_package(page, item)
        fill_size(page, item)
        set_renewal(page, options["autoRenew"])
        progress('photos', len(photos))
        attached = attach_photos(page, photos)
        progress('checking')
        verify_filled_listing(page, item, options, photos)
        if mode == "fill":
            return {"outcome": "filled", "submissionStarted": False, "uploadedPhotos": attached,
                    "message": "Verified Etsy form and photos; closed without clicking Publish."}
        cover = image_id(page.locator("#field-listingImages img").first.evaluate("e=>e.currentSrc||e.src"))
        if not cover:
            raise ValueError("Etsy did not identify the uploaded cover photo")
        authorize()
        progress('publishing')
        submitted = True  # Even the first Publish must not be retried on uncertainty.
        page.locator("main").get_by_role("button", name="Publish", exact=True).click()
        dialog = page.locator("#wt-portals .wt-overlay__modal:visible").filter(
            has_text="You are about to publish a new listing")
        from playwright.sync_api import expect
        expect(dialog).to_be_visible(timeout=30000)
        expect(dialog).to_contain_text("$0.20 USD")
        authorize()
        before_url = page.url
        dialog.get_by_role("button", name="Publish", exact=True).click()
        progress('verifying')
        url = wait_published_url(page, item["title"], before_url)
        candidate_url = url
        verified = verify(url, item["title"], cover)
        if not listing_url(verified) or url and listing_id(verified) != listing_id(url):
            raise ValueError("Public verification did not confirm the submitted Etsy listing")
        return {"outcome": "posted", "submissionStarted": True, "url": verified, "uploadedPhotos": attached}
    except Exception as error:
        if submitted:
            candidate_url = listing_url(page.url) or candidate_url
            location = urlsplit(page.url) if isinstance(page.url, str) else None
            match = re.fullmatch(r"/your/shops/[^/]+/listing-editor/edit/(\d+)", location.path) if location else None
            if match and location.scheme == "https" and location.hostname == "www.etsy.com":
                candidate_url = f"https://www.etsy.com/listing/{match[1]}"
        return {"outcome": "failed", "submissionStarted": submitted,
                **({"url": candidate_url} if candidate_url else {}),
                "reason": f"{type(error).__name__}: {str(error)[:1500]}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sku", required=True)
    parser.add_argument("--mode", choices=["fill", "post"], default="fill")
    parser.add_argument("--listing-stdin", action="store_true", required=True)
    args = parser.parse_args()
    report = {"outcome": "failed", "submissionStarted": False}
    try:
        item, photos = canonical_item_and_photos(read_listing_input(sys.stdin.buffer), args.sku)
        options = config.load_settings().get("publish", {}).get("etsy", {})
        if options.get("enabled") is not True:
            raise ValueError("Enable Etsy direct posting in Settings first")
        options = {**options, "autoRenew": options.get("autoRenew", False)}
        authorize = lambda: assert_publish_authorized(item.get("itemId"), item["sku"], "etsy", photo_snapshot=item.get("photoSnapshot"), photo_paths=item.get("listingPhotos"))
        if args.mode == "post": authorize()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            with new_chrome_editor(pw, CREATE_URL, timeout=60000) as page:
                report = run_on_page(page, item, photos, options, args.mode, authorize,
                                     lambda *values: verify_live_listing(page, *values, sku=item["sku"], item=item))
    except Exception as error:
        if report.get("outcome") == "posted":
            report["message"] = "Publication verified; browser cleanup needs attention"
        else:
            report = {**report, "outcome": "failed", "reason": f"{type(error).__name__}: {str(error)[:1500]}"}
    print("ETSY_DONE " + json.dumps(report), flush=True)
    return 0 if report["outcome"] in {"posted", "filled"} else 1


if __name__ == "__main__": sys.exit(main())
