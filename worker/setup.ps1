# One-time worker setup for Windows.
#
# The worker owns an exact, private CPython build. A virtual environment is
# not portable: copying the repository from another PC leaves python.exe and
# pyvenv.cfg pointing at the old machine. This script validates both the
# interpreter version and its base executable before reusing worker\.venv.
param([string]$RuntimeRoot = $env:BLACKCAT_RUNTIME_ROOT)

$ErrorActionPreference = "Stop"

$SourceWorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $SourceWorkerDir
$WorkerDir = $SourceWorkerDir
$ReceiptPath = Join-Path $ProjectRoot ".local\worker-setup.json"
if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot) -or $RuntimeRoot -match '^[A-Za-z]:[^\\/]') {
        throw "RuntimeRoot must be an absolute folder"
    }
    $RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
    $WorkerDir = Join-Path $RuntimeRoot "worker"
    $ReceiptPath = Join-Path $RuntimeRoot "worker-setup.json"
}
$RequirementsPath = Join-Path $SourceWorkerDir "requirements.txt"
$PinnedPythonVersion = "3.11.11"
$PinnedPythonSeries = "3.11"
$PortableDir = Join-Path $WorkerDir "python"
$PortablePython = Join-Path $PortableDir "python\python.exe"
$PortableUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/20241206/cpython-3.11.11+20241206-x86_64-pc-windows-msvc-install_only.tar.gz"
$PortableSize = 44667629
$PortableSha256 = "d8986f026599074ddd206f3f62d6f2c323ca8fa7a854bf744989bfc0b12f5d0d"

function Get-NormalizedPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-SamePath([string]$Left, [string]$Right) {
    $a = Get-NormalizedPath $Left
    $b = Get-NormalizedPath $Right
    if (-not $a -or -not $b) { return $false }
    return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DirectChildPath([string]$Parent, [string]$Child) {
    $parentPath = Get-NormalizedPath $Parent
    $childPath = Get-NormalizedPath $Child
    if (-not $parentPath -or -not $childPath) {
        throw "setup path validation received an empty path"
    }
    if (-not (Test-SamePath (Split-Path -Parent $childPath) $parentPath)) {
        throw "refusing to modify path outside $parentPath`: $childPath"
    }
}

function Get-PythonProbe([string]$PythonExe) {
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { return $null }
    try {
        # Keep this on one line: Windows PowerShell 5.1 can split a multiline
        # native-process argument at newlines before it reaches Python's -c.
        $code = "import json,sys; print(json.dumps({'version':'%d.%d.%d'%sys.version_info[:3],'series':'%d.%d'%sys.version_info[:2],'executable':sys.executable,'prefix':sys.prefix,'base_prefix':sys.base_prefix,'base_executable':getattr(sys,'_base_executable',sys.executable)}))"
        $raw = & $PythonExe -I -c $code 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        return ($raw | Select-Object -Last 1 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-BasePython(
    [string]$PythonExe,
    [string]$ExpectedVersion = $PinnedPythonVersion
) {
    $probe = Get-PythonProbe $PythonExe
    if (-not $probe) { return $false }
    return ($probe.version -eq $ExpectedVersion) -and
        (Test-SamePath $probe.executable $PythonExe) -and
        (Test-SamePath $probe.prefix $probe.base_prefix)
}

function Test-WorkerVenv(
    [string]$VenvPath,
    [string]$ExpectedBasePython,
    [string]$ExpectedSeries = $PinnedPythonSeries
) {
    $venvPython = Join-Path $VenvPath "Scripts\python.exe"
    $probe = Get-PythonProbe $venvPython
    if (-not $probe) { return $false }
    return ($probe.series -eq $ExpectedSeries) -and
        (Test-SamePath $probe.prefix $VenvPath) -and
        (Test-SamePath $probe.base_executable $ExpectedBasePython)
}

function Remove-SafeTree([string]$Parent, [string]$Target) {
    Assert-DirectChildPath $Parent $Target
    if (Test-Path -LiteralPath $Target) {
        Remove-Item -LiteralPath $Target -Recurse -Force -Confirm:$false
    }
}

function Invoke-Checked([string]$Exe, [string[]]$Arguments, [string]$Description) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Test-VerifiedPortableArchive(
    [string]$Path,
    [int64]$ExpectedSize = $PortableSize,
    [string]$ExpectedSha256 = $PortableSha256
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $file = Get-Item -LiteralPath $Path
    if ([int64]$file.Length -ne $ExpectedSize) { return $false }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    return $actual -eq $ExpectedSha256.ToLowerInvariant()
}

function Install-PortablePython {
    if (Test-BasePython $PortablePython $PinnedPythonVersion) {
        return $PortablePython
    }

    Write-Host "[setup] installing private CPython $PinnedPythonVersion"
    $token = [guid]::NewGuid().ToString("N")
    $stageDir = Join-Path $WorkerDir "python.setup-$token"
    $archive = Join-Path $WorkerDir "python.setup-$token.tar.gz"
    Assert-DirectChildPath $WorkerDir $stageDir
    Assert-DirectChildPath $WorkerDir $archive

    try {
        New-Item -ItemType Directory -Path $stageDir | Out-Null
        Invoke-WebRequest -Uri $PortableUrl -OutFile $archive -UseBasicParsing
        if (-not (Test-VerifiedPortableArchive $archive)) {
            throw "downloaded portable Python archive failed pinned size/SHA-256 validation"
        }
        Invoke-Checked "tar" @("-xzf", $archive, "-C", $stageDir) "portable Python extraction"

        $stagedPython = Join-Path $stageDir "python\python.exe"
        if (-not (Test-BasePython $stagedPython $PinnedPythonVersion)) {
            throw "downloaded portable Python failed the pinned $PinnedPythonVersion validation"
        }

        Remove-SafeTree $WorkerDir $PortableDir
        Move-Item -LiteralPath $stageDir -Destination $PortableDir
        if (-not (Test-BasePython $PortablePython $PinnedPythonVersion)) {
            throw "private portable Python failed validation after installation"
        }
    } finally {
        if (Test-Path -LiteralPath $stageDir) {
            Remove-SafeTree $WorkerDir $stageDir
        }
        if (Test-Path -LiteralPath $archive) {
            Remove-Item -LiteralPath $archive -Force -Confirm:$false
        }
    }

    return $PortablePython
}

function Repair-WorkerVenv(
    [string]$BasePython,
    [string]$VenvPath,
    [string]$ExpectedSeries = $PinnedPythonSeries,
    [string]$AllowedParent = $WorkerDir
) {
    Assert-DirectChildPath $AllowedParent $VenvPath
    if (Test-WorkerVenv $VenvPath $BasePython $ExpectedSeries) {
        Write-Host "[setup] existing worker venv is valid"
        return $false
    }

    Write-Host "[setup] worker venv is missing, copied, or stale; recreating it"
    $backup = Join-Path $AllowedParent (".venv.old-" + [guid]::NewGuid().ToString("N"))
    Assert-DirectChildPath $AllowedParent $backup
    $hadExisting = Test-Path -LiteralPath $VenvPath

    if ($hadExisting) {
        Move-Item -LiteralPath $VenvPath -Destination $backup
    }
    try {
        Invoke-Checked $BasePython @("-m", "venv", $VenvPath) "worker venv creation"
        if (-not (Test-WorkerVenv $VenvPath $BasePython $ExpectedSeries)) {
            throw "new worker venv failed interpreter provenance validation"
        }
    } catch {
        Remove-SafeTree $AllowedParent $VenvPath
        if ($hadExisting -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $VenvPath
        }
        throw
    }

    if (Test-Path -LiteralPath $backup) {
        Remove-SafeTree $AllowedParent $backup
    }
    return $true
}

function Get-WorkerDependencyProbe([string]$PythonExe, [int]$TimeoutSeconds = 120) {
    # Imports exercise native DLLs too. No OCR model or visible browser is created.
    # The Playwright driver only reports its installed Chromium executable path.
    $code = "import json,os,sys; os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK']='True'; import PIL.Image,numpy,cv2,paddle,paddleocr,qrcode; from pyzbar import pyzbar; from playwright.sync_api import sync_playwright; p=sync_playwright().start(); browser=p.chromium.executable_path; p.stop(); assert os.path.isfile(browser), 'Playwright Chromium is missing'; print('BLACKCAT_WORKER_READY='+json.dumps({'pythonPath':sys.executable,'pythonVersion':'.'.join(map(str,sys.version_info[:3])),'basePython':getattr(sys,'_base_executable',sys.executable),'chromiumPath':browser}))"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $PythonExe
    # Base64 avoids Windows PowerShell/native argument quoting differences.
    $start.Arguments = '-I -B -c "import base64;exec(base64.b64decode(''' + $encoded + '''))"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables["PYTHONPATH"] = ""
    $start.EnvironmentVariables["PYTHONHOME"] = ""
    $start.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8"
    $start.EnvironmentVariables["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "worker dependency verification could not start" }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $boundedSeconds = [Math]::Min(180, [Math]::Max(1, $TimeoutSeconds))
        if (-not $process.WaitForExit($boundedSeconds * 1000)) {
            # Kill only this verification process and its private Playwright driver.
            & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
            throw "worker dependency verification timed out"
        }
        if ($process.ExitCode -ne 0) {
            $detail = $errorTask.Result.Trim()
            if ($detail.Length -gt 1200) { $detail = $detail.Substring($detail.Length - 1200) }
            throw "worker dependency imports or Chromium verification failed: $detail"
        }
        $line = ($outputTask.Result -split "`r?`n" | Where-Object { $_.StartsWith("BLACKCAT_WORKER_READY=") } | Select-Object -Last 1)
        if (-not $line) { throw "worker dependency verification returned no completion receipt" }
        $probe = $line.Substring("BLACKCAT_WORKER_READY=".Length) | ConvertFrom-Json
        if (-not (Test-SamePath $probe.pythonPath $PythonExe) -or
            $probe.pythonVersion -ne $PinnedPythonVersion -or
            -not (Test-Path -LiteralPath $probe.chromiumPath -PathType Leaf)) {
            throw "worker dependency verification returned an invalid identity"
        }
        return $probe
    } finally {
        $process.Dispose()
    }
}

function Write-WorkerSetupReceipt([object]$Probe) {
    $receiptParent = Split-Path -Parent $ReceiptPath
    [System.IO.Directory]::CreateDirectory($receiptParent) | Out-Null
    $temporary = Join-Path $receiptParent ("worker-setup." + [guid]::NewGuid().ToString("N") + ".tmp")
    Assert-DirectChildPath $receiptParent $temporary
    $receipt = [ordered]@{
        version = 1
        kind = "blackcat-worker-setup"
        ready = $true
        pythonPath = $Probe.pythonPath
        pythonVersion = $Probe.pythonVersion
        basePython = $Probe.basePython
        browsersPath = $env:PLAYWRIGHT_BROWSERS_PATH
        chromiumPath = $Probe.chromiumPath
        requirementsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $RequirementsPath).Hash.ToLowerInvariant()
        verifiedAt = [DateTime]::UtcNow.ToString("o")
    }
    try {
        [System.IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $ReceiptPath) {
            [System.IO.File]::Replace($temporary, $ReceiptPath, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [System.IO.File]::Move($temporary, $ReceiptPath)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -Confirm:$false }
    }
}

function Invoke-WorkerSetup {
    # Prevent an unrelated Python environment from shadowing worker dependencies.
    $env:PYTHONPATH = ""
    $env:PYTHONHOME = ""
    # Packaged assets survive application upgrades; source defaults stay repo-local.
    $configuredBrowsers = $env:PLAYWRIGHT_BROWSERS_PATH
    if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) {
        $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $RuntimeRoot "playwright"
    } else {
        $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $ProjectRoot ".local\playwright"
    }
    if (-not [string]::IsNullOrWhiteSpace($configuredBrowsers)) {
        if (-not [System.IO.Path]::IsPathRooted($configuredBrowsers) -or $configuredBrowsers -match '^[A-Za-z]:[^\\/]') { throw "PLAYWRIGHT_BROWSERS_PATH must be an absolute folder" }
        $env:PLAYWRIGHT_BROWSERS_PATH = [System.IO.Path]::GetFullPath($configuredBrowsers)
    }
    [System.IO.Directory]::CreateDirectory($WorkerDir) | Out-Null
    # An interrupted repair must not leave an old success marker behind.
    if (Test-Path -LiteralPath $ReceiptPath) { Remove-Item -LiteralPath $ReceiptPath -Force -Confirm:$false }

    $basePython = Install-PortablePython
    $venv = Join-Path $WorkerDir ".venv"
    Repair-WorkerVenv $basePython $venv $PinnedPythonSeries $WorkerDir | Out-Null
    $python = Join-Path $venv "Scripts\python.exe"

    Write-Host "[setup] upgrading pip"
    Invoke-Checked $python @("-m", "pip", "install", "--upgrade", "pip") "pip upgrade"

    # PaddleOCR remains CPU-only so image decoding does not compete with local vision.
    Write-Host "[setup] installing paddlepaddle (CPU 3.x)"
    Invoke-Checked $python @("-m", "pip", "install", "paddlepaddle>=3.0") "paddlepaddle install"

    Write-Host "[setup] installing worker requirements"
    Invoke-Checked $python @("-m", "pip", "install", "-r", $RequirementsPath) "worker requirements install"

    Write-Host "[setup] installing Playwright Chromium"
    [System.IO.Directory]::CreateDirectory($env:PLAYWRIGHT_BROWSERS_PATH) | Out-Null
    Invoke-Checked $python @("-m", "playwright", "install", "chromium") "Playwright Chromium install"

    Write-Host "[setup] checking worker dependencies and browser files"
    $probe = Get-WorkerDependencyProbe $python
    Write-WorkerSetupReceipt $probe
    Write-Host "[setup] done. Worker python: $python"
}

# Unit tests dot-source the functions without downloading or installing anything.
if ($MyInvocation.InvocationName -ne ".") {
    Invoke-WorkerSetup
}
