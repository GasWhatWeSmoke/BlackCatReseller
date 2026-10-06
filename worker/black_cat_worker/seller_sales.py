"""Read seller order pages through Chrome; retain only sale identities and status."""
import argparse
import json
import re
from .work_browser import keep_work_page_ready
import sys
from time import monotonic
from urllib.parse import parse_qs, urlsplit, urljoin

from .chrome_editor import new_chrome_editor
from .direct_listing import read_listing_input
from .post_ebay import listing_id as ebay_listing_id
from .post_etsy import listing_id as etsy_listing_id
from .sale_financials import usd_cents, single_item_financials, sold_timestamp

START_URLS = {'ebay':'https://www.ebay.com/sh/ord', 'etsy':'https://www.etsy.com/your/orders/sold'}


def valid_receipt(marketplace, value):
    return isinstance(value, str) and bool(re.fullmatch(r'\d{2}-\d{5}-\d{5}' if marketplace == 'ebay' else r'\d{1,24}', value))


def receipt_identity(marketplace, value):
    if not isinstance(value, str): return None
    try:
        url = urlsplit(value)
        if url.scheme != 'https' or url.hostname != f'www.{marketplace}.com' or url.port or url.username or url.password: return None
        query = parse_qs(url.query)
        if marketplace == 'ebay' and url.path.rstrip('/') in {'/sh/ord/details','/mesh/ord/details'}: values = query.get('orderid', [])
        elif marketplace == 'etsy' and url.path.rstrip('/') in {'/your/orders/sold','/your/orders/sold/new','/your/orders/sold/completed'}: values = query.get('order_id', [])
        else: return None
        return values[0] if len(values) == 1 and valid_receipt(marketplace, values[0]) else None
    except (TypeError, ValueError): return None


def normalize_receipt(marketplace, snapshot, expected_id):
    if not valid_receipt(marketplace, expected_id) or snapshot.get('receiptId') != expected_id:
        raise ValueError('Seller order identity was not verified')
    count = snapshot.get('itemCount')
    products = snapshot.get('products')
    if type(count) is not int or not 1 <= count <= 100 or not isinstance(products, list):
        raise ValueError('Seller order item count could not be verified')
    listing_id = ebay_listing_id if marketplace == 'ebay' else etsy_listing_id
    identities = {listing_id(url) for url in products}
    if None in identities or len(identities) != count:
        raise ValueError('Seller order links do not match its item count')
    payment = str(snapshot.get('paymentStatus') or '').strip().casefold()
    status = str(snapshot.get('orderStatus') or '').strip().casefold()
    # A partial refund does not put a paid item back in stock. Cancellation,
    # full refund, returned and unpaid markers retain their existing handling.
    checked_status=re.sub(r'\bpartially refunded\b|\bpartial refund\b','',status) if payment in {'paid','payment received','payment complete','payment completed'} else status
    negative = re.search(r'cancel(?:led|ed)|refund(?:ed)?|returned|unpaid|awaiting payment|payment (?:pending|processing|failed)', payment+' '+checked_status)
    if negative: classification = 'not_sale'
    elif payment in {'paid', 'payment received', 'payment complete', 'payment completed'} and status:
        classification = 'confirmed_sale'
    else: classification = 'requires_review'
    path = 'itm' if marketplace == 'ebay' else 'listing'
    return [{'marketplace':marketplace, 'receiptId':expected_id, 'reference':f'{expected_id}/{identifier}',
             'listingId':identifier, 'listingUrl':f'https://www.{marketplace}.com/{path}/{identifier}',
             'classification':classification} for identifier in sorted(identities)]


# Status values come from labelled fields/semantic status elements, not customer
# notes, messages or product titles. No customer text leaves the browser.
SNAPSHOT = r'''(root,{id,marketplace})=>{
  const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
  const text=e=>(e?.innerText||'').trim();
  const fields=[...root.querySelectorAll('dt')].filter(visible).map(e=>({label:text(e).toLowerCase().replace(/:$/,''),value:text(e.nextElementSibling)}));
  for(const tr of root.querySelectorAll('tr')){const cells=[...tr.querySelectorAll('th,td')];if(cells.length===2&&visible(tr))fields.push({label:text(cells[0]).toLowerCase().replace(/:$/,''),value:text(cells[1])});}
  const field=(labels,selector)=>{const values=[...fields.filter(e=>labels.includes(e.label)).map(e=>e.value),...root.querySelectorAll(selector)].map(e=>typeof e==='string'?e:visible(e)?text(e):'').filter(Boolean);return [...new Set(values)].length===1?values[0]:null};
  const paymentStatus=field(['payment status'],'[data-testid="payment-status"],.payment-status');
  const orderStatus=field(['order status'],'[data-testid="order-status"],.order-status');
  const counts=[...root.querySelectorAll('h1,h2,h3,h4,[data-testid="item-count"]')].filter(visible).map(text).map(v=>v.match(/^(?:Items\s*\()?([0-9]+)\s*items?\)?$|^Items\s*\(([0-9]+)\)$/i)).filter(Boolean).map(m=>Number(m[1]||m[2]));
  const products=[...root.querySelectorAll('a[href]')].filter(visible).map(e=>e.href).filter(value=>{try{const u=new URL(value);return marketplace==='ebay'?/^\/itm\//.test(u.pathname):/^\/listing\//.test(u.pathname)}catch{return false}});
  return {receiptId:id,paymentStatus,orderStatus,itemCount:counts.length===1?counts[0]:null,products};
}'''


def read_receipt(page, marketplace, url):
    from playwright.sync_api import expect
    identifier = receipt_identity(marketplace, url)
    if not identifier: raise ValueError('Unexpected seller order link')
    response = page.goto(url, wait_until='domcontentloaded', timeout=30000)
    if not response or response.status != 200 or receipt_identity(marketplace, page.url) != identifier:
        raise ValueError('Seller order redirected or did not load')
    if marketplace == 'ebay' and page.locator('.order-info').count()==1:
        expect(page.get_by_role('heading',name='Order details',exact=True)).to_be_visible(timeout=15000)
        expect(page.get_by_role('heading',name='What your buyer paid',exact=True)).to_be_visible()
        snapshot=page.evaluate(r'''()=>{
          const text=e=>(e?.innerText||'').trim();
          const fields=[...document.querySelectorAll('.order-info dt')].map(e=>({label:text(e),value:text(e.nextElementSibling)}));
          const one=label=>{const values=fields.filter(e=>e.label===label).map(e=>e.value);return values.length===1?values[0]:null};
          const root=document.querySelector('#itemInfo');const cards=[...root?.querySelectorAll('.item-card')||[]];
          const quantities=cards.map(e=>text(e.querySelector('.quantity__value')));
          const heading=text(root?.querySelector('h2'));
          const count=heading.match(/^(?:Items\s*\((\d+)\)|(\d+)\s+items)$/i);
          const itemCount=cards.length===1&&heading==='Item'&&quantities[0]==='1'?1:count?Number(count[1]||count[2]):null;
          return {receiptId:one('Order'),paidDate:one('Buyer paid'),
            buyerPaid:[...document.querySelectorAll('.buyer-paid dt')].map(e=>({label:text(e),value:text(e.nextElementSibling)})),
            orderStatus:text(document.querySelector('.status-summary .summary-content')).split('\n')[0],itemCount,
            products:[...root?.querySelectorAll('a[href*="/itm/"]')||[]].map(e=>e.href)};
        }''')
        from datetime import datetime
        sold_at=None
        try:
            sold_at=datetime.strptime(snapshot.get('paidDate') or '', '%b %d, %Y').strftime('%Y-%m-%dT00:00:00.000Z')
            snapshot['paymentStatus']='paid'
        except ValueError:snapshot['paymentStatus']=''
        if receipt_identity(marketplace,page.url)!=identifier:raise ValueError('Order changed during inspection')
        observations=normalize_receipt(marketplace,snapshot,identifier)
        fields=snapshot.get('buyerPaid',[])
        def amount(label):
            values=[f['value'] for f in fields if f['label']==label]
            return usd_cents(values[0]) if len(values)==1 else None
        if not re.search(r'refund',snapshot.get('orderStatus',''),re.I):
            single_item_financials(observations,amount('Subtotal'),amount('Shipping'),sold_at)
        return observations
    heading = page.get_by_role('heading', name=re.compile(r'^(?:(?:Order(?: details)?|Receipt)\s*#?\s*)?'+re.escape(identifier)+r'$', re.I))
    expect(heading).to_have_count(1, timeout=15000)
    expect(heading).to_be_visible()
    # Prefer an order-specific region; main is allowed only on the exact detail
    # URL with an exact order heading and a complete explicit item count.
    root = heading.locator('xpath=ancestor::*[self::section or @role="region" or @role="tabpanel" or self::main][1]')
    expect(root).to_have_count(1)
    if marketplace=='etsy':
        # Read only the selected receipt's sale flags and item identities from
        # the seller page's own boot data. Never export buyer/payment details.
        native=page.evaluate(r'''id=>{
          const c=window.Etsy?.Context?.data?.initial_data?.orders?.orders_search;
          if(c?.type!=='Orders_OrdersCollection')return null;
          const matches=c.orders?.filter(o=>String(o.order_id)===id)||[];
          if(matches.length!==1)return null;
          const o=matches[0],p=o.payment||{},f=o.fulfillment||{};
          return {type:o.type,receiptId:String(o.order_id),paid:p.is_fully_paid,review:p.is_flagged_for_manual_review,
            cancelled:o.is_canceled,cancelPending:f.is_fully_or_pending_cancellation,refunded:p.is_fully_refunded,
            paidDate:p.payment_date,partialRefund:p.is_partially_refunded,
            amounts:{item:p.cost_breakdown?.discounted_items_cost,shipping:p.cost_breakdown?.adjusted_shipping_cost},
            declared:o.transaction_ids?.map(String),transactions:o.transactions?.map(t=>({id:String(t.transaction_id),listingId:String(t.listing_id)})),
            orderStatus:c.order_states?.find(s=>String(s.order_state_id)===String(o.order_state_id))?.state_type};
        }''',identifier)
        if native is not None:
            flags=['paid','review','cancelled','cancelPending','refunded']
            if native.get('type')!='EtsyRetail_Order' or native.get('receiptId')!=identifier or any(type(native.get(k)) is not bool for k in flags):
                raise ValueError('Etsy receipt sale flags were not verified')
            declared=native.get('declared');transactions=native.get('transactions')
            if not isinstance(declared,list) or not declared or any(not valid_receipt('etsy',value) for value in declared) or not isinstance(transactions,list) or len(declared)!=len(transactions) or set(declared)!={t.get('id') for t in transactions}:
                raise ValueError('Etsy receipt transaction count is incomplete')
            products=[f'https://www.etsy.com/listing/{t["listingId"]}' for t in transactions]
            displayed={etsy_listing_id(value) for value in root.locator('a[href*="/listing/"]').evaluate_all('els=>els.map(e=>e.href)')}
            transaction_links=root.locator('a[href*="/transaction/"]').evaluate_all('els=>els.map(e=>e.href)')
            displayed_transactions=set()
            for value in transaction_links:
                target=urlsplit(value);match=re.fullmatch(r'/transaction/(\d{1,24})/?',target.path)
                if target.scheme!='https' or target.hostname not in {'etsy.com','www.etsy.com'} or target.port or target.username or target.password or not match:
                    raise ValueError('Unexpected Etsy transaction snapshot link')
                displayed_transactions.add(match[1])
            if (displayed and (displayed!={etsy_listing_id(value) for value in products} or None in displayed)
                    or displayed_transactions and displayed_transactions!=set(declared)
                    or not displayed and not displayed_transactions):
                raise ValueError('Etsy receipt products differ from the selected order')
            if native['cancelled'] or native['cancelPending']:payment='cancelled'
            elif native['refunded']:payment='refunded'
            elif native['review']:payment=''
            elif native['paid']:
                expect(root.locator('#payment-msg')).to_contain_text(re.compile(r'^Paid via Etsy Payments on ',re.I))
                payment='paid'
            else:payment='payment pending'
            if receipt_identity('etsy',page.url)!=identifier:raise ValueError('Order changed during inspection')
            observations=normalize_receipt('etsy',{'receiptId':identifier,'paymentStatus':payment,'orderStatus':native.get('orderStatus') or 'seller order',
                                             'itemCount':len(declared),'products':products},identifier)
            amounts=native.get('amounts') or {}
            def amount(key,label):
                value=amounts.get(key)
                if not isinstance(value,dict) or value.get('type')!='Common_Money' or value.get('currency_code')!='USD':return None
                cents=value.get('value')
                if type(cents) is not int or usd_cents(value.get('formatted_value'))!=cents:return None
                rows=root.locator('.col-group').evaluate_all('''els=>els.filter(e=>e.children.length===2).map(e=>({label:e.children[0].innerText?.trim(),value:e.children[1].innerText?.trim()}))''')
                visible=[row['value'] for row in rows if row.get('label')==label]
                return cents if len(visible)==1 and usd_cents(visible[0])==cents else None
            if native.get('partialRefund') is False:
                single_item_financials(observations,amount('item','Item total'),amount('shipping','Shipping price'),sold_timestamp(native.get('paidDate')))
            return observations
    snapshot = root.evaluate(SNAPSHOT, {'id':identifier,'marketplace':marketplace})
    if receipt_identity(marketplace, page.url) != identifier: raise ValueError('Order changed during inspection')
    return normalize_receipt(marketplace, snapshot, identifier)


def discover_receipts(page, marketplace, max_pages, view):
    from playwright.sync_api import expect
    response = page.goto(START_URLS[marketplace], wait_until='domcontentloaded', timeout=30000)
    if not response or response.status != 200 or page.url.split('?')[0].rstrip('/') != START_URLS[marketplace]:
        raise ValueError('Seller orders did not load; sign in to the selling account')
    expect(page.get_by_role('heading', name=re.compile(r'^(?:Manage )?(?:all )?Orders(?: & (?:Shipping|Delivery)| awaiting shipment| awaiting payment| paid and shipped)?$', re.I))).to_be_visible(timeout=15000)
    name=re.compile(r'^'+re.escape(view)+r'\s*\d*$',re.I) if marketplace=='etsy' else view
    tab = page.get_by_role('tab', name=name, exact=True).or_(page.get_by_role('link', name=name, exact=True)).or_(page.get_by_role('button', name=name, exact=True))
    expect(tab).to_have_count(1, timeout=15000)
    if marketplace=='etsy' and tab.evaluate('e=>e.tagName')=='A':
        target=urljoin(page.url,tab.get_attribute('href') or '')
        expected={'/your/orders/sold/completed'} if view=='Completed' else {'/your/orders/sold','/your/orders/sold/new'}
        if urlsplit(target).hostname!='www.etsy.com' or urlsplit(target).path.rstrip('/') not in expected:raise ValueError('Unexpected Etsy order view link')
        # Full navigation refreshes the embedded collection/pagination metadata;
        # its initial New-view data stays stale after a client-side tab switch.
        page.goto(target,wait_until='domcontentloaded',timeout=30000)
    else:tab.click()
    keep_work_page_ready(page)
    urls, seen, complete = {}, set(), False
    reason = None
    for _ in range(max_pages):
        # A complete scan requires the displayed page to stop loading and either
        # show orders or an explicit empty state. No-body/403 is never zero sales.
        page.wait_for_function(r'''marketplace=>{
          const root=document.querySelector(marketplace==='ebay'?'#mod-main-cntr,main':'main');if(!root)return false;
          const c=window.Etsy?.Context?.data?.initial_data?.orders?.orders_search;
          if(marketplace==='etsy'&&c?.type==='Orders_OrdersCollection'&&c.total_count===0&&Array.isArray(c.order_ids)&&c.order_ids.length===0)return true;
          return [...root.querySelectorAll('a[href]')].some(e=>e.getClientRects().length&&(marketplace==='ebay'?/\/(?:sh|mesh)\/ord\/details\?/.test(e.href):e.href.includes('order_id=')))||
            [...root.querySelectorAll('h2,h3,[role=status]')].some(e=>e.getClientRects().length&&/^(No orders|No orders found|You have no orders|No orders here right now)[.!]?$/.test(e.innerText.trim()));
        }''', arg=marketplace, timeout=15000)
        root=page.locator('#mod-main-cntr') if marketplace=='ebay' and page.locator('#mod-main-cntr').count()==1 else page.locator('main')
        native_range=None
        if marketplace=='ebay' and page.locator('#mod-main-cntr').count()==1:
            counter=page.get_by_text(re.compile(r'^Results:\s*\d+\s*[-–]\s*\d+\s+of\s+\d+$',re.I))
            size=page.locator('.action-pagination__ipp')
            deadline=monotonic()+15
            while True:
                if counter.count()==1 and size.count()==1:
                    numbers=re.fullmatch(r'Results:\s*(\d+)\s*[-–]\s*(\d+)\s+of\s+(\d+)',counter.inner_text().strip(),re.I)
                    limit=re.fullmatch(r'Items Per Page:\s*(\d+)',size.inner_text().strip(),re.I)
                    if numbers and limit:
                        native_range=tuple(map(int,numbers.groups()))
                        first,last,total=native_range
                        if last>=min(total,first+int(limit[1])-1):break
                if monotonic()>=deadline:break
                page.wait_for_timeout(150)
        selector='a[href*="/ord/details"]' if marketplace=='ebay' else 'a[href*="order_id="]'
        # Native rows hydrate progressively; hidden read-only detail links also
        # belong to their row menus. Wait for a stable set rather than dropping
        # the last rows or collecting unrelated signed action URLs.
        previous_ids=None;stable_since=monotonic();deadline=monotonic()+15
        while True:
            links=root.locator(selector).evaluate_all('els=>els.map(e=>e.href)')
            ids=tuple(sorted({value for url in links if (value:=receipt_identity(marketplace,url))}))
            if ids!=previous_ids:previous_ids=ids;stable_since=monotonic()
            if monotonic()-stable_since>=.75:break
            if monotonic()>=deadline:raise ValueError('Seller order list did not settle')
            page.wait_for_timeout(100)
        current = {receipt_identity(marketplace, url):url for url in links if receipt_identity(marketplace, url)}
        signature = tuple(sorted(current))
        if signature in seen: return list(urls.values()), False, 'Seller order pagination did not advance'
        seen.add(signature); urls.update(current)
        if marketplace=='etsy':
            collection=page.evaluate('''()=>{const c=window.Etsy?.Context?.data?.initial_data?.orders?.orders_search;return c?.type==='Orders_OrdersCollection'?{total:c.total_count,hits:c.total_search_hit_count,ids:c.order_ids}:null}''')
            if collection is not None:
                ids=collection.get('ids');total=collection.get('total');hits=collection.get('hits')
                if type(total) is not int or type(hits) is not int or not isinstance(ids,list) or any(not valid_receipt('etsy',str(i)) for i in ids) or set(map(str,ids))!=set(current):
                    return list(urls.values()),False,'Etsy displayed receipts do not match its order collection'
                if hits!=total:return list(urls.values()),False,'Etsy order filters hide part of the selected history'
                if len(urls)==total:complete=True;break
        if marketplace=='ebay' and page.locator('#mod-main-cntr').count()==1:
            if native_range is None or len(current)!=native_range[1]-native_range[0]+1:
                return list(urls.values()),False,'Rendered order links do not match the displayed result count'
        next_page = page.get_by_role('button', name=re.compile(r'^Next(?: page)?$', re.I)).or_(page.get_by_role('link', name=re.compile(r'^Next(?: page)?$', re.I)))
        if next_page.count() == 1 and (not next_page.is_enabled() or next_page.get_attribute('aria-disabled') == 'true'):
            complete = native_range is None or native_range[1]>=native_range[2]
            if not complete:reason='Pagination conflicts with the displayed order count'
            break
        if next_page.count() != 1:
            if marketplace=='ebay':
                if native_range and native_range[1]>=native_range[2]:complete=True;break
            # Records are still useful, but missing pagination is not proof that
            # all pages/filters were covered.
            reason = 'Pagination coverage needs verification'; break
        if _ == max_pages - 1:
            reason = 'Sales scan reached its bounded page limit'; break
        previous = links
        next_page.click()
        scope='#mod-main-cntr' if marketplace=='ebay' and page.locator('#mod-main-cntr').count()==1 else 'main'
        page.wait_for_function('({old,selector})=>JSON.stringify([...document.querySelectorAll(selector)].map(e=>e.href))!==JSON.stringify(old)', arg={'old':previous,'selector':scope+' '+selector}, timeout=15000)
        keep_work_page_ready(page)
    return list(urls.values()), complete, reason


def scan_sales(page, marketplace, known_receipts=(), max_pages=10):
    if not isinstance(known_receipts, (list, tuple)) or len(known_receipts)>10000 or any(not valid_receipt(marketplace, value) for value in known_receipts):
        raise ValueError('Invalid confirmed receipt checkpoint')
    urls, complete, reason = [], True, None
    for view in (['All orders'] if marketplace == 'ebay' else ['New','Completed']):
        try:
            found, covered, message = discover_receipts(page, marketplace, max_pages, view)
            urls.extend(url for url in found if url not in urls)
            complete = complete and covered
            if message: reason = message
        except Exception:
            complete = False
            reason = 'At least one order view could not be read; coverage is incomplete'
    observations, checked, confirmed = [], [], []
    known = set(known_receipts)
    pending = [url for url in urls if receipt_identity(marketplace, url) not in known]
    if len(pending) > 100:
        complete = False; reason = 'Sales scan reached its bounded receipt limit'
    for url in pending[:100]:
        identifier = receipt_identity(marketplace, url)
        if identifier in known: continue
        try:
            rows = read_receipt(page, marketplace, url)
            observations.extend(rows); checked.append(identifier)
            if all(row['classification'] == 'confirmed_sale' for row in rows): confirmed.append(identifier)
        except Exception:
            complete = False
            reason = 'At least one seller order could not be verified; it will be checked again'
    return {'ok':True,'complete':complete,'receiptIds':[receipt_identity(marketplace,url) for url in urls],
            'checkedReceiptIds':checked,'confirmedReceiptIds':confirmed,'observations':observations,
            **({'reason':reason} if reason else {})}


def main(marketplace):
    parser = argparse.ArgumentParser()
    parser.add_argument('--max-pages', type=int, default=10)
    args = parser.parse_args()
    result = {'ok':False,'complete':False}
    try:
        if not 1 <= args.max_pages <= 20: raise ValueError('Invalid page limit')
        known = read_listing_input(sys.stdin.buffer).get('receiptIds', [])
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            with new_chrome_editor(pw, START_URLS[marketplace]) as page:
                result = scan_sales(page, marketplace, known, args.max_pages)
    except Exception as error:
        if result.get('ok'): result = {**result,'complete':False,'reason':'Sales read finished; browser cleanup needs attention'}
        else: result = {**result,'error':f'{type(error).__name__}: {str(error)[:1200]}'}
    print(marketplace.upper()+'_SALES_DONE '+json.dumps(result), flush=True)
    return 0 if result['ok'] else 1
