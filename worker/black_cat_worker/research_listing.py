"""Read one user-selected public eBay listing; no search crawling or edits."""
import json
import re
import sys
from urllib.parse import urlsplit
from .chrome_editor import new_chrome_editor

ENTRY_URL = "https://www.ebay.com/sh/lst/active"


def ebay_identity(value):
    try:
        url = urlsplit(value)
        match = re.fullmatch(r"/itm/(?:[^/]+/)?(\d{9,15})/?", url.path)
        if url.scheme != "https" or url.hostname not in {"www.ebay.com", "ebay.com"} or url.username or url.password or url.port or not match:
            return None
        return match.group(1)
    except (ValueError, TypeError):
        return None


def normalize_snapshot(snapshot):
    title = str(snapshot.get("title") or "").strip()
    if not title or len(title) > 500:
        raise ValueError("The listing title is unavailable. Open the listing and record its details manually.")
    # Preserve unknowns. Price ranges, other currencies and a hidden accepted
    # offer cannot certify an actual sold amount.
    price_text = str(snapshot.get("price") or "").strip()
    price_match = re.fullmatch(r"(?:US\s*)?\$([\d,]+(?:\.\d{2})?)", price_text)
    price = float(price_match.group(1).replace(",", "")) if price_match else None
    status = str(snapshot.get("status") or "").lower()
    hidden_offer = "best offer" in status or "offer accepted" in status
    sold = bool(re.search(r"\b(sold|this listing sold)\b", status))
    interest_match = re.fullmatch(r"\s*(\d[\d,]*)\s+(?:people are |people )?watching(?: this)?\s*", str(snapshot.get("interest") or ""), re.I)
    return {"title": title, "price": None if hidden_offer else price,
            "kind": "sold" if sold and not hidden_offer else "active" if snapshot.get("buyable") and not sold else "unknown",
            "interest": int(interest_match.group(1).replace(",", "")) if interest_match else None}


def main():
    try:
        request = json.loads(sys.stdin.buffer.read(4096))
        identity = ebay_identity(request.get("url"))
        if not identity:
            raise ValueError("Paste an exact eBay listing URL.")
        url = "https://www.ebay.com/itm/" + identity
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            with new_chrome_editor(playwright, ENTRY_URL, timeout=30_000) as page:
                page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                page.locator("h1").first.wait_for(timeout=15_000)
                if ebay_identity(page.url) != identity:
                    raise ValueError("eBay redirected away from this item. Check the listing in Chrome.")
                snapshot = page.evaluate("""() => {
                  const visible = el => !!el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
                  const text = selector => [...document.querySelectorAll(selector)].filter(visible).map(el => el.innerText.trim()).filter(Boolean).join(' ');
                  return { title: text('.x-item-title__mainTitle') || text('h1'), price: text('.x-price-primary'),
                    status: text('.d-vi-alert__message, .x-item-status'), interest: text('.x-urgency__text'),
                    buyable: [...document.querySelectorAll('a,button')].some(el => visible(el) && /^(Buy it now|Add to cart)$/i.test(el.innerText.trim())) };
                }""")
                result = normalize_snapshot(snapshot)
        print("RESEARCH_DONE " + json.dumps({"ok": True, "url": url, **result}), flush=True)
    except Exception as error:
        # Browser exceptions can carry a private connection URL. Never return
        # those; only our own bounded validation messages cross the API.
        message = str(error) if isinstance(error, ValueError) else "Could not read this listing. Check Chrome access and try again."
        print("RESEARCH_DONE " + json.dumps({"ok": False, "error": message}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
