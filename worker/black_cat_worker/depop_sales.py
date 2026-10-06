"""Read seller receipts through Depop's UI. No refunds, messages or listing edits."""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlsplit

from . import config
from .assisted_browser import AssistedSession
from .direct_listing import read_listing_input
from .sale_financials import usd_cents, single_item_financials

RECEIPTS_URL = "https://www.depop.com/sellinghub/sold-items/"
LOGIN_REQUIRED = ("Depop sign-in is required in Black Cat's linked account. Open Settings > Marketplace accounts > Depop, "
                  "choose Re-link Depop, sign in, close that window, then confirm I'm logged in to Depop.")

# Inspect only view identity, not customer details. A sign-in page is not an empty
# sales history, and ordinary Chrome approval does not authenticate this profile.
SELLER_VIEW_STATE = r"""mode => {
  const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const heads=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(visible).map(e=>e.textContent.trim());
  if(location.protocol!=='https:'||!['depop.com','www.depop.com'].includes(location.hostname)) return 'unexpected';
  if(heads.includes('Sign up or log in')||/^\/(?:login|signup|magic-link)(?:\/|$)/.test(location.pathname)) return 'login';
  if(heads.some(text=>/^(?:verify you are human|verify your identity|security verification)$/i.test(text))||
     /^(?:just a moment|attention required)/i.test(document.title)) return 'verification';
  return (mode==='receipt'?heads.some(text=>/^\d+ items? sold$/.test(text)):heads.includes('Sold'))?'ready':null;
}"""


def require_seller_access(state):
    if state == "login": raise ValueError(LOGIN_REQUIRED)
    if state == "verification":
        raise ValueError("Depop needs sign-in or security verification. Open its linked account from Settings and finish the check yourself before syncing sales.")
    if state != "ready": raise ValueError("Depop's expected seller receipt view could not be verified. Open its linked account from Settings to check access.")


def wait_for_seller_view(page, mode="list"):
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    try: state = page.wait_for_function(SELLER_VIEW_STATE, arg=mode, timeout=30_000).json_value()
    except PlaywrightTimeoutError:
        raise ValueError("Depop's seller receipt view did not appear. Open its linked account from Settings to check access; this read did not verify sales.") from None
    require_seller_access(state)


def wait_for_receipt_list(page, previous_count=None):
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    try:
        result = page.wait_for_function(f"""previous => {{
          const access=({SELLER_VIEW_STATE})('list');
          if(access&&access!=='ready') return {{access}};
          if(access!=='ready') return false;
          const snapshot=({RECEIPT_LIST_SNAPSHOT})();
          return snapshot&&!snapshot.loading&&(previous===null||!snapshot.hasMore||new Set(snapshot.urls).size>previous)
            ?{{access:'ready',snapshot}}:false;
        }}""", arg=previous_count, timeout=30_000).json_value()
    except PlaywrightTimeoutError:
        raise ValueError("Depop's receipt list did not finish loading. Sales coverage is unverified; check the linked account and retry.") from None
    require_seller_access(result.get("access"))
    return result["snapshot"]

# Only IDs and pagination booleans are read from the component backing the
# displayed receipt list. Never serialize row text, buyer data or query caches.
RECEIPT_LIST_SNAPSHOT = r"""() => {
  const first=[...document.querySelectorAll('main a[href]')].find(e=>
    /^\/sellinghub\/sold-items\/\d+\/$/.test(new URL(e.href).pathname));
  const list=first?.closest('ul');
  if (!list) return null;
  const key=Object.keys(list).find(k=>k.startsWith('__reactFiber'));
  let leaf=list[key], root=leaf;
  while(root?.return) root=root.return;
  if (root?.stateNode?.current && root.stateNode.current!==root) leaf=leaf?.alternate;
  for(let f=leaf,depth=0;f&&depth<12;f=f.return,depth++) {
    const p=f.memoizedProps;
    if(typeof p?.onEndReached==='function'&&typeof p.hasMore==='boolean'&&typeof p.loading==='boolean')
      return {urls:[...list.querySelectorAll('a[href]')].map(e=>e.href).filter(value=>
        /^\/sellinghub\/sold-items\/\d+\/$/.test(new URL(value).pathname)),hasMore:p.hasMore,loading:p.loading};
  }
  return null;
}"""


def normalize_receipt_list(snapshot):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("hasMore"), bool) or not isinstance(snapshot.get("loading"), bool) or not isinstance(snapshot.get("urls"), list):
        raise ValueError("Depop's receipt pagination could not be verified")
    receipt_ids = []
    for value in snapshot["urls"]:
        try:
            url = urlsplit(value)
            match = re.fullmatch(r"/sellinghub/sold-items/(\d{1,24})/?", url.path)
            if url.scheme != "https" or url.hostname not in {"depop.com", "www.depop.com"} or url.username or url.password or url.port or not match:
                raise ValueError("Depop returned an invalid receipt link")
        except (TypeError, AttributeError): raise ValueError("Depop returned an invalid receipt link")
        if match.group(1) not in receipt_ids: receipt_ids.append(match.group(1))
    if not receipt_ids: raise ValueError("An empty page is not verified receipt history")
    return {"receiptIds": receipt_ids, "hasMore": snapshot["hasMore"], "loading": snapshot["loading"]}


def discover_receipts(page, max_pages=20):
    if type(max_pages) is not int or not 1 <= max_pages <= 100: raise ValueError("Invalid Depop receipt page limit")
    response = page.goto(RECEIPTS_URL, wait_until="domcontentloaded", timeout=30_000)
    if not response or response.status != 200: raise ValueError("Depop's receipt history did not load")
    wait_for_seller_view(page)
    previous = []
    for index in range(max_pages):
        snapshot = wait_for_receipt_list(page)
        if page.url.rstrip("/") != RECEIPTS_URL.rstrip("/"):
            raise ValueError("Depop left the expected seller receipt page")
        state = normalize_receipt_list(snapshot)
        ids = state["receiptIds"]
        if state["loading"]: raise ValueError("Depop's receipt list changed during the scan")
        if ids[:len(previous)] != previous:
            raise ValueError("Depop's receipt order changed during pagination; restart the scan")
        if not state["hasMore"]: return {"receiptIds": ids, "complete": True}
        if index == max_pages - 1: return {"receiptIds": ids, "complete": False, "reason": "Depop receipt page limit reached"}
        previous = ids
        page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        wait_for_receipt_list(page, len(ids))
    raise ValueError("Depop receipt discovery did not finish")


def scan_receipts(page, max_pages=20, max_receipts=100, known_confirmed_receipts=()):
    if type(max_receipts) is not int or not 1 <= max_receipts <= 500: raise ValueError("Invalid Depop receipt read limit")
    # The caller may skip only already persisted confirmed sales. Pending or
    # unrecognized receipts must be revisited because payment can arrive later.
    if not isinstance(known_confirmed_receipts, (list, tuple)) or len(known_confirmed_receipts) > 10000 or any(not isinstance(value, str) or not re.fullmatch(r"\d{1,24}", value) for value in known_confirmed_receipts):
        raise ValueError("Invalid previously confirmed receipt IDs")
    discovered = discover_receipts(page, max_pages)
    known = set(known_confirmed_receipts)
    pending = [receipt_id for receipt_id in discovered["receiptIds"] if receipt_id not in known]
    selected = pending[:max_receipts]
    observations, checked, confirmed, errors = [], [], [], []
    for receipt_id in selected:
        try: receipt = read_receipt(page, receipt_id)
        except Exception as error:
            # Keep already verified observations useful if an older receipt or
            # an expired session interrupts the rest. Do not keep opening pages
            # after a failure, and never checkpoint the unread receipt.
            errors.append({"receiptId": receipt_id, "error": f"{type(error).__name__}: {str(error)[:1200]}"})
            break
        observations.extend(receipt)
        checked.append(receipt_id)
        if receipt and all(item["classification"] == "confirmed_sale" for item in receipt): confirmed.append(receipt_id)
    complete = discovered["complete"] and len(checked) == len(pending)
    return {"complete": complete, "receiptIds": discovered["receiptIds"], "receiptsRead": len(checked),
            "checkedReceiptIds": checked, "confirmedReceiptIds": confirmed, "observations": observations, "errors": errors,
            **({"reason": f"Depop receipt read interrupted: {errors[0]['error']}" if errors else discovered.get("reason") or "Depop receipt read limit reached"} if not complete else {})}


def product_identity(value):
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.hostname not in {"depop.com", "www.depop.com"} or url.username or url.password or url.port:
            return None
        match = re.fullmatch(r"/products/([a-z0-9][a-z0-9-]*)/?", url.path, re.I)
        if not match or match.group(1).lower() == "create": return None
        return {"id": match.group(1), "url": f"https://www.depop.com{url.path}"}
    except (TypeError, ValueError): return None


def normalize_receipt(snapshot, expected_id):
    if not isinstance(snapshot, dict) or not isinstance(expected_id, str) or not re.fullmatch(r"\d{1,24}", expected_id) or snapshot.get("receiptId") != expected_id:
        raise ValueError("Depop did not verify the requested receipt")
    heading = re.fullmatch(r"(\d+) items? sold", str(snapshot.get("heading") or "").strip())
    if not heading or not 1 <= int(heading.group(1)) <= 100:
        raise ValueError("Depop's sold-item count is unavailable")
    if not isinstance(snapshot.get("paymentReceived"), bool) or not isinstance(snapshot.get("negativeMarkers"), list):
        raise ValueError("Depop's receipt status is unavailable")
    products = snapshot.get("products")
    if not isinstance(products, list): raise ValueError("Depop's receipt products are unavailable")
    identities = {}
    for product in products:
        identity = product_identity(product)
        if not identity: raise ValueError("Depop's receipt contains an invalid product identity")
        identities[identity["id"]] = identity["url"]
    if len(identities) != int(heading.group(1)):
        raise ValueError("Depop's product identities do not match the sold-item count")
    classification = "not_sale" if snapshot["negativeMarkers"] else "confirmed_sale" if snapshot["paymentReceived"] else "requires_review"
    return [{"marketplace": "depop", "receiptId": expected_id, "listingId": identity,
             "listingUrl": url, "classification": classification}
            for identity, url in identities.items()]


RECEIPT_SNAPSHOT = """root => ({
      heading:[...root.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim()).find(s=>/^\\d+ items? sold$/.test(s)),
      products:[...root.querySelectorAll('a[href]')].filter(e=>{try{return new URL(e.href).pathname.startsWith('/products/')}catch{return false}}).map(e=>e.href),
      paymentReceived:[...root.querySelectorAll('b,strong')].some(e=>e.getClientRects().length&&e.textContent.trim()==='Payment received'),
      negativeMarkers:[...root.querySelectorAll('b,strong,h2,h3,[role=status]')]
        .filter(e=>e.getClientRects().length&&!e.closest('button,a'))
        .map(e=>e.textContent.trim()).filter(s=>/^(?:payment |order )?(?:refunded|canceled|cancelled)$|^Refund (?:sent|issued|complete|processed)$|^Payment refunded on$/i.test(s))
    })"""


def read_receipt(page, receipt_id):
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    if not re.fullmatch(r"\d{1,24}", receipt_id): raise ValueError("Invalid Depop receipt ID")
    page.goto(f"{RECEIPTS_URL}{receipt_id}/", wait_until="domcontentloaded", timeout=30_000)
    wait_for_seller_view(page, "receipt")
    dialog = page.get_by_role("dialog", name="View Receipt modal", exact=True)
    try:
        dialog.wait_for(timeout=30_000)
        heading = dialog.get_by_role("heading", name=re.compile(r"^\d+ items? sold$"))
        heading.wait_for(timeout=30_000)
    except PlaywrightTimeoutError:
        require_seller_access(page.evaluate(SELLER_VIEW_STATE, "receipt"))
        raise ValueError("Depop did not expose the expected receipt details. This receipt has not confirmed a sale.") from None
    # Keep the canceled filter and every other receipt on the background page
    # outside this read. Refund in the app is an action, not a refund status.
    snapshot = dialog.evaluate(RECEIPT_SNAPSHOT)
    if urlsplit(page.url).path.rstrip("/") != f"/sellinghub/sold-items/{receipt_id}":
        raise ValueError("Depop changed receipts during the read")
    observations=normalize_receipt({**snapshot, "receiptId": receipt_id}, receipt_id)
    rows=dialog.locator('tr').evaluate_all('''els=>els.map(e=>({label:e.querySelector('[class*="__labelText"]')?.innerText?.trim(),value:e.querySelector('[class*="__priceText"]')?.innerText?.trim()}))''')
    values=[row.get('value') for row in rows if row.get('label')=='Items Price']
    if len(values)==1:single_item_financials(observations,usd_cents(values[0]))
    return observations


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--receipt-id", action="append")
    mode.add_argument("--scan", action="store_true")
    mode.add_argument("--discover", action="store_true")
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--max-receipts", type=int, default=100)
    parser.add_argument("--known-confirmed-receipts-stdin", action="store_true")
    args = parser.parse_args()
    result = {"ok": False}
    try:
        if args.receipt_id and len(args.receipt_id) > 100: raise ValueError("Too many receipt IDs for one read")
        if args.known_confirmed_receipts_stdin and not args.scan: raise ValueError("Previously confirmed receipts require scan mode")
        known = read_listing_input(sys.stdin.buffer).get("receiptIds", []) if args.known_confirmed_receipts_stdin else []
        settings = config.load_settings()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            session = AssistedSession(pw, os.path.join(settings["dataRoot"], "depop-profile"), port_hint=9333)
            try:
                if args.discover: result = {"ok": True, **discover_receipts(session.page, args.max_pages)}
                elif args.scan: result = {"ok": True, **scan_receipts(session.page, args.max_pages, args.max_receipts, known)}
                else:
                    observations = []
                    for receipt_id in dict.fromkeys(args.receipt_id): observations.extend(read_receipt(session.page, receipt_id))
                    result = {"ok": True, "observations": observations}
            finally: session.close()
    except Exception as error:
        result = {"ok": False, "error": f"{type(error).__name__}: {str(error)[:1200]}"}
    print("DEPOP_SALES_DONE " + json.dumps(result), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": raise SystemExit(main())
