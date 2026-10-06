"""Discover or start the app's persistent Chrome helper without reconnect loops."""
import contextlib
import errno
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler


@contextlib.contextmanager
def _startup_lock(path):
    # Keep the inode: unlinking a locked file lets a second caller lock a different
    # file at the same path. Closing (including process death) releases ownership.
    handle = open(path, "a+b", buffering=0)
    try:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            raise RuntimeError("The Chrome session is already starting") from None
        yield
    finally:
        handle.close()


def _starting_owner(path):
    if not path.exists():
        return None
    try:
        if path.stat().st_size > 1024:
            raise ValueError()
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("version") != 1 or type(value.get("ownerPid")) is not int or value["ownerPid"] <= 0:
            raise ValueError()
        return value["ownerPid"]
    except (ValueError, AttributeError):
        raise RuntimeError("The Chrome startup record could not be verified; keep it for recovery") from None


def _record_start(path, owner):
    # Persist intent BEFORE spawning. A dead caller may leave a live child that
    # has not written its receipt yet; a later caller must never blindly relaunch.
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "ownerPid": owner}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_receipt(path):
    if path.stat().st_size > 4096:
        raise RuntimeError("Invalid Chrome session receipt")
    receipt = json.loads(path.read_text(encoding="utf-8"))
    endpoint = urlsplit(receipt.get("endpoint", ""))
    if receipt.get("version") != 1 or endpoint.scheme != "ws" or endpoint.hostname != "127.0.0.1" or not endpoint.port or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise RuntimeError("Invalid Chrome session receipt")
    return receipt


def _check(receipt, owner, capability=None):
    endpoint = receipt["endpoint"].replace("ws://", "http://", 1) + "/status"
    deadline = time.monotonic() + 30
    while True:
        try:
            with build_opener(ProxyHandler({})).open(endpoint, timeout=2) as response:
                status = json.loads(response.read(4096))
        except Exception:
            # An HTTP observation timeout is not evidence that Chrome ended.
            # Poll this same helper; never replace it or create a new approval.
            if time.monotonic() >= deadline:
                raise RuntimeError("Could not verify the existing Chrome session; try again when it responds") from None
            time.sleep(0.1)
            continue
        if status.get("pid") != receipt["pid"] or status.get("ownerPid") != owner or status.get("failed"):
            raise RuntimeError("Chrome session ended; use Connect Chrome in Settings or restart Black Cat")
        if status.get("paused"):
            raise RuntimeError("Chrome is disconnected; use Connect Chrome in Settings")
        if capability and capability not in status.get("capabilities", []):
            raise RuntimeError("The running Chrome helper needs the updated app version")
        if not status.get("busy"):
            return receipt["endpoint"]
        if time.monotonic() >= deadline:
            if status.get("cleanupSlow"):
                raise RuntimeError("Chrome is still releasing the previous item; wait for it to finish")
            raise RuntimeError("The Chrome crawler is busy with another item")
        time.sleep(0.1)


def session_endpoint(capability=None):
    import playwright as installed_playwright

    owner = int(os.environ.get("BLACKCAT_CHROME_OWNER_PID", "0"))
    root = Path(os.environ.get("BLACKCAT_DATA_ROOT", ""))
    if owner <= 0 or not root.is_absolute() or not root.is_dir():
        raise RuntimeError("Start the Chrome crawler from the running Black Cat app")
    receipt_path = root / "native-chrome-session.json"
    if receipt_path.exists():
        receipt = _read_receipt(receipt_path)
        if receipt.get("ownerPid") == owner:
            return _check(receipt, owner, capability)
    with _startup_lock(root / "native-chrome-session-start.lock"):
        if receipt_path.exists():
            receipt = _read_receipt(receipt_path)
            if receipt.get("ownerPid") == owner:
                return _check(receipt, owner, capability)
        attempt_path = root / "native-chrome-session-start.json"
        if _starting_owner(attempt_path) == owner:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if receipt_path.exists():
                    receipt = _read_receipt(receipt_path)
                    if receipt.get("ownerPid") == owner:
                        return _check(receipt, owner, capability)
                time.sleep(0.1)
            raise RuntimeError("Chrome startup is not confirmed; retry to wait for the same helper, or restart Black Cat")
        driver = Path(installed_playwright.__file__).parent / "driver"
        node = driver / ("node.exe" if os.name == "nt" else "node")
        flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS if os.name == "nt" else 0
        _record_start(attempt_path, owner)
        try:
            child = subprocess.Popen([str(node), str(Path(__file__).with_name("chrome_bridge.cjs")), str(receipt_path), str(owner)],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     creationflags=flags, start_new_session=os.name != "nt")
        except OSError:
            # Popen did not create a child; a later attempt may safely start one.
            attempt_path.unlink(missing_ok=True)
            raise
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if receipt_path.exists():
                receipt = _read_receipt(receipt_path)
                if receipt.get("ownerPid") == owner and receipt.get("pid") == child.pid:
                    return _check(receipt, owner, capability)
            if child.poll() is not None:
                attempt_path.unlink(missing_ok=True)
                break
            time.sleep(0.1)
        raise RuntimeError("Could not start the persistent Chrome session")


if __name__ == '__main__':
    # Desktop bootstrap only: discovery does not attach to Chrome or open pages.
    try:
        session_endpoint()
    except Exception:
        raise SystemExit(1)
