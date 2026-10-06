$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$SetupScript = Join-Path $PSScriptRoot "setup-local-vision-q6.ps1"
$Profile = Join-Path $ProjectRoot "config\local-vision-q6-benchmark.json"
$TempPrefix = Join-Path ([IO.Path]::GetTempPath()) "blackcat-q6-profile-test-"
$TempRoot = $TempPrefix + [Guid]::NewGuid().ToString("N")
[IO.Directory]::CreateDirectory($TempRoot) | Out-Null
$failures = 0

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = "")
  if (-not $Condition) { $script:failures += 1 }
  $mark = if ($Condition) { "ok " } else { "FAIL" }
  Write-Host "  [$mark] $Name$(if ($Detail -and -not $Condition) { " - $Detail" })"
}

function Invoke-Validation {
  param([string]$Path)
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SetupScript `
      -ProfilePath $Path -ValidateOnly 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($output -join "`n") }
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

function Write-Copy {
  param($Value, [string]$Name)
  $path = Join-Path $TempRoot $Name
  [IO.File]::WriteAllText(
    $path,
    ($Value | ConvertTo-Json -Depth 10),
    (New-Object Text.UTF8Encoding($false))
  )
  return $path
}

try {
  $valid = Invoke-Validation $Profile
  Check "checked-in Q6 profile passes strict pin validation" ($valid.Code -eq 0) $valid.Output
  $source = Get-Content -LiteralPath $Profile -Raw -Encoding UTF8 | ConvertFrom-Json

  $badRevision = $source | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $badRevision.revision = "main"
  $result = Invoke-Validation (Write-Copy $badRevision "bad-revision.json")
  Check "mutable revision is rejected" ($result.Code -ne 0) $result.Output

  $badUrl = $source | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $badUrl.weights.url = $badUrl.weights.url.Replace($source.revision, "main")
  $result = Invoke-Validation (Write-Copy $badUrl "bad-url.json")
  Check "drifted URL is rejected" ($result.Code -ne 0) $result.Output

  $badHash = $source | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $badHash.projector.sha256 = "0" * 64
  $result = Invoke-Validation (Write-Copy $badHash "bad-hash.json")
  Check "drifted hash is rejected" ($result.Code -ne 0) $result.Output

  $badSize = $source | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $badSize.weights.size = [int64]1
  $result = Invoke-Validation (Write-Copy $badSize "bad-size.json")
  Check "drifted size is rejected" ($result.Code -ne 0) $result.Output
  $profileFile = $Profile
  . $SetupScript -ProfilePath $profileFile -ValidateOnly
  Check "Q6 source default remains under .local/vision" ((Resolve-VisionAssetRoot $ProjectRoot "") -eq (Join-Path $ProjectRoot ".local\vision"))
  $relocatedRoot = Join-Path $TempRoot "persistent vision"
  . $SetupScript -ProfilePath $profileFile -AssetRoot $relocatedRoot -ValidateOnly
  Check "Q6 explicit root validates without downloads or assets" ($AssetRoot -eq $relocatedRoot -and -not (Test-Path -LiteralPath $relocatedRoot))
  $previousVisionRoot = $env:BLACKCAT_VISION_ROOT
  try {
    $env:BLACKCAT_VISION_ROOT = $relocatedRoot
    . $SetupScript -ProfilePath $profileFile -ValidateOnly
    Check "Q6 environment root matches the desktop contract" ($AssetRoot -eq $relocatedRoot)
  } finally { $env:BLACKCAT_VISION_ROOT = $previousVisionRoot }
  foreach ($invalidRoot in @("../relative", $ProjectRoot, [IO.Path]::GetPathRoot($ProjectRoot))) {
    $rejected = $false
    try { . $SetupScript -ProfilePath $profileFile -AssetRoot $invalidRoot -ValidateOnly } catch { $rejected = $true }
    Check "unsafe Q6 asset root is rejected: $invalidRoot" $rejected
  }
} finally {
  $resolved = [IO.Path]::GetFullPath($TempRoot)
  if ($resolved.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolved -PathType Container)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}

if ($failures -eq 0) {
  Write-Host "ALL Q6 PROFILE CHECKS PASSED"
  exit 0
}
Write-Host "Q6 PROFILE FAILURES: $failures"
exit 1
