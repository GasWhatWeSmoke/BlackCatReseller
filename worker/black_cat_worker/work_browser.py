"""Keep owned marketplace windows visible without taking desktop keyboard focus."""
import json
import os
from pathlib import Path
from contextlib import contextmanager


def work_window_bounds():
    root = os.environ.get('BLACKCAT_DATA_ROOT') or str(Path(__file__).resolve().parents[2] / 'var')
    file = Path(root) / 'crawler-display.json'
    if not file.exists():
        raise ValueError('Second-monitor placement is unavailable; reopen Black Cat before opening webpages')
    value = json.loads(file.read_text(encoding='utf-8'))
    if value.get('secondary') is not True:
        raise ValueError('Connect the second monitor before opening Black Cat webpages')
    bounds = value.get('bounds', {})
    if (value.get('version') != 1 or set(bounds) != {'left', 'top', 'width', 'height'} or
            any(type(number) is not int for number in bounds.values()) or
            not 640 <= bounds['width'] <= 16384 or not 480 <= bounds['height'] <= 16384 or
            abs(bounds['left']) > 100000 or abs(bounds['top']) > 100000):
        raise ValueError('Marketplace browser display configuration is invalid; reopen Black Cat')
    return bounds


def work_window_args(bounds=None):
    bounds = work_window_bounds() if bounds is None else bounds
    return ['--new-window', f"--window-position={bounds['left']},{bounds['top']}",
            f"--window-size={bounds['width']},{bounds['height']}"]


def launch_work_context(playwright, profile_dir):
    # Preserve Legacy's existing bundled Chromium and profile. Start without a
    # desktop window, then create one explicitly in the background on monitor 2.
    from .assisted_browser import AssistedSession
    owner = AssistedSession(playwright, profile_dir, executable_path=playwright.chromium.executable_path)
    class OwnedContext:
        def __getattr__(self, name):
            return getattr(owner._ctx, name)
        def close(self):
            owner.close()
    return OwnedContext()


def configure_work_page(page, bounds=None, native_window=False):
    if native_window:
        # The native broker supplies virtual focus through the owned page's
        # existing attachment. Workers keep the visibility check without opening
        # a second CDP attachment or activating a desktop window.
        page.__dict__['_blackcat_visible_work_window'] = True
        return
    session = page.context.new_cdp_session(page)
    try:
        if bounds is not None:
            window = session.send('Browser.getWindowForTarget')
            session.send('Browser.setWindowBounds', {'windowId': window['windowId'], 'bounds': {'windowState': 'normal'}})
            session.send('Browser.setWindowBounds', {'windowId': window['windowId'], 'bounds': bounds})
        session.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    except Exception:
        session.detach()
        raise
    page.__dict__['_blackcat_work_cdp'] = session


def keep_work_page_ready(page):
    if page.__dict__.get('_blackcat_visible_work_window') is True:
        page.wait_for_function('document.visibilityState === "visible"')
        return
    session = page.__dict__.get('_blackcat_work_cdp')
    if session is not None:
        session.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    else:
        page.bring_to_front()


@contextmanager
def verification_page(owner, anonymous=False):
    """A separate check page in an owned profile, without activating its window."""
    browser = owner.context.browser
    if browser is None:
        raise ValueError('Cannot verify without the owning browser')
    managed = owner.__dict__.get('_blackcat_work_cdp') is not None
    context = None
    check = None
    cdp = None
    try:
        if managed:
            cdp = browser.new_browser_cdp_session()
            if anonymous:
                before = set(cdp.send('Target.getBrowserContexts')['browserContextIds'])
                context = browser.new_context()
                created = set(cdp.send('Target.getBrowserContexts')['browserContextIds']) - before
                if len(created) != 1:
                    raise ValueError('Cannot identify the newly created anonymous verification context')
                context_id = created.pop()
            else:
                context = owner.context
                owner_cdp = owner.context.new_cdp_session(owner)
                try:
                    context_id = owner_cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
                finally:
                    owner_cdp.detach()
            with context.expect_page(timeout=30000) as created_page:
                cdp.send('Target.createTarget', {'url': 'about:blank', 'browserContextId': context_id,
                         'newWindow': True, 'background': True, 'focus': False, **(work_window_bounds() or {})})
            check = created_page.value
            configure_work_page(check, work_window_bounds())
        else:
            context = browser.new_context() if anonymous else owner.context
            check = context.new_page()
        yield check
    finally:
        if anonymous and context is not None:
            context.close()
        elif check is not None:
            check.close()
        if cdp is not None:
            cdp.detach()
