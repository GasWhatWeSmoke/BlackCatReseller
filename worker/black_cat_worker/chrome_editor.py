"""Borrow one existing seller editor from the user's authorized Chrome session.

The information-only extension is not involved. Exiting disconnects the native
crawler; it never closes Chrome or the user's editor. No credentials are copied.
"""
from contextlib import contextmanager
from urllib.parse import urldefrag, urlencode, urlsplit
from .chrome_session import session_endpoint
from .work_browser import work_window_bounds, configure_work_page, keep_work_page_ready
from .browser_lease import BrowserLease, browser_lease_path


@contextmanager
def _chrome_editor(playwright, editor_url, timeout, create):
    path = browser_lease_path()
    # session_endpoint separately rejects a missing/invalid production root.
    lease = BrowserLease(path) if path is not None else None
    try:
        if lease is not None:
            lease.acquire()
        with _owned_chrome_editor(playwright, editor_url, timeout, create) as page:
            yield page
    finally:
        if lease is not None:
            lease.release()


@contextmanager
def _owned_chrome_editor(playwright, editor_url, timeout, create):
    bounds = work_window_bounds() if create else None
    capability = "ebay-editor-v1" if urlsplit(editor_url).hostname == "www.ebay.com" else "new-editor-v1"
    if urlsplit(editor_url).path in {"/sh/lst/active", "/sh/ord", "/your/shops/me/tools/listings", "/your/orders/sold"}:
        capability = "seller-tools-v1"
    if urlsplit(editor_url).hostname == "www.mercari.com":
        capability = "mercari-tools-v1"
    if bounds is not None:
        capability = "work-window-v1"
    endpoint = (session_endpoint(capability) if create else session_endpoint()) + "?" + urlencode(
        {"editor": editor_url, **({"create": "1"} if create else {})})
    browser = None
    try:
        try:
            browser = playwright.chromium.connect_over_cdp(endpoint, no_defaults=True, timeout=timeout)
        except Exception:
            # Playwright errors include the private endpoint; keep it out of logs.
            raise RuntimeError("Native Chrome connection did not complete") from None
        pages = [page for context in browser.contexts for page in context.pages
                 if create or urldefrag(page.url).url == urldefrag(editor_url).url]
        if len(pages) != 1:
            raise RuntimeError("Expected exactly one matching seller editor in Chrome")
        if create:
            if bounds is not None:
                configure_work_page(pages[0], native_window=True)
            pages[0].goto(editor_url, wait_until="domcontentloaded", timeout=timeout)
            # Native Chrome can create the owned tab in the background. Its
            # paused animation frames prevent Playwright's actionability checks.
            keep_work_page_ready(pages[0])
        yield pages[0]
    finally:
        if browser is not None:
            browser.close()  # Broker closes a created tab; borrowed tabs stay open.


def existing_chrome_editor(playwright, editor_url, timeout=30000):
    return _chrome_editor(playwright, editor_url, timeout, False)


def new_chrome_editor(playwright, editor_url, timeout=30000):
    """Create one owned seller tab; the broker closes it even if the worker fails."""
    return _chrome_editor(playwright, editor_url, timeout, True)
