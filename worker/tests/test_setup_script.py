import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
SETUP = REPO / "worker" / "setup.ps1"
POWERSHELL = shutil.which("powershell.exe") or shutil.which("powershell")
BASE_PYTHON = Path(getattr(sys, "_base_executable", sys.executable))


def ps_literal(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(POWERSHELL, "Windows PowerShell is required")
class WorkerSetupScriptTests(unittest.TestCase):
    def run_powershell(self, body: str, runtime_root: Path | None = None) -> subprocess.CompletedProcess[str]:
        arguments = "" if runtime_root is None else f" -RuntimeRoot {ps_literal(runtime_root)}"
        library = (
            "$ErrorActionPreference='Stop'; "
            f". {ps_literal(SETUP)}{arguments}; "
        )
        return subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                library + body,
            ],
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )

    def test_setup_pins_exact_repo_local_python(self):
        source = SETUP.read_text(encoding="utf-8")
        self.assertIn('$PinnedPythonVersion = "3.11.11"', source)
        self.assertIn('$PinnedPythonSeries = "3.11"', source)
        self.assertIn('$PortableDir = Join-Path $WorkerDir "python"', source)
        self.assertIn('$PortableSize = 44667629', source)
        self.assertIn(
            '$PortableSha256 = "d8986f026599074ddd206f3f62d6f2c323ca8fa7a854bf744989bfc0b12f5d0d"',
            source,
        )
        self.assertLess(
            source.index("Test-VerifiedPortableArchive $archive"),
            source.index('Invoke-Checked "tar"'),
        )
        self.assertNotIn('foreach ($candidate', source)

    def test_portable_archive_verifier_rejects_wrong_size_and_hash(self):
        with tempfile.TemporaryDirectory() as raw:
            fixture = Path(raw) / "archive.tar.gz"
            fixture.write_bytes(b"verified fixture")
            import hashlib

            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            result = self.run_powershell(
                f"$ok=Test-VerifiedPortableArchive {ps_literal(fixture)} "
                f"{fixture.stat().st_size} '{digest}'; "
                f"$badSize=Test-VerifiedPortableArchive {ps_literal(fixture)} "
                f"{fixture.stat().st_size + 1} '{digest}'; "
                f"$badHash=Test-VerifiedPortableArchive {ps_literal(fixture)} "
                f"{fixture.stat().st_size} '{'0' * 64}'; "
                "if(-not $ok -or $badSize -or $badHash){throw 'verification contract failed'}; "
                "Write-Output 'verified'"
            )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("verified", result.stdout)

    def test_playwright_browser_cache_is_repo_local(self):
        source = SETUP.read_text(encoding="utf-8")
        self.assertIn(
            '$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $ProjectRoot ".local\\playwright"',
            source,
        )
        self.assertIn(
            'Directory]::CreateDirectory($env:PLAYWRIGHT_BROWSERS_PATH)',
            source,
        )

    def test_explicit_runtime_keeps_assets_outside_the_source_and_uses_shipped_requirements(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-paths-") as raw:
            runtime = Path(raw) / "user profile" / "runtime"
            result = self.run_powershell(
                "@{worker=$WorkerDir; portable=$PortablePython; receipt=$ReceiptPath; "
                "requirements=$RequirementsPath; source=$SourceWorkerDir} | ConvertTo-Json -Compress",
                runtime,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            paths = json.loads(result.stdout)
            self.assertEqual(runtime / "worker", Path(paths["worker"]))
            self.assertEqual(runtime / "worker" / "python" / "python" / "python.exe", Path(paths["portable"]))
            self.assertEqual(runtime / "worker-setup.json", Path(paths["receipt"]))
            self.assertEqual(REPO / "worker" / "requirements.txt", Path(paths["requirements"]))
            self.assertFalse(runtime.exists(), "Resolving setup paths must not create directories")

    def test_runtime_environment_override_and_relative_path_rejection(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-env-") as raw:
            runtime = Path(raw) / "runtime"
            body = (
                f"$env:BLACKCAT_RUNTIME_ROOT={ps_literal(runtime)}; "
                f". {ps_literal(SETUP)}; "
                f"if(-not (Test-SamePath $WorkerDir {ps_literal(runtime / 'worker')})){{throw 'override ignored'}}; "
                "$caught=$false; try { "
                f". {ps_literal(SETUP)} -RuntimeRoot '../relative' "
                "} catch { $caught=$true }; if(-not $caught){throw 'relative runtime was accepted'}; Write-Output 'checked'"
            )
            result = self.run_powershell(body)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("checked", result.stdout)

    def test_success_receipt_is_written_after_verification_with_current_source_digest(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-receipt-") as raw:
            runtime = Path(raw) / "runtime"
            result = self.run_powershell(
                "$env:PLAYWRIGHT_BROWSERS_PATH=''; "
                "function Install-PortablePython { return $PortablePython }; "
                "function Repair-WorkerVenv { return $false }; "
                "function Invoke-Checked { param($Exe,$Arguments,$Description); "
                "if(Test-Path -LiteralPath $ReceiptPath){throw 'premature success receipt'} }; "
                "function Get-WorkerDependencyProbe { param($PythonExe); "
                "if(Test-Path -LiteralPath $ReceiptPath){throw 'success before imports'}; "
                "return @{pythonPath=$PythonExe; pythonVersion=$PinnedPythonVersion; basePython=$PortablePython; "
                "chromiumPath=(Join-Path $env:PLAYWRIGHT_BROWSERS_PATH 'chromium\\chrome.exe')} }; "
                "Invoke-WorkerSetup; Write-Output 'completed'",
                runtime,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            receipt = json.loads((runtime / "worker-setup.json").read_text(encoding="utf-8"))
            self.assertTrue(receipt["ready"])
            self.assertEqual("blackcat-worker-setup", receipt["kind"])
            self.assertEqual(runtime / "worker" / ".venv" / "Scripts" / "python.exe", Path(receipt["pythonPath"]))
            self.assertEqual(runtime / "playwright", Path(receipt["browsersPath"]))
            import hashlib

            self.assertEqual(hashlib.sha256((REPO / "worker" / "requirements.txt").read_bytes()).hexdigest(), receipt["requirementsSha256"])
            self.assertEqual([], list(runtime.glob("*.tmp")))

    def test_failed_dependency_check_removes_previous_success_and_writes_no_receipt(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-failure-") as raw:
            runtime = Path(raw) / "runtime"
            runtime.mkdir()
            (runtime / "worker-setup.json").write_text('{"ready":true}', encoding="utf-8")
            result = self.run_powershell(
                "$env:PLAYWRIGHT_BROWSERS_PATH=''; "
                "function Install-PortablePython { return $PortablePython }; "
                "function Repair-WorkerVenv { return $false }; "
                "function Invoke-Checked {}; "
                "function Get-WorkerDependencyProbe { throw 'simulated missing native DLL' }; "
                "$caught=$false; try { Invoke-WorkerSetup } catch { $caught=$true }; "
                "if(-not $caught -or (Test-Path -LiteralPath $ReceiptPath)){throw 'failed setup claimed ready'}; "
                "Write-Output 'failed safely'",
                runtime,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("failed safely", result.stdout)
            self.assertFalse((runtime / "worker-setup.json").exists())
            self.assertEqual([], list(runtime.glob("*.tmp")))

    def test_receipt_can_be_replaced_atomically(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-atomic-") as raw:
            runtime = Path(raw) / "runtime"
            result = self.run_powershell(
                "$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $RuntimeRoot 'playwright'; "
                "$probe=@{pythonPath='first'; pythonVersion='3.11.11'; basePython='base'; chromiumPath='browser'}; "
                "Write-WorkerSetupReceipt $probe; $probe.pythonPath='replacement'; Write-WorkerSetupReceipt $probe",
                runtime,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            receipt = json.loads((runtime / "worker-setup.json").read_text(encoding="utf-8"))
            self.assertEqual("replacement", receipt["pythonPath"])
            self.assertEqual([], list(runtime.glob("*.tmp")))

    def test_dependency_probe_rejects_an_interpreter_without_required_imports(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-imports-") as raw:
            venv_path = Path(raw) / ".venv"
            subprocess.run(
                [sys.executable, "-m", "venv", "--without-pip", str(venv_path)],
                check=True, capture_output=True, text=True, timeout=60,
            )
            result = self.run_powershell(
                "$caught=$false; try { "
                f"Get-WorkerDependencyProbe {ps_literal(venv_path / 'Scripts' / 'python.exe')} 10 "
                "} catch { $caught=$true }; if(-not $caught){throw 'missing imports were accepted'}; Write-Output 'rejected'"
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("rejected", result.stdout)

    def test_dependency_probe_reads_a_successful_child_receipt_and_stops_on_timeout(self):
        with tempfile.TemporaryDirectory(prefix="blackcat-runtime-probe-") as raw:
            root = Path(raw)
            venv_path = root / ".venv"
            subprocess.run(
                [sys.executable, "-m", "venv", "--without-pip", str(venv_path)],
                check=True, capture_output=True, text=True, timeout=60,
            )
            packages = venv_path / "Lib" / "site-packages"
            for name in ("PIL", "pyzbar", "playwright"):
                (packages / name).mkdir()
                (packages / name / "__init__.py").write_text("", encoding="utf-8")
            for name in ("PIL/Image", "pyzbar/pyzbar", "numpy", "cv2", "paddle", "paddleocr", "qrcode"):
                (packages / (name + ".py")).write_text("", encoding="utf-8")
            browser = root / "chromium" / "chrome.exe"
            browser.parent.mkdir()
            browser.write_bytes(b"inert browser fixture")
            (packages / "playwright" / "sync_api.py").write_text(
                "from types import SimpleNamespace\n"
                f"def sync_playwright():\n    return SimpleNamespace(start=lambda: SimpleNamespace(chromium=SimpleNamespace(executable_path={str(browser)!r}), stop=lambda: None))\n",
                encoding="utf-8",
            )
            python = venv_path / "Scripts" / "python.exe"
            version = ".".join(map(str, sys.version_info[:3]))
            result = self.run_powershell(
                f"$PinnedPythonVersion={ps_literal(version)}; "
                f"$probe=Get-WorkerDependencyProbe {ps_literal(python)} 10; "
                f"if(-not (Test-SamePath $probe.chromiumPath {ps_literal(browser)})){{throw 'browser mismatch'}}; "
                "Write-Output 'verified imports'"
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("verified imports", result.stdout)
            (packages / "cv2.py").write_text("import time\ntime.sleep(10)\n", encoding="utf-8")
            result = self.run_powershell(
                f"$PinnedPythonVersion={ps_literal(version)}; $caught=$false; "
                f"try {{ Get-WorkerDependencyProbe {ps_literal(python)} 1 }} "
                "catch { if($_.Exception.Message -notmatch 'timed out'){throw}; $caught=$true }; "
                "if(-not $caught){throw 'timeout was not enforced'}; Write-Output 'timed out safely'"
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("timed out safely", result.stdout)

    def test_venv_validation_rejects_a_foreign_base_interpreter(self):
        with tempfile.TemporaryDirectory() as raw:
            venv_path = Path(raw) / ".venv"
            subprocess.run(
                [sys.executable, "-m", "venv", "--without-pip", str(venv_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            series = f"{sys.version_info.major}.{sys.version_info.minor}"
            result = self.run_powershell(
                f"$valid = Test-WorkerVenv {ps_literal(venv_path)} "
                f"{ps_literal(Path(raw) / 'foreign' / 'python.exe')} {ps_literal(series)}; "
                "if ($valid) { throw 'foreign base was accepted' }; Write-Output 'rejected'"
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("rejected", result.stdout)

    def test_repair_replaces_a_copied_broken_venv(self):
        with tempfile.TemporaryDirectory() as raw:
            parent = Path(raw)
            venv_path = parent / ".venv"
            scripts = venv_path / "Scripts"
            scripts.mkdir(parents=True)
            (venv_path / "pyvenv.cfg").write_text(
                "home = C:\\Users\\OtherComputer\\Python311\nversion = 3.11.15\n",
                encoding="utf-8",
            )
            (scripts / "python.exe").write_text("copied launcher", encoding="utf-8")
            series = f"{sys.version_info.major}.{sys.version_info.minor}"

            result = self.run_powershell(
                f"$changed = Repair-WorkerVenv {ps_literal(BASE_PYTHON)} "
                f"{ps_literal(venv_path)} {ps_literal(series)} {ps_literal(parent)}; "
                f"$valid = Test-WorkerVenv {ps_literal(venv_path)} "
                f"{ps_literal(BASE_PYTHON)} {ps_literal(series)}; "
                "if (-not $changed -or -not $valid) { throw 'repair validation failed' }; "
                "Write-Output 'repaired'"
            )

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("repaired", result.stdout)
            self.assertEqual([], list(parent.glob(".venv.old-*")))
            probe = subprocess.run(
                [str(venv_path / "Scripts" / "python.exe"), "--version"],
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(0, probe.returncode, probe.stderr)
            self.assertIn(series, probe.stdout)

    def test_failed_recreation_restores_the_existing_directory(self):
        with tempfile.TemporaryDirectory() as raw:
            parent = Path(raw)
            venv_path = parent / ".venv"
            venv_path.mkdir()
            marker = venv_path / "keep-me.txt"
            marker.write_text("original", encoding="utf-8")
            missing_python = parent / "missing-python.exe"

            result = self.run_powershell(
                "$caught=$false; try { "
                f"Repair-WorkerVenv {ps_literal(missing_python)} {ps_literal(venv_path)} "
                f"'3.11' {ps_literal(parent)} | Out-Null "
                "} catch { $caught=$true }; "
                "if (-not $caught) { throw 'expected creation failure' }; "
                "Write-Output 'restored'"
            )

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("restored", result.stdout)
            self.assertEqual("original", marker.read_text(encoding="utf-8"))
            self.assertEqual([], list(parent.glob(".venv.old-*")))


if __name__ == "__main__":
    unittest.main()
