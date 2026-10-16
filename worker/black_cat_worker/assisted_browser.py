"""Assisted-posting browser session — drive the operator's REAL, installed Chrome.

Why this exists: Playwright's bundled Chromium carries automation flags
(`navigator.webdriver === true`, `--enable-automation`) that marketplace edge
protection (Cloudflare & friends) fingerprints and blocks — Depop returned a
403 before its login page even rendered. This module launches the operator's
own Google Chrome as a NORMAL browser (a plain user-data-dir plus the standard
`--remote-debugging-port` that Chrome DevTools itself uses) and connects
Playwright to it over CDP.

The distinction that keeps this on the right side of the line: we are not
disguising a bot as a human. We are automating the genuine browser the operator
runs, with their own profile. `navigator.webdriver` is false here because the
browser truly was NOT launched by an automation framework — nothing is being
overridden or spoofed. No stealth plugins, no fingerprint patching, no
user-agent lies, no CAPTCHA solving, no proxying. If a marketplace still refuses
an assisted, operator-present session in their own real browser, that refusal is
respected — the answer is to tell the operator, not to evade it.

Falls back to Playwright's bundled Chromium only when no real Chrome is found,
with a logged warning, so a machine without Chrome still limps rather than dies.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
from typing import List, Optional
from .work_browser import work_window_bounds, work_window_args, configure_work_page


def _log(msg: str) -> None:
    print(msg, flush=True)


def find_real_chrome() -> Optional[str]:
    """The operator's installed Chrome, or None. Env override wins so a non-standard
    install (or Chromium/Brave/Edge, all Chrome-channel) can be pointed at explicitly."""
    override = os.environ.get("BLACKCAT_CHROME_PATH")
    if override and os.path.isfile(override):
        return override
    candidates: List[str] = []
    for var in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(var)
        if base:
            candidates.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    # Non-Windows / PATH fallbacks (the worker is Windows today, but keep it portable).
    for name in ("chrome", "google-chrome", "google-chrome-stable"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def _free_port(preferred: int) -> int:
    """Prefer a fixed port (only one assisted browser runs at a time, gated by the
    machine-wide mutex), but fall back to an ephemeral one if it is taken."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return s.getsockname()[1]
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def _wait_for_devtools(port: int, timeout: float = 25.0) -> Optional[str]:
    """Poll Chrome's local DevTools endpoint and return its exact browser socket."""
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/json/version"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    endpoint = json.loads(resp.read().decode("utf-8"))["webSocketDebuggerUrl"]
                    if _endpoint_port(endpoint) == port:
                        return endpoint
        except Exception:
            time.sleep(0.4)
    return None


def _endpoint_port(endpoint: str) -> int:
    value = urlsplit(endpoint)
    if (value.scheme != 'ws' or value.hostname != '127.0.0.1' or value.username or value.password
            or value.query or value.fragment or not value.port
            or not re.fullmatch(r'/devtools/browser/[A-Za-z0-9-]+', value.path)):
        raise ValueError('Invalid dedicated Chrome endpoint')
    return value.port


def _browser_pid(connection) -> int:
    session = connection.new_browser_cdp_session()
    try:
        processes = session.send('SystemInfo.getProcessInfo')['processInfo']
        ids = [p['id'] for p in processes if p['type'] == 'browser']
        if len(ids) != 1 or type(ids[0]) is not int or ids[0] <= 0:
            raise ValueError('Chrome process identity is unavailable')
        return ids[0]
    finally:
        session.detach()


def _browser_receipt(profile_dir, chrome, endpoint, pid):
    _endpoint_port(endpoint)
    return {'version': 1, 'profile': os.path.normcase(os.path.realpath(profile_dir)),
            'executable': os.path.normcase(os.path.realpath(chrome)), 'endpoint': endpoint, 'pid': pid}


def _saved_browser(profile_dir, chrome):
    file = Path(profile_dir) / '.blackcat-browser-owner.json'
    try:
        if file.stat().st_size > 16384:
            return None
        value = json.loads(file.read_text(encoding='utf-8'))
        if type(value.get('pid')) is not int or value['pid'] <= 0:
            return None
        if value != _browser_receipt(profile_dir, chrome, value['endpoint'], value['pid']):
            return None
        if _wait_for_devtools(_endpoint_port(value['endpoint']), timeout=1) != value['endpoint']:
            return None
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _close_owned_target(endpoint, target_id):
    """Bound cleanup to one target and one short-lived helper, never a Chrome PID."""
    _endpoint_port(endpoint)
    if not isinstance(target_id, str) or not re.fullmatch(r'[A-Za-z0-9-]+', target_id):
        raise ValueError('Owned Chrome target identity is unavailable')
    import playwright
    node = Path(playwright.__file__).parent / 'driver' / ('node.exe' if os.name == 'nt' else 'node')
    result = subprocess.run([str(node), str(Path(__file__).with_name('close_owned_target.cjs')),
        endpoint, target_id], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=8,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    return result.returncode == 0


def manual_login_args(chrome: str, profile_dir: str, start_url: str) -> List[str]:
    """Build the intentionally non-automated Chrome command used for account login.

    Login and security verification must happen in an ordinary browser window. In
    particular, this command must never gain a remote-debugging or automation flag;
    Playwright only attaches later, when the operator explicitly starts a posting run.
    """
    return [
        chrome,
        f"--user-data-dir={profile_dir}",
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        *work_window_args(),
        start_url,
    ]


def run_manual_login(profile_dir: str, start_url: str, timeout: Optional[float] = None, platform_name: str = "Depop") -> None:
    """Open a dedicated real-Chrome profile with no automation attached and wait
    for the operator to close it after logging in.

    There is no default deadline: password recovery and security checks are
    operator-paced. Closing the window releases the login browser claim.

    The process must stay alive: an immediate exit means Chrome handed the URL to
    some other profile/window, which would not save the session Black Cat posts with.
    """
    chrome = find_real_chrome()
    if not chrome:
        raise RuntimeError(
            f"Google Chrome is required to link {platform_name}"
        )
    os.makedirs(profile_dir, exist_ok=True)
    started = time.time()
    startup = {}
    if os.name == 'nt':
        info = subprocess.STARTUPINFO()
        info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        info.wShowWindow = 4
        startup['startupinfo'] = info
    proc = subprocess.Popen(manual_login_args(chrome, profile_dir, start_url), **startup)
    _log("[assist] opened your installed Chrome without automation — finish logging in, then close that window")
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        raise RuntimeError(f"the {platform_name} login window reached its time limit; close it and try again") from exc
    if time.time() - started < 2.0:
        raise RuntimeError(
            f"Chrome did not keep the dedicated {platform_name} profile open; close any older {platform_name} login window and try again"
        )
    if code != 0:
        raise RuntimeError(f"the {platform_name} login window closed unexpectedly (Chrome exit {code})")


class AssistedSession:
    """Own one work target in a dedicated profile, preserving other open windows.

    A surviving browser can be reused only with its recorded socket and process
    identity. Closing the session never closes the browser process or context.
    """

    def __init__(self, pw, profile_dir: str, port_hint: int = 9333, start_url: str = "about:blank", executable_path=None):
        from .browser_lease import BrowserLease, browser_lease_path
        os.makedirs(profile_dir, exist_ok=True)
        self._lease = BrowserLease(browser_lease_path(profile_dir))
        self._lease.acquire()
        self._executable_path = executable_path
        try:
            self._open(pw, profile_dir, port_hint, start_url)
        except BaseException:
            self.close()
            raise

    def _open(self, pw, profile_dir, port_hint, start_url):
        self._proc: Optional[subprocess.Popen] = None
        self._browser = None
        self._ctx = None
        self.page = None
        self.real = False
        self._target_id = None
        self._endpoint = None

        chrome = self._executable_path or find_real_chrome()
        bounds = work_window_bounds()
        if chrome:
            saved = _saved_browser(profile_dir, chrome)
            port = _free_port(port_hint) if saved is None else _endpoint_port(saved['endpoint'])
            # A NORMAL browser launch: real profile + the standard remote-debugging
            # port. No automation switches, nothing hidden — this is the browser the
            # operator uses, with a debugger attached the way DevTools attaches one.
            args = [
                chrome,
                f"--user-data-dir={profile_dir}",
                f"--remote-debugging-port={port}",
                "--no-first-run",
                "--no-default-browser-check",
                '--no-startup-window',
                '--disable-background-mode',
            ]
            try:
                startup = {}
                if bounds and os.name == 'nt':
                    info = subprocess.STARTUPINFO()
                    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    info.wShowWindow = 4  # SW_SHOWNOACTIVATE: leave the user's keyboard focus alone.
                    startup['startupinfo'] = info
                if saved is None:
                    self._proc = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **startup)
                base = saved['endpoint'] if saved is not None else _wait_for_devtools(port)
                if not base:
                    raise RuntimeError("Chrome did not expose its DevTools endpoint in time")
                self._browser = pw.chromium.connect_over_cdp(base)
                expected_pid = saved['pid'] if saved is not None else self._proc.pid
                if _browser_pid(self._browser) != expected_pid:
                    raise RuntimeError('Chrome endpoint belongs to another process')
                self._endpoint = base
                receipt = Path(profile_dir) / '.blackcat-browser-owner.json'
                temporary = receipt.with_suffix('.tmp')
                temporary.write_text(json.dumps(_browser_receipt(profile_dir, chrome, base, expected_pid)), encoding='utf-8')
                os.replace(temporary, receipt)
                self._ctx = self._browser.contexts[0] if self._browser.contexts else self._browser.new_context()
                cdp = self._browser.new_browser_cdp_session()
                try:
                    with self._ctx.expect_page() as created:
                        result = cdp.send('Target.createTarget', {'url': 'about:blank', 'newWindow': True,
                                 'background': True, 'focus': False, **bounds})
                        self._target_id = result['targetId']
                    candidates = [created.value, *self._ctx.pages]
                    for candidate in candidates:
                        probe = self._ctx.new_cdp_session(candidate)
                        try:
                            if probe.send('Target.getTargetInfo')['targetInfo']['targetId'] == self._target_id:
                                self.page = candidate
                                break
                        finally:
                            probe.detach()
                    if self.page is None:
                        raise RuntimeError('Could not identify the newly created work window')
                finally:
                    cdp.detach()
                if bounds:
                    configure_work_page(self.page, bounds)
                if start_url and start_url != 'about:blank':
                    self.page.goto(start_url, wait_until='domcontentloaded')
                self.real = self._executable_path is None
                _log(f"[assist] driving a background browser window ({os.path.basename(chrome)})")
                return
            except Exception as e:
                # A busy/failed installed profile must not be opened by another
                # browser version. Preserve its session and report the failure.
                self.close()
                raise RuntimeError("Could not attach to installed Chrome. Close any other window using this marketplace profile and retry.") from e

        # Keep the bundled fallback, with the same background startup policy.
        # Never let Playwright's default visible launch choose the primary screen.
        self._executable_path = pw.chromium.executable_path
        self._open(pw, profile_dir, port_hint, start_url)

    def wait_until_closed(self, timeout: float) -> None:
        """Wait for this work page, independently of any other open windows."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.page.is_closed():
                    return
                self.page.wait_for_timeout(2000)
            except Exception:
                return

    def close(self) -> None:
        try:
            endpoint, target_id = getattr(self, '_endpoint', None), getattr(self, '_target_id', None)
            if endpoint and target_id:
                try:
                    if not _close_owned_target(endpoint, target_id):
                        _log('[assist] Could not confirm the work window closed; other Chrome windows were preserved')
                except Exception:
                    _log('[assist] Work-window cleanup was unavailable; Chrome was left running')
            # Disconnect the CDP client. The user may have opened more windows
            # in this process; neither Browser.close nor process termination is safe.
            if self._browser is not None:
                self._browser.close()
        except Exception:
            pass
        self._browser = None
        self._ctx = None
        self.page = None
        self._proc = None
        self._target_id = None
        self._endpoint = None
        lease = getattr(self, '_lease', None)
        if lease is not None:
            lease.release()
            self._lease = None
