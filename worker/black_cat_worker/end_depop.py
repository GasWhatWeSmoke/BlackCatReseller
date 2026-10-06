"""Remove a sale-linked Depop item from sale through its native Manage menu."""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlsplit

from . import config
from .assisted_browser import AssistedSession
from .delist_guard import assert_delist_authorized
from .depop_sales import product_identity
from .direct_listing import read_listing_input

ACTIVE_URL = "https://www.depop.com/sellinghub/selling/active/"


def checked_identity(request):
    identity = product_identity(request.get("externalUrl"))
    if not identity or identity["id"] != request.get("externalListingId"):
        raise ValueError("Depop removal requires the exact stored product URL and identity")
    return identity


def inspect_availability(page, request):
    from playwright.sync_api import expect
    identity = checked_identity(request)

    def product_state(owner_verified=False):
        response = page.goto(identity["url"], wait_until="domcontentloaded", timeout=30_000)
        current = urlsplit(page.url)
        current = current._replace(path=current.path.rstrip("/").removesuffix("/manage") + "/", query="", fragment="").geturl()
        if (product_identity(current) or {}).get("id") != identity["id"]:
            raise ValueError("Depop opened a different product")
        if not response or response.status != 200:
            raise ValueError("Depop's product page did not load; a missing page is not removal proof")
        edit = page.locator(f'main a[href="/products/edit/{identity["id"]}/"]:visible')
        expect(page.locator('main h1:visible').or_(edit).first).to_be_visible(timeout=30_000)
        # Keep the precise product-linked sold proof. Shop counts, missing pages
        # and absence from active inventory never certify removal.
        sold_heading = page.locator('main h1[aria-describedby~="sold"]')
        if sold_heading.count() == 1:
            expect(page.locator("main #sold")).to_have_text("This product has been sold")
            return "unavailable"
        if edit.count() == 0:
            # Public product layouts can omit the owner's Edit link. Require
            # the exact editable seller-inventory row before accepting access.
            return "editable" if owner_verified else "needs_owner"
        expect(edit).to_have_count(1)
        expect(edit).to_be_visible()
        return "editable"

    state = product_state()
    if state == 'needs_owner' or (state == 'editable' and page.locator('main h1:visible').count() == 0):
        # Some product layouts omit H1 or Edit. Prove the exact item is still
        # editable in the owner's inventory, then restore its page for price reads.
        find_active_row(page, identity['id'])
        state = product_state(owner_verified=True)
    return {"state": state, "url": identity["url"]}


def find_active_row(page, expected_id, max_pages=20):
    from playwright.sync_api import expect
    page.goto(ACTIVE_URL, wait_until="domcontentloaded", timeout=30_000)
    heading = page.get_by_role("heading", name=re.compile(r"^Active items \(\d+\)$"))
    expect(heading).to_be_visible(timeout=30_000)
    if heading.inner_text().strip() != 'Active items (0)':
        # The count/header renders before the first list page and Load more.
        # Do not interpret that hydration gap as an empty active inventory.
        expect(page.locator('main a[href^="/products/"][href$="/manage/"]')).not_to_have_count(0, timeout=30_000)
    link = page.locator(f'a[href="/products/{expected_id}/manage/"]:visible')
    row = page.locator("main li").filter(has=link)
    for _ in range(max_pages):
        if row.count():
            expect(row).to_have_count(1)
            expect(row.locator(f'a[href^="/products/edit/{expected_id}/"]:visible')).to_have_count(1)
            expect(row.get_by_role("button", name="Manage listings", exact=True)).to_be_visible()
            return row
        more = page.get_by_role("button", name="Load more", exact=True)
        if more.count() != 1 or not more.is_visible() or not more.is_enabled(): break
        count = page.locator('main a[href^="/products/"][href$="/manage/"]').count()
        more.click()
        page.wait_for_function("previous=>document.querySelectorAll('main a[href^=\"/products/\"][href$=\"/manage/\"]').length>previous", arg=count, timeout=30_000)
    raise ValueError("The exact Depop product was not found in active listings; removal remains unverified")


def remove_listing(page, request, authorize):
    from playwright.sync_api import expect
    started = False
    try:
        identity = checked_identity(request)
        authorize()
        state = inspect_availability(page, request)
        if state["state"] == "unavailable":
            return {"outcome": "ended", "verified": True, "submissionStarted": False,
                    "externalListingId": identity["id"], "url": identity["url"]}
        row = find_active_row(page, identity["id"])
        authorize()
        manage = row.get_by_role("button", name="Manage listings", exact=True)
        # A bottom-edge anchor opens the menu outside the viewport. Scrolling
        # its menu item into view then closes Depop's menu before the click.
        # Position the verified row's anchor before opening the menu instead.
        manage.evaluate("e=>e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})")
        manage.click()
        page.get_by_role("menu").get_by_role("menuitem", name="Mark as sold", exact=True).click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_have_count(1)
        expect(dialog.get_by_text("This will mark your listing as sold.", exact=True)).to_be_visible()
        # The confirmation dialog has no identity of its own. Retain the exact
        # underlying row and seller page across opening it and the final click.
        expect(row.locator(f'a[href="/products/{identity["id"]}/manage/"]:visible')).to_have_count(1)
        if page.url != ACTIVE_URL: raise ValueError("Depop left the expected active-listings page")
        authorize()
        started = True
        dialog.get_by_role("button", name="Confirm", exact=True).click()
        expect(dialog).not_to_be_visible(timeout=30_000)
        state = inspect_availability(page, request)
        if state["state"] != "unavailable": raise ValueError("Depop did not verify this product as sold")
        return {"outcome": "ended", "verified": True, "submissionStarted": True,
                "externalListingId": identity["id"], "url": identity["url"]}
    except Exception as error:
        return {"outcome": "unknown" if started else "failed", "verified": False,
                "submissionStarted": started, "reason": f"{type(error).__name__}: {str(error)[:1500]}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["inspect", "end"], default="inspect")
    parser.add_argument("--listing-stdin", action="store_true", required=True)
    args = parser.parse_args()
    result = {"outcome": "failed", "verified": False, "submissionStarted": False}
    try:
        request = read_listing_input(sys.stdin.buffer)
        identity = checked_identity(request)
        authorize = lambda: assert_delist_authorized(request.get("listingId"), "depop", identity["id"], request.get("attempt"))
        if args.mode == "end": authorize()
        settings = config.load_settings()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            session = AssistedSession(pw, os.path.join(settings["dataRoot"], "depop-profile"), port_hint=9333)
            try:
                result = remove_listing(session.page, request, authorize) if args.mode == "end" else {
                    "outcome": "inspected", "submissionStarted": False, **inspect_availability(session.page, request),
                }
            finally: session.close()
    except Exception as error:
        result = {**result, "outcome": "unknown" if result.get("submissionStarted") else "failed",
                  "verified": False, "reason": f"{type(error).__name__}: {str(error)[:1500]}"}
    print("DEPOP_END_DONE " + json.dumps(result), flush=True)
    return 0 if result["outcome"] in {"ended", "inspected"} else 1


if __name__ == "__main__": raise SystemExit(main())
