"""Read existing account policies from an owned Chrome tab; never edit policies."""
import argparse
import json
import re
from urllib.parse import urlsplit

from .chrome_editor import new_chrome_editor
from .ebay_form import control, set_field

POLICIES_URL = 'https://www.ebay.com/bp/manage'


def read_policy_page(page):
    location = urlsplit(page.url)
    if location.hostname != 'www.ebay.com' or location.path.rstrip('/') != '/bp/manage':
        raise ValueError('Finish signing into eBay in Chrome, then refresh eBay policies.')
    page.get_by_role('heading', name=re.compile(r'business policies', re.I)).first.wait_for(timeout=15000)
    snapshot = '''() => {
      const visible=e=>!!e.getClientRects().length;
      const clean=s=>s.replace(/\\s+/g,' ').trim();
      const kinds={shipping:'shipping',postage:'shipping',return:'return',returns:'return',payment:'payment',
        'shipping policy':'shipping','return policy':'return','payment policy':'payment'};
      const policies=[];let recognized=false,invalid=false;
      for(const table of [...document.querySelectorAll('table,[role=table],[role=grid]')].filter(visible)){
        const headers=[...table.querySelectorAll('th,[role=columnheader]')].map(e=>clean(e.textContent).toLowerCase());
        const nameIndex=headers.findIndex(x=>['name','policy name'].includes(x));
        const typeIndex=headers.findIndex(x=>['type','policy type'].includes(x));
        if(nameIndex<0||typeIndex<0)continue;
        recognized=true;
        for(const row of [...table.querySelectorAll('tr,[role=row]')].filter(visible)){
          const cells=[...row.querySelectorAll('td,[role=cell],[role=gridcell]')];if(!cells.length)continue;
          const nameCell=cells[nameIndex],typeCell=cells[typeIndex];
          if(!nameCell||!typeCell){invalid=true;continue}
          const kind=kinds[clean(typeCell.textContent).toLowerCase()];
          const label=nameCell.querySelector('a,button')||nameCell;
          const name=clean(label.textContent);
          if(!kind||!name||name.length>200){invalid=true;continue}
          const isDefault=[...row.querySelectorAll('[aria-label="Default policy"],[title="Default policy"]')].some(visible)
            || cells.some((cell,index)=>['default','default policy','status'].includes(headers[index])&&['default','default policy'].includes(clean(cell.textContent).toLowerCase()));
          policies.push({kind,name,isDefault});
        }
      }
      const empty=[...document.querySelectorAll('main p,[role=status]')].some(e=>visible(e)&&/^(you (?:have|haven.t created)|no).*polic/i.test(clean(e.textContent)));
      return {policies,recognized,invalid,empty};
    }'''
    for _ in range(50):
        result = page.evaluate(snapshot)
        if result['invalid']:
            break
        if result['empty'] or result['recognized'] and result['policies']:
            return result['policies']
        page.wait_for_timeout(200)
    headers = [text.strip()[:80] for text in page.locator('th,[role="columnheader"]').filter(visible=True).all_text_contents()[:20]]
    raise ValueError('The eBay business-policy table could not be read. Observed column labels: '
                     + json.dumps(headers) + '. Keep automatic account defaults or choose a policy name manually.')


def read_policies(page):
    if urlsplit(page.url).hostname != 'www.ebay.com':
        raise ValueError('Finish signing into eBay in Chrome, then refresh eBay policies.')
    # Read the complete account list, not a previously saved name/type filter.
    search_name = re.compile(r'^Search(?: policies| by (?:policy )?name)?$', re.I)
    search = page.get_by_role('searchbox', name=search_name).or_(page.get_by_role('textbox', name=search_name)).or_(page.get_by_placeholder(search_name))
    if search.count() > 1:
        raise ValueError('eBay policy search controls are ambiguous; no automatic choice was saved.')
    if search.count() == 1 and search.input_value().strip():
        search.fill(''); search.press('Enter'); page.wait_for_timeout(500)
    all_types = page.get_by_role('tab', name=re.compile(r'^All(?: policies| policy types)?$', re.I)).filter(visible=True)
    if all_types.count() == 1 and all_types.get_attribute('aria-selected') != 'true':
        all_types.click(); page.wait_for_timeout(500)
    type_filter = control(page, ['Policy type', 'Filter by policy type'], required=False)
    if type_filter is not None:
        set_field(page, ['Policy type', 'Filter by policy type'], 'All', ['All policies', 'All policy types'])
        page.wait_for_timeout(500)
    policies = []
    seen = set()
    for _ in range(10):
        current = read_policy_page(page)
        fingerprint = json.dumps(current, sort_keys=True)
        if fingerprint in seen:
            raise ValueError('eBay policy pagination did not advance; no automatic choice was saved.')
        seen.add(fingerprint); policies.extend(current)
        if len(policies) > 200:
            raise ValueError('Too many eBay policies to verify in one pass.')
        following = page.get_by_role('button', name=re.compile(r'^Next(?: page)?$', re.I)).or_(
            page.get_by_role('link', name=re.compile(r'^Next(?: page)?$', re.I))).filter(visible=True)
        if following.count() == 0 or following.count() == 1 and (not following.is_enabled() or following.get_attribute('aria-disabled') == 'true'):
            pagination = page.locator('[aria-label*="pagination" i]').inner_text() if page.locator('[aria-label*="pagination" i]').count() == 1 else ''
            unfinished = re.search(r'Page\s+(\d+)\s+of\s+(\d+)', pagination, re.I)
            if unfinished and int(unfinished[1]) < int(unfinished[2]):
                raise ValueError('eBay policy pagination is incomplete; no automatic choice was saved.')
            if len({(value['kind'], value['name'].casefold()) for value in policies}) != len(policies):
                raise ValueError('eBay has duplicate policy names; automatic selection needs review.')
            return {'policies': policies, 'complete': True}
        if following.count() != 1:
            raise ValueError('eBay policy pagination is ambiguous; no automatic choice was saved.')
        following.click()
        for _ in range(50):
            page.wait_for_timeout(200)
            if json.dumps(read_policy_page(page), sort_keys=True) != fingerprint:
                break
    raise ValueError('eBay policy pagination did not complete; no automatic choice was saved.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw, new_chrome_editor(pw, POLICIES_URL) as page:
            result = read_policies(page)
        print('EBAY_POLICIES_DONE ' + json.dumps({'ok': True, **result}), flush=True)
    except Exception as error:
        # Browser connection traces can contain private endpoints; do not emit them.
        message = str(error) if isinstance(error, ValueError) else 'Could not read eBay policies. Connect Chrome, finish eBay sign-in, then refresh policies.'
        print('EBAY_POLICIES_DONE ' + json.dumps({'ok': False, 'error': message}), flush=True)


if __name__ == '__main__':
    main()
