"""Read Mercari seller orders. No buyer messages, shipments or order mutations."""
import json
import re
from .work_browser import keep_work_page_ready
import sys
from time import monotonic
from urllib.parse import urlsplit
from .chrome_editor import new_chrome_editor
from .direct_listing import read_listing_input
from .mercari_form import INVENTORY_URL, listing_id

RECEIPT=re.compile(r'(?:m\d{9,15}|\d{1,24})')


def order_id(value):
    try:
        url=urlsplit(value)
        match=re.fullmatch(r'/transaction/order[_-]status/((?:m\d{9,15}|\d{1,24}))/?',url.path)
        return match[1] if match and url.scheme=='https' and url.hostname=='www.mercari.com' and not url.port and not url.username and not url.password else None
    except (ValueError,TypeError):return None


def normalize_order(snapshot,identifier):
    if not isinstance(identifier,str) or not RECEIPT.fullmatch(identifier) or snapshot.get('orderId')!=identifier or snapshot.get('sellerView') is not True:
        raise ValueError('Mercari seller order identity was not verified')
    products=snapshot.get('products');count=snapshot.get('itemCount')
    if not isinstance(products,list) or type(count) is not int or not 1<=count<=100:raise ValueError('Mercari order items are incomplete')
    ids={listing_id(value) for value in products}
    if None in ids or len(ids)!=count:raise ValueError('Mercari order links do not match its item count')
    status=str(snapshot.get('status') or '').strip().casefold()
    payment=str(snapshot.get('payment') or '').strip().casefold()
    if snapshot.get('paymentConflict'):classification='requires_review'
    elif re.search(r'cancel|refund|return|unpaid|payment (?:pending|processing|failed|declined)',status+' '+payment):classification='not_sale'
    elif status and (payment in {'paid','payment received','payment completed','payment approved'} or
                    not payment and status in {'awaiting shipment','ready to ship','in transit','shipped','delivered','rated','complete','completed','transaction complete'} and snapshot.get('fulfillmentReady') is True):classification='confirmed_sale'
    else:classification='requires_review'
    return [{'marketplace':'mercari','receiptId':identifier,'reference':f'{identifier}/{item}',
             'listingId':item,'listingUrl':f'https://www.mercari.com/us/item/{item}/','classification':classification} for item in sorted(ids)]


def read_order(page,url):
    from .sale_financials import usd_cents, single_item_financials
    from playwright.sync_api import expect
    identifier=order_id(url)
    if not identifier:raise ValueError('Invalid Mercari order URL')
    response=page.goto(url,wait_until='domcontentloaded',timeout=30000)
    if not response or response.status!=200 or order_id(page.url)!=identifier:raise ValueError('Mercari order redirected or did not load')
    expect(page.get_by_role('heading',name=re.compile(r'^Order (?:status|details)$',re.I))).to_be_visible(timeout=15000)
    root=page.locator('main')
    page.wait_for_function('''()=>document.querySelector('[data-testid="OrderDetails"] [data-testid="OrderDetails-Value-Copy"]')||document.querySelector('[data-testid="order-items"],section[aria-label="Order items"]')''',timeout=15000)
    native=page.get_by_test_id('OrderDetails')
    if native.count()==1:
        expect(page.get_by_role('heading',name='Buyer information',exact=True)).to_be_visible()
        expect(native.get_by_role('heading',name='Item ID',exact=True)).to_have_count(1)
        copy=native.get_by_test_id('OrderDetails-Value-Copy');expect(copy).to_have_count(1)
        match=re.fullmatch(r'\s*(m\d{9,15})\s*Copy\s*',copy.locator('..').inner_text())
        if not match or match[1]!=identifier:raise ValueError('Mercari receipt did not verify one exact item identity')
        products=native.get_by_test_id('ItemNameLink').evaluate_all('els=>els.map(e=>e.href)')
        if {listing_id(value) for value in products}!={identifier}:raise ValueError('Mercari receipt product differs from its item identity')
        steps=page.get_by_test_id('TimelineStepName').evaluate_all("els=>els.filter(e=>e.tagName==='H1'&&e.getClientRects().length).map(e=>e.innerText.trim())")
        if len(steps)!=1:raise ValueError('Mercari current transaction status is ambiguous')
        controls=page.locator('[data-testid^="TimelineActionButton-"],[data-testid="ShippingCTAButton"]').evaluate_all("els=>els.filter(e=>e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-disabled')!=='true').map(e=>e.innerText.trim())")
        can_ship=any(re.fullmatch(r'(?:Confirm shipment|Print shipping label|View shipping label|View label)',value,re.I) for value in controls)
        earned=native.get_by_test_id('You-made-label')
        seller_earnings=earned.count()==1 and earned.inner_text().strip()=='You made'
        status=steps[0]
        if can_ship and not re.search(r'cancel|refund|return|unpaid|payment',status,re.I):status='awaiting shipment'
        if order_id(page.url)!=identifier:raise ValueError('Mercari changed orders during the read')
        observations=normalize_order({'orderId':identifier,'sellerView':True,'products':products,'itemCount':1,'status':status,'payment':'',
                                'fulfillmentReady':can_ship or seller_earnings and status.casefold() in {'shipped','delivered','rated','complete'}},identifier)
        price=native.get_by_test_id('Sold-price-value');label=native.get_by_test_id('Sold-price-label')
        if price.count()==1 and label.count()==1 and label.inner_text().strip()=='Sold price':
            single_item_financials(observations,usd_cents(price.inner_text()))
        return observations
    snapshot=root.evaluate(r'''(root,id)=>{
      const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const controls=[...root.querySelectorAll('button,a')].filter(visible).filter(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true').map(e=>e.innerText.trim());
      const fields=[...root.querySelectorAll('dt')].filter(visible).map(e=>({label:e.innerText.trim().toLowerCase(),value:e.nextElementSibling?.innerText?.trim()}));
      const status=[...root.querySelectorAll('[data-testid="order-status"],.order-status')].filter(visible).map(e=>e.innerText.trim());
      const payment=[...root.querySelectorAll('[data-testid="payment-status"],.payment-status')].filter(visible).map(e=>e.innerText.trim());
      const read=(label,values)=>{const all=[...fields.filter(f=>f.label===label).map(f=>f.value),...values].filter(Boolean);return new Set(all).size===1?all[0]:null};
      const products=[...root.querySelectorAll('[data-testid="order-items"] a[href],section[aria-label="Order items"] a[href]')].filter(visible).map(e=>e.href);
      const countText=[...root.querySelectorAll('[data-testid="item-count"],h2,h3')].filter(visible).map(e=>e.innerText.trim()).find(t=>/^\d+ items?$/i.test(t));
      const sellerView=controls.some(t=>/^(?:Confirm shipment|Print shipping label|View shipping label|Rate buyer|View earnings)$/i.test(t));
      return {orderId:id,sellerView,products,itemCount:countText?parseInt(countText,10):null,status:read('order status',status),payment:read('payment status',payment),
        paymentConflict:new Set([...fields.filter(f=>f.label==='payment status').map(f=>f.value),...payment].filter(Boolean)).size>1,
        fulfillmentReady:controls.some(t=>/^(?:Confirm shipment|Print shipping label|View shipping label|Rate buyer|View earnings)$/i.test(t))};
    }''',identifier)
    if order_id(page.url)!=identifier:raise ValueError('Mercari changed orders during the read')
    return normalize_order(snapshot,identifier)


NATIVE_PAGING=r'''()=>{
  const table=document.querySelector('[data-testid="Listings"]');if(!table)return null;
  const key=Object.keys(table).find(k=>k.startsWith('__reactFiber'));let leaf=table[key],root=leaf;
  while(root?.return)root=root.return;
  if(root?.stateNode?.current&&root.stateNode.current!==root)leaf=leaf?.alternate;
  for(let f=leaf,depth=0;f&&depth<14;f=f.return,depth++){
    const value=f.memoizedProps?.myListings;if(!value)continue;
    return {loading:value.loading,status:value.criteria?.status,keyword:value.criteria?.keyword,ids:value.items?.map(i=>i.id),
      hasNext:value.pagination?.hasNext,page:value.pagination?.currentPage,total:value.pagination?.totalCount,size:value.pagination?.pageSize};
  }
  return null;
}'''


def scan_sales(page,known=(),max_pages=10):
    from playwright.sync_api import expect
    if not isinstance(known,(list,tuple)) or len(known)>10000 or any(not isinstance(value,str) or not RECEIPT.fullmatch(value) for value in known):raise ValueError('Invalid Mercari receipt checkpoint')
    urls={};complete=True;reason=None;deadline=monotonic()+200
    for tab in ('in_progress','complete'):
        if monotonic()>deadline-45:
            complete=False;reason='Mercari scan reached its time budget';break
        try:
            response=page.goto(f'https://www.mercari.com/mypage/listings/{tab}/',wait_until='domcontentloaded',timeout=30000)
            if not response or response.status!=200 or urlsplit(page.url).path.rstrip('/')!=f'/mypage/listings/{tab}':raise ValueError('Mercari seller orders did not load')
            expect(page.get_by_role('heading',name=re.compile(r'^My listings$',re.I))).to_be_visible(timeout=15000)
            keep_work_page_ready(page)
            search=page.get_by_test_id('SearchBarInput')
            if search.count()==1 and search.input_value().strip():search.fill('');search.press('Enter')
            seen=set()
            for index in range(max_pages):
                if monotonic()>deadline-45:
                    complete=False;reason='Mercari scan reached its time budget';break
                native=None
                if page.get_by_test_id('Listings').count()==1:
                    native=page.wait_for_function(f'''({{status,pageNumber}})=>{{const value=({NATIVE_PAGING})();return value&&value.loading===false&&value.status===status&&!value.keyword&&value.page===pageNumber&&typeof value.hasNext==='boolean'?value:false}}''',
                        arg={'status':'trading' if tab=='in_progress' else 'sold_out','pageNumber':index+1},timeout=15000).json_value()
                page.wait_for_function(r'''()=>{const root=document.querySelector('main');return root&&([...root.querySelectorAll('a[href]')].some(e=>e.getClientRects().length&&/\/transaction\/order[_-]status\//.test(e.href))||
                  [...root.querySelectorAll('[data-testid="ZeroListings"]')].some(e=>e.getClientRects().length&&/^No (?:in progress|completed?) orders yet/.test(e.innerText.trim()))||
                  [...root.querySelectorAll('[role=status],h2,h3')].some(e=>e.getClientRects().length&&/^No (?:items|listings|orders)(?: found)?[.!]?$/i.test(e.innerText.trim())))}''',timeout=15000)
                links=page.locator('main a[href*="/transaction/order"]').evaluate_all('els=>els.map(e=>e.href)')
                current={order_id(url):url for url in links if order_id(url)}
                signature=tuple(sorted(current))
                if signature in seen:raise ValueError('Mercari order pagination did not advance')
                seen.add(signature);urls.update(current)
                if native is not None:
                    ids=native.get('ids')
                    if not isinstance(ids,list) or any(not isinstance(value,str) or not RECEIPT.fullmatch(value) for value in ids) or set(ids)!=set(current):
                        raise ValueError('Mercari displayed orders differ from its current collection')
                    if not native['hasNext']:break
                    next_page=page.get_by_test_id('NextPage')
                    if next_page.count()!=1 or not next_page.is_enabled() or index==max_pages-1:
                        complete=False;reason='Mercari next order page could not be verified';break
                    next_page.click();keep_work_page_ready(page);continue
                next_page=page.get_by_role('button',name=re.compile(r'^Next(?: page)?$',re.I)).or_(page.get_by_role('link',name=re.compile(r'^Next(?: page)?$',re.I)))
                if next_page.count()==1 and (not next_page.is_enabled() or next_page.get_attribute('aria-disabled')=='true'):break
                if next_page.count()!=1 or index==max_pages-1:
                    complete=False;reason='Mercari order pagination coverage needs verification';break
                next_page.click()
                page.wait_for_function('old=>JSON.stringify([...document.querySelectorAll("main a[href*=\\"/transaction/order\\"]")].map(e=>e.href))!==JSON.stringify(old)',arg=links,timeout=15000)
                keep_work_page_ready(page)
        except Exception:
            complete=False;reason='A Mercari seller-order view could not be verified'
    observations=[];checked=[];confirmed=[]
    pending=[(identifier,url) for identifier,url in urls.items() if identifier not in set(known)]
    if len(pending)>100:complete=False;reason='Mercari scan reached its receipt limit'
    for identifier,url in pending[:100]:
        if monotonic()>deadline-45:
            complete=False;reason='Mercari scan reached its time budget; confirmed receipts were retained';break
        try:
            rows=read_order(page,url);observations.extend(rows);checked.append(identifier)
            if all(row['classification']=='confirmed_sale' for row in rows):confirmed.append(identifier)
        except Exception:complete=False;reason='At least one Mercari order could not be verified and will be checked again'
    return {'ok':True,'complete':complete,'receiptIds':list(urls),'checkedReceiptIds':checked,'confirmedReceiptIds':confirmed,'observations':observations,**({'reason':reason} if reason else {})}


def main():
    result={'ok':False,'complete':False}
    try:
        known=read_listing_input(sys.stdin.buffer).get('receiptIds',[])
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            with new_chrome_editor(pw,INVENTORY_URL) as page:result=scan_sales(page,known)
    except Exception as error:
        if result.get('ok'):result={**result,'complete':False,'reason':'Mercari orders read; browser cleanup needs attention'}
        else:result={**result,'error':f'{type(error).__name__}: {str(error)[:1200]}'}
    print('MERCARI_SALES_DONE '+json.dumps(result),flush=True)
    return 0 if result['ok'] else 1


if __name__=='__main__':raise SystemExit(main())
