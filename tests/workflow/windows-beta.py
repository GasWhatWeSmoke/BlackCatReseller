"""Plan, then explicitly run unpacked Windows acceptance against owned Temp data.

This is a packaged-runtime check on the development PC, not a clean OS or NSIS
installer test. No worker download, AI, account connection, publishing or API
probe occurs. UI requests may read the fixture through the real local app.
"""
import argparse
import ctypes
from ctypes import wintypes
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

SOURCE = Path(__file__).resolve().parent
REQUIRED = [
    "Black Cat Reseller.exe", "resources/app/package.json", "resources/app/electron/main.js",
    "resources/app/electron/startupGuard.js", "resources/app/electron/runtimePaths.js",
    "resources/app/.next/BUILD_ID", "resources/app/config/template.db",
    "resources/app/config/schema-manifest.json", "resources/app/scripts/init-db.mjs",
    "resources/app/scripts/schema-sync.mjs", "resources/app/worker/setup.ps1",
    "resources/app/public/beta-labels.html",
]
FOLDERS = ["incomingPath", "processingPath", "readyPath", "needsReviewPath", "archivePath", "exportsPath", "logsPath", "backupsPath"]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def digest(file):
    value = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def child_path(root, value):
    root, value = Path(root).resolve(), Path(value).resolve()
    if value == root or not value.is_relative_to(root):
        raise ValueError("A fixture path escaped its owned temporary directory")
    return value


def artifact_info(folder):
    folder = Path(folder).resolve(strict=True)
    if not folder.is_dir():
        raise ValueError("--artifact must name an unpacked folder, never an installer executable")
    missing = [name for name in REQUIRED if not (folder / name).is_file()]
    if missing:
        raise ValueError("Incomplete unpacked artifact: " + ", ".join(missing))
    metadata = json.loads((folder / "resources/app/package.json").read_text(encoding="utf-8-sig"))
    if metadata.get("name") != "black-cat-agent" or metadata.get("main") != "electron/main.js":
        raise ValueError("The supplied folder is not the expected Black Cat artifact")
    return {"path": str(folder), "version": metadata["version"], "buildId": (folder / "resources/app/.next/BUILD_ID").read_text().strip(),
            "criticalHashes": {name: digest(folder / name) for name in REQUIRED}}


def copy_artifact(source, destination):
    # Never follow a distribution junction into private machine files.
    pending = [Path(source)]
    while pending:
        directory = pending.pop()
        for entry in directory.iterdir():
            info = entry.lstat()
            if entry.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("Artifact contains a filesystem link/reparse point: " + str(entry.relative_to(source)))
            if entry.is_dir():
                pending.append(entry)
    shutil.copytree(source, destination)


def sandbox_status():
    windows = Path(os.environ["SystemRoot"])
    script = "Get-CimInstance Win32_OptionalFeature -Filter \"Name='Containers-DisposableClientVM'\" | Select-Object Name,InstallState | ConvertTo-Json -Compress"
    result = subprocess.run([str(windows / "System32/WindowsPowerShell/v1.0/powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, text=True, encoding="utf-8", creationflags=NO_WINDOW, timeout=15)
    feature = json.loads(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip() else None
    present = (windows / "System32/WindowsSandbox.exe").is_file()
    return {"executablePresent": present, "feature": feature, "available": bool(present and feature and feature.get("InstallState") == 1),
            "changedFeatureOrService": False}


def monitor_layout():
    user = ctypes.WinDLL("user32", use_last_error=True)
    class MonitorInfo(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("monitor", wintypes.RECT), ("work", wintypes.RECT), ("flags", wintypes.DWORD)]
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
    user.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
    user.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), callback_type, wintypes.LPARAM]
    displays = []
    def collect(handle, _dc, _rect, _data):
        info = MonitorInfo(); info.size = ctypes.sizeof(info)
        if not user.GetMonitorInfoW(handle, ctypes.byref(info)):
            return False
        displays.append({"primary": bool(info.flags & 1), "workArea": [info.work.left, info.work.top, info.work.right, info.work.bottom]})
        return True
    if not user.EnumDisplayMonitors(None, None, callback_type(collect), 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return displays


class OwnedJob:
    """Only the fixture helper and its future descendants enter this kernel job."""
    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        class Basic(ctypes.Structure):
            _fields_ = [("processTime", ctypes.c_int64), ("jobTime", ctypes.c_int64), ("flags", wintypes.DWORD),
                        ("minimumWorkingSet", ctypes.c_size_t), ("maximumWorkingSet", ctypes.c_size_t), ("activeLimit", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ["readOps", "writeOps", "otherOps", "readBytes", "writeBytes", "otherBytes"]]
        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", Io), ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                        ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t)]
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]; self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended(); limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close(); raise ctypes.WinError(ctypes.get_last_error())

    def assign(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(process._handle))):
            raise ctypes.WinError(ctypes.get_last_error())

    def pids(self):
        class ProcessList(ctypes.Structure):
            _fields_ = [("assigned", wintypes.DWORD), ("listed", wintypes.DWORD), ("ids", ctypes.c_size_t * 512)]
        values = ProcessList()
        if not self.kernel.QueryInformationJobObject(self.handle, 3, ctypes.byref(values), ctypes.sizeof(values), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return set(values.ids[:values.listed])

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle); self.handle = None


def application_environment(root, port):
    windows = Path(os.environ["SystemRoot"])
    workspace, data = root / "workspace", root / "workspace/var"
    for folder in [workspace / "home", workspace / "appdata", workspace / "localappdata", workspace / "temp"]:
        folder.mkdir(parents=True, exist_ok=True)
    return {"SystemRoot": str(windows), "WINDIR": str(windows), "ComSpec": str(windows / "System32/cmd.exe"),
            "PATH": os.pathsep.join(str(windows / suffix) for suffix in ["System32", "", "System32/Wbem", "System32/WindowsPowerShell/v1.0"]),
            "USERPROFILE": str(workspace / "home"), "APPDATA": str(workspace / "appdata"), "LOCALAPPDATA": str(workspace / "localappdata"),
            "TEMP": str(workspace / "temp"), "TMP": str(workspace / "temp"), "NEXT_TELEMETRY_DISABLED": "1", "BLACKCAT_PREVIEW": "1",
            "BLACKCAT_PREVIEW_PORT": str(port), "DATABASE_URL": "file:" + str(workspace / "data/black-cat.db"), "BLACKCAT_DATA_ROOT": str(data),
            "BLACKCAT_RUNTIME_ROOT": str(data / "runtime"), "BLACKCAT_PYTHON": str(data / "runtime/worker/.venv/Scripts/python.exe"),
            "BLACKCAT_VISION_ROOT": str(data / "runtime/vision"), "PLAYWRIGHT_BROWSERS_PATH": str(data / "runtime/playwright"),
            "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True", "PYTHONPATH": "", "PYTHONHOME": ""}


def compile_installer_guard(root):
    # Compile only a probe of the exact shipped guard. This executable has no
    # install/uninstall, registry, shortcut, or program-replacement instructions.
    repository = SOURCE.parents[1]
    cache = Path(os.environ['LOCALAPPDATA']) / 'electron-builder/Cache/nsis'
    compiler = cache / 'nsis-3.0.4.1/makensis.exe'
    plugins = cache / 'nsis-resources-3.4.1/plugins/x86-unicode'
    header = repository / 'node_modules/app-builder-lib/templates/nsis/include/nsProcess.nsh'
    guard = repository / 'assets/installer/manual-update.nsh'
    for filename in (compiler, plugins / 'nsProcess.dll', header, guard):
        if not filename.is_file():
            raise ValueError('Build the NSIS installer first; guard probe dependency is missing: ' + str(filename))
    escape = lambda value: str(value).replace('$', '$$').replace('"', '$\\"')
    executable = child_path(root, root / 'installer-guard-probe.exe')
    marker = child_path(root, root / 'installer-guard-idle.txt')
    script = child_path(root, root / 'installer-guard-probe.nsi')
    script.write_text(f'''Unicode true
SilentInstall silent
RequestExecutionLevel user
!include "LogicLib.nsh"
!addplugindir /x86-unicode "{escape(plugins)}"
!include "{escape(header)}"
!define APP_EXECUTABLE_FILENAME "Black Cat Reseller.exe"
!include "{escape(guard)}"
OutFile "{escape(executable)}"
Section
  !insertmacro customCheckAppRunning
  FileOpen $0 "{escape(marker)}" w
  FileWrite $0 "idle"
  FileClose $0
SectionEnd
''', encoding='utf-8')
    compiled = subprocess.run([str(compiler), '/V2', str(script)], capture_output=True, text=True,
                              encoding='utf-8', errors='replace', creationflags=NO_WINDOW, timeout=30)
    (root / 'installer-guard-compile.log').write_text(compiled.stdout + compiled.stderr, encoding='utf-8')
    if compiled.returncode != 0 or not executable.is_file():
        raise RuntimeError('Installer guard did not compile; inspect its fixture log')
    return {'executable': str(executable), 'marker': str(marker), 'sourceSha256': digest(guard)}


def run_phase(root, nonce, phase, artifact, environment, driver, package, timeout, item_count, installer_guard=None):
    output = child_path(root, root / phase); output.mkdir()
    config = {"fixtureRoot": str(root), "nonce": nonce, "phase": phase, "executable": str(artifact / "Black Cat Reseller.exe"),
              "version": artifact_info(artifact)["version"], "output": str(output), "playwrightPackage": str(package), "environment": environment,
              "origin": "http://127.0.0.1:" + environment["BLACKCAT_PREVIEW_PORT"], "itemCount": item_count,
              "installerGuard": installer_guard}
    config_path = output / "config.json"; config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    authorization = root / "launch-authorized.json"
    authorization.unlink(missing_ok=True)
    job, process, watching = OwnedJob(), None, threading.Event()
    violations = []
    try:
        with (output / "helper.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([str(driver), str(SOURCE / "windows-beta.cjs"), str(config_path)], cwd=SOURCE,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", creationflags=NO_WINDOW)
            try:
                job.assign(process)
            except Exception:
                process.terminate(); process.wait(timeout=10); raise
            def stream_output():
                for line in process.stdout:
                    log.write(line); log.flush()
                    if line.startswith('{"phase":'):
                        print(line.rstrip(), flush=True)
            reader = threading.Thread(target=stream_output, daemon=True); reader.start()
            user = ctypes.WinDLL("user32", use_last_error=True)
            user.GetForegroundWindow.restype = wintypes.HWND
            user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
            def watch_focus():
                while not watching.wait(0.05):
                    try:
                        foreground = user.GetForegroundWindow(); pid = wintypes.DWORD()
                        user.GetWindowThreadProcessId(foreground, ctypes.byref(pid))
                        if pid.value in job.pids():
                            violations.append({"reason": "owned-window-became-foreground", "pid": pid.value})
                            (root / "abort.json").write_text(json.dumps({"nonce": nonce, "reason": violations[-1]["reason"]}), encoding="utf-8")
                            return
                    except Exception as error:
                        violations.append({"reason": "foreground-guard-failed", "error": str(error)})
                        (root / "abort.json").write_text(json.dumps({"nonce": nonce, "reason": "foreground-guard-failed"}), encoding="utf-8")
                        return
            watcher = threading.Thread(target=watch_focus, daemon=True); watcher.start()
            authorization.write_text(json.dumps({"nonce": nonce}), encoding="utf-8")
            process.wait(timeout=timeout)
            reader.join(timeout=5)
            watching.set(); watcher.join(timeout=2)
            deadline = time.monotonic() + 10
            while job.pids() and time.monotonic() < deadline:
                time.sleep(0.05)
            remaining = sorted(job.pids())
            result_file = output / "result.json"
            result = json.loads(result_file.read_text(encoding="utf-8")) if result_file.is_file() else {"error": "Fixture exited without a result"}
            result["foregroundViolations"] = violations; result["remainingOwnedPids"] = remaining; result["helperExitCode"] = process.returncode
            (output / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            if process.returncode != 0 or violations or remaining or not result.get("normalShutdown") or result.get("error"):
                raise RuntimeError("Packaged acceptance failed in " + phase + "; inspect " + str(output / "result.json"))
            return result
    finally:
        watching.set()
        # This kernel handle contains only this fixture's helper and descendants.
        # No PID-based termination, personal Chrome process or global app is touched.
        job.close()
        if process is not None and process.poll() is None:
            process.wait(timeout=10)


def snapshot(database):
    with closing(sqlite3.connect(Path(database).as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA query_only=ON")
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        result = {}
        for table in tables:
            rows = connection.execute('SELECT * FROM "' + table.replace('"', '""') + '"').fetchall()
            encoded = sorted(json.dumps(row, sort_keys=True, default=str) for row in rows)
            result[table] = {"rows": len(rows), "sha256": hashlib.sha256(json.dumps(encoded).encode()).hexdigest()}
        settings_row = connection.execute("SELECT data FROM AppSettings WHERE id=1").fetchone()
        return result, json.loads(settings_row[0])


def seed_inventory(root, database, settings):
    # Only called after normal shutdown, against the owner's freshly created DB.
    from PIL import Image
    child_path(root, database)
    now = int(time.time() * 1000)
    photos = {}
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute("PRAGMA foreign_keys=ON")
        assert connection.execute("SELECT count(*) FROM Item").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM MarketplaceListing").fetchone()[0] == 0
        for index in range(1, 11):
            sku = str(900000 + index)
            photo = child_path(root, Path(settings["processingPath"]) / sku / "fixture.jpg")
            photo.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (300, 400), (40 + index * 10, 95, 145)).save(photo, format="JPEG")
            sha = digest(photo); photos[str(photo)] = sha
            item = connection.execute("INSERT INTO Item (sku,status,brand,size,itemType,color,condition,listedPrice,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
                                      (sku, "Photographed", "Windows beta fixture", "M", "T-Shirt", "Blue", "Good", 20 + index, now)).lastrowid
            connection.execute("INSERT INTO Photo (itemId,originalFilename,storedPath,thumbPath,sha256,sortOrder,isCover,width,height) VALUES (?,?,?,?,?,?,?,?,?)",
                               (item, "fixture.jpg", str(photo), str(photo), sha, 0, 1, 300, 400))
    return photos


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True, type=Path, help="Complete win-unpacked folder; never an NSIS executable")
    parser.add_argument("--updated-artifact", type=Path, help="Optional next build. Omit to test relocation of the same build")
    parser.add_argument("--check-installer-guard", action="store_true", help="Compile/run the shipped NSIS activity guard without installing or changing the registry")
    parser.add_argument("--run", action="store_true", help="Explicitly launch the reviewed isolated fixture; default only prints its plan")
    parser.add_argument("--timeout-seconds", type=int, default=360, choices=range(60, 601), metavar="60..600")
    args = parser.parse_args()
    if os.name != "nt":
        raise RuntimeError("This fixture requires Windows and the private development Playwright installation")
    from playwright._impl._driver import compute_driver_executable
    driver, cli = compute_driver_executable(); package = Path(cli).parent
    initial = artifact_info(args.artifact); updated = artifact_info(args.updated_artifact or args.artifact)
    plan = {"initialArtifact": initial, "secondArtifact": updated, "sandbox": sandbox_status(), "monitors": monitor_layout(),
            "driverNode": str(driver), "runRequested": args.run, "installerTest": False, "cleanOsTest": False,
            "updateKind": "separate-artifact" if args.updated_artifact else "same-build-relocation", "usesBusinessData": False,
            "installerGuardRequested": args.check_installer_guard,
            "phases": ["fresh unpacked EXE, tutorial and ten practice reviews", "offline synthetic fixture seed after app quits", "same-build restart", "second copied artifact path with identical fixture data"],
            "processSafety": "owned Windows Job Object; normal app.quit first; only its descendants can be terminated on failure",
            "networkSafety": "preview mode, empty accounts, no worker download or AI; renderer allows only owned local GET/HEAD requests"}
    print(json.dumps(plan, indent=2), flush=True)
    if not args.run:
        return
    if not any(not display["primary"] for display in plan["monitors"]):
        raise RuntimeError("A second monitor is required. No application was launched.")
    root = Path(tempfile.mkdtemp(prefix="blackcat-windows-beta-")); nonce = str(uuid.uuid4())
    (root / "fixture-owner.json").write_text(json.dumps({"kind": "blackcat-windows-beta", "nonce": nonce}), encoding="utf-8")
    proof = {"plan": plan, "fixture": str(root), "phases": [], "completed": False, "syntheticInventory": True, "workerInstallationTest": False}
    print(json.dumps({"artifacts": str(root)}), flush=True)
    try:
        installer_guard = compile_installer_guard(root) if args.check_installer_guard else None
        first, second = child_path(root, root / "app-v1"), child_path(root, root / "app-v2")
        copy_artifact(Path(initial["path"]), first)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0)); port = reservation.getsockname()[1]
        if not 49152 <= port <= 65535:
            raise RuntimeError("The selected isolated port is outside the permitted preview range")
        environment = application_environment(root, port)
        database = root / "workspace/data/black-cat.db"
        proof["phases"].append(run_phase(root, nonce, "fresh", first, environment, driver, package, args.timeout_seconds, 0, installer_guard))
        fresh, settings = snapshot(database)
        assert all(value["rows"] == 0 for name, value in fresh.items() if name not in ["AppSettings", "Vocabulary", "_prisma_migrations"]), "Practice must not create business records"
        assert fresh["AppSettings"]["rows"] == 1
        for key in FOLDERS:
            assert child_path(root, settings[key]).is_dir(), "First-run managed folder is missing: " + key
        assert Path(settings["pythonWorkerPath"]).resolve() == Path(environment["BLACKCAT_PYTHON"]).resolve()
        assert not Path(settings["pythonWorkerPath"]).exists(), "This run must test the missing-worker path without a developer Python fallback"
        proof["freshDatabase"] = fresh
        photos = seed_inventory(root, database, settings)
        runtime_marker = child_path(root, root / "workspace/var/runtime/fixture-owned.txt")
        runtime_marker.parent.mkdir(parents=True, exist_ok=True); runtime_marker.write_text(nonce, encoding="utf-8")
        baseline, _ = snapshot(database)
        for phase, artifact in [("restart", first), ("relocated", second)]:
            if phase == "relocated":
                copy_artifact(Path(updated["path"]), second)
            proof["phases"].append(run_phase(root, nonce, phase, artifact, environment, driver, package, args.timeout_seconds, 10, installer_guard))
            current, persisted = snapshot(database)
            assert current == baseline, "A business table changed across " + phase
            assert persisted == settings, "Saved paths/preferences changed across " + phase
            assert runtime_marker.read_text(encoding="utf-8") == nonce
            assert all(digest(file) == sha for file, sha in photos.items()), "A fixture original photo changed"
        assert artifact_info(first)["criticalHashes"] == initial["criticalHashes"], "Runtime rewrote a critical packaged file"
        assert artifact_info(second)["criticalHashes"] == updated["criticalHashes"], "Runtime rewrote a critical updated file"
        if installer_guard:
            idle = subprocess.run([installer_guard['executable'], '/S'], capture_output=True,
                                  creationflags=NO_WINDOW, timeout=15)
            assert idle.returncode == 0, 'The installer guard did not allow an idle app'
            assert Path(installer_guard['marker']).read_text() == 'idle'
            proof['installerGuard'] = {**installer_guard, 'blockedActiveAppWithoutStoppingIt': True, 'idleAllowed': True,
                                       'registryChanged': False, 'installerExecuted': False}
        proof.update({"completed": True, "preservedBusinessTables": len(baseline), "preservedItems": 10, "preservedPhotos": len(photos),
                      "practiceCreatedInventory": False, "systemNodePythonPathRequired": False, "installerTest": False, "cleanOsTest": False})
    except Exception as error:
        proof["error"] = str(error)
        raise
    finally:
        (root / "proof.json").write_text(json.dumps(proof, indent=2), encoding="utf-8")
        print(json.dumps({"proof": str(root / "proof.json"), "completed": proof["completed"]}), flush=True)


if __name__ == "__main__":
    main()
