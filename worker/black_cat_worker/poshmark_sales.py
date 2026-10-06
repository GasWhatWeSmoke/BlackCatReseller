"""Read-only Poshmark order observations; never edits listings or messages buyers."""
import argparse
import datetime as dt
import json
import os
import re
import sys
from time import monotonic
from urllib.parse import urlsplit

from . import config
from .assisted_browser import AssistedSession
from .direct_listing import read_listing_input
from .sale_financials import amount_cents, usd_cents, single_item_financials, sold_timestamp

SALES_URL = "https://poshmark.com/order/sales"
ID = re.compile(r"^[a-f0-9]{24}$")

# The observed OrderItems component backs the displayed order row. Read only
# identities/status/SKU; never serialize its buyer, address, tracking or payment data.
ORDER_SNAPSHOT = """e => {
  const props=e.__vue__?.$props, o=props?.order;
  if (!o) return null;
  return {isSale:props.isSale, orderId:o.id, displayStatus:o.display_status,
    orderState:o.state, inventoryBookedAt:o.inventory_booked_at,
    soldEventInProgress:Array.isArray(o.order_events)&&o.order_events.some(v=>v.title==='Sold'&&v.completion_status==='in_progress'),
    visibleSoldInProgress:[...document.querySelectorAll('.order-journey__marker--in-progress [class*=title]')]
      .some(n=>n.getClientRects().length&&n.textContent.trim()==='Sold'),
    totalPrice:o.total_price_amount, visiblePrices:[...e.querySelectorAll('.order-items__item-price')].map(n=>n.innerText.trim()),
    visibleStatus:document.querySelector('.order-status__display')?.textContent?.trim(),
    cancellationKnown:Object.hasOwn(o,'cancelled_on'), cancelled:!!o.cancelled_on,
    paymentApproved:[...e.querySelectorAll('strong,b,[role=status],.order-info__label,.order-status__display')]
      .some(n=>n.getClientRects().length&&/^Payment (?:approved|received|completed)$/i.test(n.innerText.trim())),
    lines:Array.isArray(o.line_items)?o.line_items.map(l=>({lineId:l.id,status:l.status,
      productId:l.product_id,parentPostId:l.parent_post_id,productUrl:l.product_url,sku:l.sku})):null};
}"""


def listing_identity(value):
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.hostname not in {"poshmark.com", "www.poshmark.com"} or url.username or url.password or url.port:
            return None
        match = re.fullmatch(r"/listing/(?:[^/]+-)?([a-f0-9]{24})/?", url.path)
        return match.group(1) if match else None
    except (TypeError, ValueError): return None


def booked_timestamp(value):
    if not isinstance(value, str): return None
    try:
        stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return sold_timestamp(int(stamp.timestamp())) if stamp.tzinfo is not None else None
    except (ValueError, OverflowError, OSError): return None


def normalize_order(snapshot, expected_order_id):
    if not isinstance(snapshot, dict) or snapshot.get("isSale") is not True or snapshot.get("orderId") != expected_order_id or not isinstance(expected_order_id, str) or not ID.fullmatch(expected_order_id):
        raise ValueError("Poshmark did not verify the requested seller order")
    if snapshot.get("cancellationKnown") is not True or not isinstance(snapshot.get("cancelled"), bool):
        raise ValueError("Poshmark cancellation state is unavailable")
    status = " ".join(str(snapshot.get("displayStatus") or "").split())
    visible = " ".join(str(snapshot.get("visibleStatus") or "").split())
    if not status or status != visible:
        raise ValueError("Poshmark's displayed status and order data disagree")
    lines = snapshot.get("lines")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 100:
        raise ValueError("Poshmark order items are incomplete")
    observed = []
    seen = set()
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("lineId"), str) or not ID.fullmatch(line["lineId"]) or line["lineId"] in seen:
            raise ValueError("Poshmark order line identity is missing or duplicated")
        seen.add(line["lineId"])
        listing_id = listing_identity(line.get("productUrl"))
        if not listing_id or listing_id not in (line.get("productId"), line.get("parentPostId")):
            raise ValueError("Poshmark order line does not identify one matching listing")
        sku = line.get("sku")
        if sku is not None and (not isinstance(sku, str) or len(sku) > 50): raise ValueError("Poshmark order SKU is invalid")
        # The current seller order journey calls a new sale "Sold", before
        # shipping or payout. Verify its native state and visible milestone;
        # a public Sold badge, label, or an Order Placed badge alone is not enough.
        if snapshot["cancelled"] or re.search(r"cancel|refund|return|payment pending|unpaid", status, re.I):
            classification = "not_sale"
        elif status == "Order Complete" and line.get("status") == "r":
            classification = "confirmed_sale"
        elif (status == "Sold" and snapshot.get("orderState") == "seller_confirm_initiated"
              and line.get("status") == "r" and snapshot.get("soldEventInProgress") is True
              and snapshot.get("visibleSoldInProgress") is True):
            classification = "confirmed_sale"
        elif snapshot.get("paymentApproved") is True and status in {
            "Order Placed", "Awaiting Shipment", "Pending Shipment Scan", "In Transit", "Delivered"
        }:
            classification = "confirmed_sale"
        else:
            classification = "requires_review"
        observed.append({"marketplace": "poshmark", "orderId": expected_order_id, "lineId": line["lineId"],
                         "listingId": listing_id, "listingUrl": f"https://poshmark.com/listing/{listing_id}",
                         "sku": sku, "orderStatus": status, "lineStatus": str(line.get("status") or "")[:60],
                         "classification": classification})
    # Single-item total is the paid merchandise amount, never net earnings.
    price=amount_cents(snapshot.get('totalPrice'))
    visible=snapshot.get('visiblePrices')
    if isinstance(visible,list) and len(visible)==1 and usd_cents(visible[0])==price:
        single_item_financials(observed,price,sold_at=booked_timestamp(snapshot.get('inventoryBookedAt')))
    return observed


def read_order(page, order_id):
    if not ID.fullmatch(order_id): raise ValueError("Invalid Poshmark order ID")
    page.goto(f"{SALES_URL}/{order_id}", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("""id => {
      const e=document.querySelector('.order-info__container');
      return e?.__vue__?.$props?.order?.id===id &&
        document.querySelector('.order-status__display')?.getClientRects().length;
    }""", arg=order_id, timeout=30_000)
    return normalize_order(page.locator(".order-info__container").evaluate(ORDER_SNAPSHOT), order_id)


def page_range(value):
    match = re.fullmatch(r"Showing\s+(\d+)\s*[-\u2013]\s*(\d+)\s+of\s+(\d+)", str(value or "").strip())
    if not match: raise ValueError("Poshmark sales page range is unavailable")
    start, end, total = map(int, match.groups())
    if (start, end, total) != (0, 0, 0) and not 1 <= start <= end <= total:
        raise ValueError("Poshmark sales page range is inconsistent")
    return start, end, total


def scan_sales(page, max_pages=10, known_receipts=(), max_receipts=100):
    if not isinstance(max_pages, int) or not 1 <= max_pages <= 20: raise ValueError("max_pages must be 1 to 20")
    if not isinstance(known_receipts, (list, tuple)) or len(known_receipts) > 10000 or any(not isinstance(value, str) or not ID.fullmatch(value) for value in known_receipts):
        raise ValueError("Invalid Poshmark confirmed receipt checkpoint")
    if type(max_receipts) is not int or not 1 <= max_receipts <= 100: raise ValueError("Invalid Poshmark receipt read limit")
    deadline = monotonic() + 200
    page.goto(SALES_URL, wait_until="domcontentloaded", timeout=30_000)
    urls, seen_pages, complete, expected_total, previous_end = [], set(), False, None, 0
    for _ in range(max_pages):
        links = page.locator("a.my-sales-desktop-table__item-title")
        counter = page.locator(".my-sales-desktop-table__pagination-info")
        counter.wait_for(timeout=30_000)
        start, end, total = page_range(counter.inner_text())
        if expected_total is not None and total != expected_total:
            raise ValueError("Poshmark sales changed while scanning; repeat the scan")
        expected_total = total
        if total and start != previous_end + 1:
            raise ValueError("Poshmark sales pagination skipped orders")
        if total: links.first.wait_for(timeout=30_000)
        current = links.evaluate_all("els=>els.map(e=>e.getAttribute('href'))")
        signature = tuple(current)
        if len(set(current)) != (end - start + 1 if total else 0):
            raise ValueError("Poshmark sales rows do not match the page counter")
        if signature in seen_pages: raise ValueError("Poshmark sales pagination did not advance")
        seen_pages.add(signature)
        for value in current:
            match = re.fullmatch(r"/order/sales/([a-f0-9]{24})", value or "")
            if not match: raise ValueError("Poshmark returned an unexpected seller-order link")
            if match.group(1) not in urls: urls.append(match.group(1))
        # Poshmark leaves Next enabled even for Showing 1-3 of 3. The explicit
        # counter, not the button's appearance, proves the final page.
        if end == total:
            complete = True
            break
        previous_end = end
        next_page = page.locator('button[data-et-name="pagination_next"]')
        if next_page.count() != 1: raise ValueError("Poshmark sales pagination could not be verified")
        if _ == max_pages - 1: break
        next_page.click()
        page.wait_for_function("previous=>{const next=[...document.querySelectorAll('a.my-sales-desktop-table__item-title')].map(e=>e.getAttribute('href'));return next.length>0 && JSON.stringify(next)!==JSON.stringify(previous)}", arg=current, timeout=30_000)
    observations, checked, confirmed = [], [], []
    pending = [order_id for order_id in urls if order_id not in set(known_receipts)]
    reason = None if complete else "Poshmark sales scan reached its page limit"
    if len(pending) > max_receipts:
        complete = False; reason = "Poshmark sales scan reached its receipt limit"
    for order_id in pending[:max_receipts]:
        if monotonic() > deadline - 35:
            complete = False; reason = "Poshmark sales scan reached its time budget"; break
        try:
            rows = read_order(page, order_id)
            observations.extend(rows); checked.append(order_id)
            if rows and all(row['classification'] == 'confirmed_sale' for row in rows): confirmed.append(order_id)
        except Exception:
            # An unread old order must not discard a verified new sale.
            complete = False; reason = "At least one Poshmark order could not be verified; it will be checked again"
    return {"ordersRead": len(checked), "complete": complete, "observations": observations,
            "receiptIds": urls, "checkedReceiptIds": checked, "confirmedReceiptIds": confirmed,
            **({"reason": reason} if reason else {}),
            "observedAt": dt.datetime.now(dt.timezone.utc).isoformat()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-pages", type=int, default=10)
    args = parser.parse_args()
    result = {"ok": False, "complete": False}
    try:
        settings = config.load_settings()
        known = read_listing_input(sys.stdin.buffer).get("receiptIds", [])
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            session = AssistedSession(pw, os.path.join(settings["dataRoot"], "poshmark-profile"), port_hint=9337)
            try: result = {"ok": True, **scan_sales(session.page, args.max_pages, known)}
            finally: session.close()
    except Exception as error:
        result = {"ok": False, "complete": False, "error": f"{type(error).__name__}: {str(error)[:1200]}"}
    print("POSHMARK_SALES_DONE " + json.dumps(result), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__": raise SystemExit(main())
