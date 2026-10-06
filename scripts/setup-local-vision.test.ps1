$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$SetupScript = Join-Path $PSScriptRoot "setup-local-vision.ps1"
$Manifest = Join-Path $ProjectRoot "config\local-vision.json"
$TempPrefix = Join-Path ([IO.Path]::GetTempPath()) "blackcat-local-vision-setup-test-"
$TempRoot = $TempPrefix + [Guid]::NewGuid().ToString("N")
[IO.Directory]::CreateDirectory($TempRoot) | Out-Null

$failures = 0
function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = "")
  if (-not $Condition) { $script:failures += 1 }
  $mark = if ($Condition) { "ok " } else { "FAIL" }
  $suffix = if (-not $Condition -and $Detail) { " - $Detail" } else { "" }
  Write-Host "  [$mark] $Name$suffix"
}

function Invoke-Validation {
  param([string]$Path)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SetupScript `
      -ConfigPath $Path -ValidateOnly 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Code = $code; Output = ($output -join "`n") }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Write-ManifestCopy {
  param($Value, [string]$Name)
  $path = Join-Path $TempRoot $Name
  $json = $Value | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
  return $path
}

try {
  Write-Host "== pinned manifest validation =="
  $valid = Invoke-Validation $Manifest
  Check "checked-in manifest passes strict pin validation" ($valid.Code -eq 0) $valid.Output

  $source = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json

  $badHash = $source | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $badHash.model.weights.sha256 = "0" * 64
  $badHashResult = Invoke-Validation (Write-ManifestCopy $badHash "bad-hash.json")
  Check "tampered model hash is rejected" ($badHashResult.Code -ne 0) $badHashResult.Output

  $badRevision = $source | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $badRevision.model.revision = "main"
  $badRevisionResult = Invoke-Validation (Write-ManifestCopy $badRevision "bad-revision.json")
  Check "mutable model revision is rejected" ($badRevisionResult.Code -ne 0) $badRevisionResult.Output

  $badBind = $source | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $badBind.server.host = "0.0.0.0"
  $badBindResult = Invoke-Validation (Write-ManifestCopy $badBind "bad-bind.json")
  Check "non-loopback bind is rejected" ($badBindResult.Code -ne 0) $badBindResult.Output

  $badArgs = $source | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $badArgs.server.arguments[3] = "4096"
  $badArgsResult = Invoke-Validation (Write-ManifestCopy $badArgs "bad-args.json")
  Check "unapproved runtime arguments are rejected" ($badArgsResult.Code -ne 0) $badArgsResult.Output

  $badRestart = $source | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $badRestart.server.maxRestarts = 2
  $badRestartResult = Invoke-Validation (Write-ManifestCopy $badRestart "bad-restart.json")
  Check "restart cap above one is rejected" ($badRestartResult.Code -ne 0) $badRestartResult.Output

  Write-Host "== copied-install receipt validation =="
  . $SetupScript -ConfigPath $Manifest -ValidateOnly
  $defaultRoot = Join-Path $ProjectRoot ".local\vision"
  Check "source vision default stays local" ((Resolve-VisionAssetRoot $ProjectRoot "") -eq $defaultRoot)
  $relocatedRoot = Join-Path $TempRoot "persistent vision"
  . $SetupScript -ConfigPath $Manifest -AssetRoot $relocatedRoot -ValidateOnly
  Check "explicit asset root survives validation without writing assets" ($AssetRoot -eq $relocatedRoot -and -not (Test-Path -LiteralPath $relocatedRoot))
  $previousVisionRoot = $env:BLACKCAT_VISION_ROOT
  try {
    $env:BLACKCAT_VISION_ROOT = $relocatedRoot
    . $SetupScript -ConfigPath $Manifest -ValidateOnly
    Check "environment asset root matches the desktop contract" ($AssetRoot -eq $relocatedRoot)
  } finally { $env:BLACKCAT_VISION_ROOT = $previousVisionRoot }
  foreach ($invalidRoot in @("../relative", $ProjectRoot, [IO.Path]::GetPathRoot($ProjectRoot))) {
    $rejected = $false
    try { . $SetupScript -ConfigPath $Manifest -AssetRoot $invalidRoot -ValidateOnly } catch { $rejected = $true }
    Check "unsafe vision asset root is rejected: $invalidRoot" $rejected
  }
  $receiptRoot = Join-Path $TempRoot "assets"
  $runtimeDir = Join-Path $receiptRoot "runtime\test"
  [IO.Directory]::CreateDirectory($runtimeDir) | Out-Null
  $fakeExecutable = Join-Path $runtimeDir "llama-server.exe"
  [IO.File]::WriteAllBytes($fakeExecutable, [byte[]](1, 2, 3, 4))
  $nestedDir = Join-Path $runtimeDir "backend\cuda"
  [IO.Directory]::CreateDirectory($nestedDir) | Out-Null
  $fakeDependency = Join-Path $nestedDir "backend.dll"
  [IO.File]::WriteAllBytes($fakeDependency, [byte[]](5, 6, 7, 8))
  $fakeApiKey = Join-Path $receiptRoot "api-key.txt"
  [IO.File]::WriteAllText($fakeApiKey, ("a" * 64) + "`n", (New-Object Text.UTF8Encoding($false)))
  $fakeReceipt = Join-Path $receiptRoot "setup-receipt.json"
  $receiptValue = [ordered]@{
    schemaVersion = 1; kind = "blackcat-local-vision-setup"; configSha256 = "config"
    assetRoot = $receiptRoot
    runtime = [ordered]@{
      id = "runtime"; executable = "runtime/test/llama-server.exe"
      executableSha256 = Get-Sha256 $fakeExecutable
      files = @(Get-RuntimeFileInventory $runtimeDir)
    }
    model = [ordered]@{
      id = "model"; weights = "models/test/model.gguf"; projector = "models/test/mmproj.gguf"
    }
    server = [ordered]@{
      apiKeyFile = "api-key.txt"; apiKeySha256 = Get-Sha256 $fakeApiKey
    }
  }
  Write-JsonAtomically $receiptValue $fakeReceipt $receiptRoot
  Check "setup receipt never stores the plaintext API key" (
    -not [IO.File]::ReadAllText($fakeReceipt).Contains("a" * 64)
  )
  $receiptArgs = @{
    ReceiptPath = $fakeReceipt; ConfigSha256 = "config"; ExpectedAssetRoot = $receiptRoot
    ExecutablePath = $fakeExecutable; RuntimeId = "runtime"; ModelId = "model"
    ExpectedRuntimeExecutable = "runtime/test/llama-server.exe"
    ExpectedWeights = "models/test/model.gguf"; ExpectedProjector = "models/test/mmproj.gguf"
    ApiKeyPath = $fakeApiKey; ExpectedApiKeyFile = "api-key.txt"
  }
  Check "current-root receipt is accepted" (Test-CurrentSetupReceipt @receiptArgs)
  $unchangedKey = [IO.File]::ReadAllText($fakeApiKey)
  $null = Test-CurrentSetupReceipt @receiptArgs
  Check "valid receipt validation preserves the API key" ([IO.File]::ReadAllText($fakeApiKey) -ceq $unchangedKey)
  $receiptValue.assetRoot = Join-Path $TempRoot "copied-from-other-machine"
  Write-JsonAtomically $receiptValue $fakeReceipt $receiptRoot
  Check "copied absolute asset root is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  $receiptValue.assetRoot = $receiptRoot
  $receiptValue.model.weights = "models/old/model.gguf"
  Write-JsonAtomically $receiptValue $fakeReceipt $receiptRoot
  Check "stale relative artifact path is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  $receiptValue.model.weights = "models/test/model.gguf"
  Write-JsonAtomically $receiptValue $fakeReceipt $receiptRoot
  $heldDependency = Join-Path $receiptRoot "held-backend.dll"
  Move-Item -LiteralPath $fakeDependency -Destination $heldDependency
  Check "missing inventoried runtime dependency is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  Move-Item -LiteralPath $heldDependency -Destination $fakeDependency
  $extraRuntimeFile = Join-Path $runtimeDir "unreceipted.dll"
  [IO.File]::WriteAllBytes($extraRuntimeFile, [byte[]](9, 9, 9))
  Check "extra unreceipted runtime file is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  Remove-Item -LiteralPath $extraRuntimeFile -Force
  $originalReceiptName = [string]$receiptValue.runtime.files[0].name
  $receiptValue.runtime.files[0].name = "../escaped.dll"
  Write-JsonAtomically $receiptValue $fakeReceipt $receiptRoot
  Check "runtime receipt path escape is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  $receiptValue.runtime.files[0].name = $originalReceiptName
  Write-JsonAtomically $receiptValue $fakeReceipt $receiptRoot
  [IO.File]::WriteAllBytes($fakeDependency, [byte[]](8, 7, 6, 5))
  Check "corrupt extracted runtime dependency is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  [IO.File]::WriteAllBytes($fakeDependency, [byte[]](5, 6, 7, 8))
  [IO.File]::WriteAllText($fakeApiKey, ("b" * 64) + "`n", (New-Object Text.UTF8Encoding($false)))
  Check "changed API key is rejected" (-not (Test-CurrentSetupReceipt @receiptArgs))
  $beforeRotation = [IO.File]::ReadAllText($fakeApiKey)
  New-LocalApiKeyFile $fakeApiKey $receiptRoot
  Check "API key rotation creates a new exact local credential" (
    (Test-LocalApiKeyFile $fakeApiKey) -and [IO.File]::ReadAllText($fakeApiKey) -cne $beforeRotation
  )

  Write-Host "== verified downloader behavior =="
  $downloadRoot = Join-Path $TempRoot "downloads"
  [IO.Directory]::CreateDirectory($downloadRoot) | Out-Null
  $goodBytes = [byte[]](10, 20, 30, 40)
  $goodPath = Join-Path $downloadRoot "fixture.bin"
  [IO.File]::WriteAllBytes($goodPath, $goodBytes)
  $artifact = [pscustomobject]@{
    name = "fixture.bin"; url = "https://127.0.0.1:1/must-not-run"
    size = [int64]$goodBytes.Length; sha256 = Get-Sha256 $goodPath
  }
  $partialPath = Join-Path $downloadRoot "partial.bin"
  [IO.File]::WriteAllBytes($partialPath, [byte[]](10, 20))
  Check "partial artifact is rejected" (-not (Test-VerifiedFile $artifact $partialPath))
  [IO.File]::WriteAllBytes($partialPath, [byte[]](40, 30, 20, 10))
  Check "same-size hash mismatch is rejected" (-not (Test-VerifiedFile $artifact $partialPath))

  $script:downloadCalled = $false
  $script:downloadMode = "fail"
  function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
    $script:downloadCalled = $true
    if ($script:downloadMode -eq "fail") { throw "network must not be used" }
    [IO.File]::WriteAllBytes($OutFile, [byte[]](9, 9, 9, 9))
  }
  Install-VerifiedArtifact $artifact $goodPath $downloadRoot
  Check "valid offline rerun skips network" (-not $script:downloadCalled)

  $script:downloadMode = "bad"
  $script:downloadCalled = $false
  $before = [IO.File]::ReadAllBytes($goodPath)
  $badArtifact = [pscustomobject]@{
    name = "other.bin"; url = "https://fixture.invalid/other.bin"
    size = [int64]$goodBytes.Length; sha256 = $artifact.sha256
  }
  $badDestination = Join-Path $downloadRoot "other.bin"
  [IO.File]::WriteAllBytes($badDestination, $before)
  $badArtifact.sha256 = "0" * 64
  $caught = $false
  try { Install-VerifiedArtifact $badArtifact $badDestination $downloadRoot } catch { $caught = $true }
  Check "hash-failed download is rejected" ($caught -and $script:downloadCalled)
  Check "hash failure preserves prior destination" (
    ([Convert]::ToBase64String([IO.File]::ReadAllBytes($badDestination))) -eq
    ([Convert]::ToBase64String($before))
  )
  Check "hash failure cleans partial files" (
    @(Get-ChildItem -LiteralPath $downloadRoot -Filter "*.part" -File).Count -eq 0
  )
} finally {
  $resolved = [IO.Path]::GetFullPath($TempRoot)
  if ($resolved.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolved -PathType Container)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}

Write-Host ""
if ($failures -eq 0) {
  Write-Host "ALL LOCAL VISION SETUP CHECKS PASSED"
  exit 0
}
Write-Host "LOCAL VISION SETUP FAILURES: $failures"
exit 1
