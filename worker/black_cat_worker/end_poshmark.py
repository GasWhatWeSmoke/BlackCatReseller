"""Make a sale-linked Poshmark listing Not For Sale through the native editor."""
import argparse
import json
import os
import re
from .work_browser import verification_page
import sys
from time import monotonic
from urllib.parse import urlsplit

from . import config
from .assisted_browser import AssistedSession
from .delist_guard import assert_delist_authorized
from .direct_listing import read_listing_input
from .post_poshmark import listing_url, final_review_button


def inspect_availability(page, url, expected_id):
    from playwright.sync_api import expect
    target = listing_url(url, expected_id)
    if not target: raise ValueError("Poshmark removal URL does not identify the expected listing")
    response = page.goto(target, wait_until="domcontentloaded", timeout=30_000)
    if not response or response.status != 200:
        raise ValueError("Poshmark listing did not load; absence or a login page is not removal proof")
    title = page.locator("h1.listing__title--redesign")
    expect(title).to_be_visible(timeout=30_000)
    if not listing_url(page.url, expected_id): raise ValueError("Poshmark redirected to a different listing")
    page.wait_for_function("""() => [...document.querySelectorAll('.ldp-inventory-badge__label,a[data-et-name=edit_listing]')]
      .some(e=>e.getClientRects().length)""", timeout=15_000)
    badges = {text.strip().casefold() for text in page.locator(".ldp-inventory-badge__label:visible").all_text_contents()}
    if badges and badges <= {"sold", "not for sale"}:
        return {"state": "unavailable", "reason": ", ".join(sorted(badges)), "url": page.url, "title": title.inner_text().strip()}
    if not badges and page.locator('a[data-et-name="edit_listing"]:visible').count() == 1:
        return {"state": "editable", "url": page.url, "title": title.inner_text().strip()}
    raise ValueError("Poshmark availability could not be verified")


def remove_listing(page, request, authorize):
    from playwright.sync_api import expect
    started = False
    expected_id, url = request["externalListingId"], request["externalUrl"]
    try:
        authorize()
        state = inspect_availability(page, url, expected_id)
        if state["state"] == "unavailable":
            return {"outcome": "ended", "verified": True, "externalListingId": expected_id,
                    "submissionStarted": False, "url": state["url"]}
        page.locator('a[data-et-name="edit_listing"]:visible').click()
        native_id = page.locator('[data-et-name="listingEditorImageSection"]')
        expect(native_id).to_have_attribute("data-et-prop-listing_id", expected_id, timeout=30_000)
        if urlsplit(page.url).path != f"/edit-listing/{expected_id}": raise ValueError("Poshmark opened another listing's editor")
        selectors = page.locator(".dropdown__selector:visible")
        current = selectors.filter(has_text=re.compile(r"^\s*(?:For Sale|Not For Sale)\s*$"))
        expect(current).to_have_count(1)
        if current.inner_text().strip() == "For Sale":
            authorize()
            started = True  # Conservatively include any native side effect of the availability choice.
            current.click()
            page.locator(".dropdown__menu:visible").get_by_text("Not For Sale", exact=True).click()
            expect(selectors.filter(has_text=re.compile(r"^\s*Not For Sale\s*$"))).to_have_count(1)
            authorize()
            page.get_by_role("button", name="Update", exact=True).click()
            final = final_review_button(page, state['title'], expected_id)
            authorize()
            final.click()
        # Keep the saving editor alive while a separate signed-in tab checks
        # the actual listing. Update alone only opens the final review screen.
        with verification_page(page) as check:
            deadline=monotonic()+45
            while True:
                verified = inspect_availability(check, state["url"], expected_id)
                if verified['state']=='unavailable' or monotonic()>=deadline:break
                check.wait_for_timeout(1000)
        if verified["state"] != "unavailable": raise ValueError("Poshmark did not confirm Not For Sale after the update")
        return {"outcome": "ended", "verified": True, "externalListingId": expected_id,
                "submissionStarted": started, "url": verified["url"]}
    except Exception as error:
        return {"outcome": "unknown" if started else "failed", "verified": False,
                "externalListingId": expected_id, "submissionStarted": started,
                "reason": f"{type(error).__name__}: {str(error)[:1500]}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["inspect", "end"], default="inspect")
    parser.add_argument("--listing-stdin", action="store_true", required=True)
    args = parser.parse_args()
    result = {"outcome": "failed", "verified": False, "submissionStarted": False}
    try:
        request = read_listing_input(sys.stdin.buffer)
        expected_id, url = request.get("externalListingId"), request.get("externalUrl")
        if not listing_url(url, expected_id): raise ValueError("A valid Poshmark listing identity is required")
        authorize = lambda: assert_delist_authorized(request.get("listingId"), "poshmark", expected_id, request.get("attempt"))
        if args.mode == "end": authorize()
        settings = config.load_settings()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            session = AssistedSession(pw, os.path.join(settings["dataRoot"], "poshmark-profile"), port_hint=9337)
            try:
                result = remove_listing(session.page, request, authorize) if args.mode == "end" else {
                    "outcome": "inspected", "submissionStarted": False,
                    **inspect_availability(session.page, url, expected_id),
                }
            finally: session.close()
    except Exception as error:
        result = {**result, "outcome": "unknown" if result.get("submissionStarted") else "failed",
                  "verified": False, "reason": f"{type(error).__name__}: {str(error)[:1500]}"}
    print("POSHMARK_END_DONE " + json.dumps(result), flush=True)
    return 0 if result["outcome"] in {"ended", "inspected"} else 1


if __name__ == "__main__": raise SystemExit(main())
