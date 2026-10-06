"""Serialize browser owners across the app and local maintenance workers."""
import errno
import os
from pathlib import Path
import time


def browser_lease_path(profile_dir=None):
    root = Path(os.environ.get('BLACKCAT_DATA_ROOT', ''))
    if root.is_absolute() and root.is_dir():
        # Owned windows occupy the same work screen. Serialize even different
        # profiles so one crawler cannot hide another crawler's active tab.
        return root / '.blackcat-browser.lock'
    return Path(profile_dir) / '.blackcat-browser.lock' if profile_dir is not None else None


class BrowserLease:
    def __init__(self, path, timeout=180):
        self.path = Path(path)
        self.timeout = timeout
        self._file = None

    def acquire(self):
        if self._file is not None:
            raise RuntimeError('This browser lease is already held')
        handle = self.path.open('a+b')
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b'\0')
            handle.flush()
        deadline = time.monotonic() + self.timeout
        waiting = False
        try:
            while True:
                handle.seek(0)
                try:
                    if os.name == 'nt':
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._file = handle
                    return self
                except OSError as error:
                    if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                        raise
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Another Black Cat task is still using this browser') from None
                    if not waiting:
                        print('[browser] waiting for another Black Cat task to finish', flush=True)
                        waiting = True
                    time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        except BaseException:
            handle.close()
            raise

    def release(self):
        if self._file is not None:
            # The OS releases the lock on close, including after process death.
            self._file.close()
            self._file = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_):
        self.release()
