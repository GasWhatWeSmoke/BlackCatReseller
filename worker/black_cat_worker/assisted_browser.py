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
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
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
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def _wait_for_devtools(port: int, timeout: float = 25.0) -> Optional[str]:
    """Poll Chrome's DevTools endpoint until it answers; return its ws URL base."""
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/json/version"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    json.loads(resp.read().decode("utf-8"))  # sanity
                    return f"http://127.0.0.1:{port}"
        except Exception:
            time.sleep(0.4)
    return None


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
    """An open browser session: .page to drive, .real True when it is the operator's
    Chrome, .close() to end it. Owns the Chrome process it launched."""

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

        chrome = self._executable_path or find_real_chrome()
        bounds = work_window_bounds()
        if chrome:
            port = _free_port(port_hint)
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
            ]
            try:
                startup = {}
                if bounds and os.name == 'nt':
                    info = subprocess.STARTUPINFO()
                    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    info.wShowWindow = 4  # SW_SHOWNOACTIVATE: leave the user's keyboard focus alone.
                    startup['startupinfo'] = info
                self._proc = subprocess.Popen(args, **startup)
                base = _wait_for_devtools(port)
                if not base:
                    raise RuntimeError("Chrome did not expose its DevTools endpoint in time")
                self._browser = pw.chromium.connect_over_cdp(base)
                self._ctx = self._browser.contexts[0] if self._browser.contexts else self._browser.new_context()
                cdp = self._browser.new_browser_cdp_session()
                try:
                    with self._ctx.expect_page() as created:
                        cdp.send('Target.createTarget', {'url': 'about:blank', 'newWindow': True,
                                 'background': True, 'focus': False, **bounds})
                    self.page = created.value
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
        """Block until the operator closes the window (real Chrome: its process exits)."""
        if self._proc is not None:
            try:
                self._proc.wait(timeout=timeout)
            except Exception:
                pass
            return
        # Bundled context: poll the page until it is gone.
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.page.wait_for_timeout(2000)
            except Exception:
                return

    def _terminate_proc(self) -> None:
        if self._proc is not None:
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=8)
                except Exception:
                    self._proc.kill()
                    self._proc.wait(timeout=8)
            except Exception:
                pass
            self._proc = None

    def close(self) -> None:
        try:
            if self._browser is not None and self._proc is not None:
                try:
                    if self._proc.poll() is None:
                        owned_process = self._proc
                        def stop_unresponsive_close():
                            # CDP send itself has no timeout. Only this captured
                            # Popen handle may be stopped if Chrome cannot reply.
                            try:
                                if owned_process.poll() is None:
                                    _log('[assist] Chrome close command timed out; stopping the owned process')
                                    owned_process.kill()
                            except Exception:
                                pass
                        watchdog = threading.Timer(8, stop_unresponsive_close)
                        watchdog.daemon = True
                        watchdog.start()
                        cdp = None
                        try:
                            cdp = self._browser.new_browser_cdp_session()
                            cdp.send('Browser.close')
                        except Exception:
                            # Chrome may exit before acknowledging the command.
                            pass
                        finally:
                            if cdp is not None:
                                try: cdp.detach()
                                except Exception: pass
                            watchdog.cancel()
                            watchdog.join(timeout=1)
                        self._proc.wait(timeout=8)
                    self._proc = None
                except Exception:
                    _log('[assist] Chrome did not exit normally; stopping the owned process')
            # CDP browser.close() only disconnects Playwright. Give our Chrome
            # process a normal exit first so it can flush its dedicated profile.
            self._terminate_proc()
            if self._browser is not None:
                self._browser.close()
            elif self._ctx is not None:
                self._ctx.close()
        except Exception:
            pass
        self._browser = None
        self._ctx = None
        self.page = None
        lease = getattr(self, '_lease', None)
        if lease is not None:
            lease.release()
            self._lease = None
