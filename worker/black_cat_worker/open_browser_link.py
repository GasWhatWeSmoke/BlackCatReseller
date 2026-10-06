"""Open a user-requested Chrome webpage without activating a personal window."""
import argparse
import json
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler

from .browser_lease import BrowserLease, browser_lease_path
from .chrome_session import session_endpoint
from .work_browser import work_window_bounds


def open_link(url):
    parsed = urlsplit(url)
    setup_page = url in {'http://127.0.0.1:41999/browser-link', 'chrome://extensions/'}
    if (not setup_page and parsed.scheme != 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Only HTTPS webpage links are supported')
    work_window_bounds()  # No missing-display fallback before connecting Chrome.
    with BrowserLease(browser_lease_path()):
        endpoint = session_endpoint('background-link-v1').replace('ws://', 'http://', 1) + '/open-window'
        request = Request(endpoint, data=json.dumps({'url': url}).encode(),
                          headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with build_opener(ProxyHandler({})).open(request, timeout=40) as response:
                return json.loads(response.read(4096)).get('ok') is True
        except Exception:
            raise RuntimeError('Chrome could not open the webpage on the second monitor') from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    args = parser.parse_args()
    try:
        return 0 if open_link(args.url) else 1
    except Exception:
        # Private helper endpoints and webpage query strings stay out of logs.
        print('Connect the second monitor and the Black Cat Chrome session to open webpages')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
